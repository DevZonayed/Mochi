// File-based, append-only message store (spec §4). One messages.jsonl per chat;
// order is reconstructed at READ time by sorting on ts (live/backfill/import
// are all pure appends — the append-only contract is never violated by mid-file
// insertion). cursor.json holds the per-chat newest/oldest watermark + count.
// HARD efficiency caps (§4.3) are enforced server-side in getSlice, independent
// of caller input.

import fs from "node:fs";
import path from "node:path";
import {
  commsChatDir,
  commsMessagesPath,
  commsCursorPath,
  commsMetaPath,
  commsDir,
  estimateTokens,
} from "./paths.js";
import { fingerprint } from "./comms_dedupe.js";
import { normalizeJid } from "./comms_allowlist.js";

const CURSOR_DEFAULT = { newestId: null, newestTs: 0, oldestId: null, oldestTs: 0, count: 0 };

function atomicWrite(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// readCursor: cursor.json or a zeroed default. Never throws.
export function readCursor(projectDir, provider, accountId, chatId) {
  const f = commsCursorPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(f)) return { ...CURSOR_DEFAULT };
  try {
    const v = JSON.parse(fs.readFileSync(f, "utf8"));
    return (v && typeof v === "object" && !Array.isArray(v))
      ? { ...CURSOR_DEFAULT, ...v }
      : { ...CURSOR_DEFAULT };
  }
  catch { return { ...CURSOR_DEFAULT }; }
}

// writeCursor: atomic cursor.json write.
export function writeCursor(projectDir, provider, accountId, chatId, cursor) {
  const f = commsCursorPath(projectDir, provider, accountId, chatId);
  atomicWrite(f, JSON.stringify(cursor, null, 2) + "\n");
  return f;
}

// internal: read all message records for a chat (append-only jsonl).
function readAllMessages(projectDir, provider, accountId, chatId) {
  const f = commsMessagesPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// exported so later tasks (append/getSlice) and tests can share it.
export { readAllMessages, atomicWrite, commsChatDir };

// appendMessage: append-only insert with TWO-TIER dedupe (spec §4.2) and cursor
// maintenance. Idempotent on (provider,accountId,chatId,msgId) [tier 1] and on
// fingerprint [tier 2]; on a tier-2 fingerprint collision, a live/backfill
// record WINS over an import dup (the import is dropped). Returns
// { appended:boolean, reason? }.
//
// Tier-2 scope: only live-vs-import (and reverse). live-vs-backfill is NOT a
// Tier-2 dedup case — both live and backfill records carry real provider msgIds,
// so if they have different msgIds they are genuinely distinct messages.
// True same-message overlap (e.g. a backfill history-set that re-delivers a
// message already stored via live) is already caught by Tier-1 (same msgId).
export function appendMessage(projectDir, msg) {
  const { provider, accountId, chatId } = msg;
  const fp = msg.fingerprint || fingerprint(msg);
  const existing = readAllMessages(projectDir, provider, accountId, chatId);

  // Tier 1: within-source identity by msgId.
  for (const e of existing) {
    if (e.msgId === msg.msgId) {
      return { appended: false, reason: "duplicate-msgid" };
    }
  }
  // Tier 2: CROSS-SOURCE identity by fingerprint. live/backfill wins over import.
  // Only fires for live-or-backfill vs. import cross-source collisions:
  //   forward path : real record (live/backfill) stored first, import dup arrives -> drop import.
  //   reverse path : import stored first, real (live/backfill) arrives later -> supersede import.
  //
  // live-vs-backfill with distinct msgIds: both are real provider records and
  // represent genuinely distinct messages (cleared Tier-1). Must NOT be suppressed.
  // Same-source fingerprint collisions (live-vs-live, backfill-vs-backfill,
  // import-vs-import) with distinct msgIds are also genuinely distinct — do NOT suppress.
  const incomingIsReal = msg.source === "live" || msg.source === "backfill";
  const incomingIsImport = msg.source === "import";

  // Helper: supersede exactly ONE import record with the incoming real record (greedy 1:1).
  // Replaces the first matched import record `e` in `existing`, appends the new record,
  // rewrites the file atomically, and updates the cursor.
  function supersedeImport(e) {
    const record = { ...msg, fingerprint: fp };
    let superseded = false;
    const withoutImport = existing.filter((r) => {
      if (!superseded && r === e) { superseded = true; return false; }
      return true;
    });
    const allReplaced = withoutImport.concat([record]);
    const file = commsMessagesPath(projectDir, provider, accountId, chatId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, allReplaced.map((r) => JSON.stringify(r)).join("\n") + "\n");
    let newest2 = allReplaced[0], oldest2 = allReplaced[0];
    for (const r of allReplaced) {
      if ((r.ts || 0) >= (newest2.ts || 0)) newest2 = r;
      if ((r.ts || 0) <= (oldest2.ts || 0)) oldest2 = r;
    }
    writeCursor(projectDir, provider, accountId, chatId, {
      newestId: newest2.msgId, newestTs: newest2.ts || 0,
      oldestId: oldest2.msgId, oldestTs: oldest2.ts || 0,
      count: allReplaced.length,
    });
    return { appended: true };
  }

  for (const e of existing) {
    if (e.fingerprint === fp) {
      const existingIsReal = e.source === "live" || e.source === "backfill";
      const existingIsImport = e.source === "import";

      if (existingIsReal && incomingIsImport) {
        // Forward live-wins: real record stored first, import dup arrives -> drop import.
        return { appended: false, reason: "duplicate-fingerprint-live-wins" };
      }
      if (existingIsImport && incomingIsReal) {
        // Reverse live-wins: import stored first, real (live/backfill) arrives later.
        // Per spec §4.2 live/backfill wins unconditionally. Supersede exactly ONE
        // import record (greedy 1:1 per §4.2): any additional same-fp import records
        // that coexist (e.g. intra-minute duplicates minted by reconcileImport with
        // distinct ordinal msgIds) are left intact so no real message is silently lost.
        return supersedeImport(e);
      }
      // Same-source fingerprint collision (live-vs-live, backfill-vs-backfill,
      // import-vs-import) or live-vs-backfill with distinct msgIds: genuinely distinct
      // messages (e.g. user sent 'ok' twice in the same minute, or live + backfill
      // delivered the same content with different provider msgIds). Do NOT suppress.
      // Continue scanning; if no import match found, fall through to append.
    }
  }

  const record = { ...msg, fingerprint: fp };
  const file = commsMessagesPath(projectDir, provider, accountId, chatId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");

  // Update cursor from the full set (cheap; allowlist keeps volume bounded).
  const all = existing.concat([record]);
  let newest = all[0], oldest = all[0];
  for (const r of all) {
    if ((r.ts || 0) >= (newest.ts || 0)) newest = r;
    if ((r.ts || 0) <= (oldest.ts || 0)) oldest = r;
  }
  writeCursor(projectDir, provider, accountId, chatId, {
    newestId: newest.msgId, newestTs: newest.ts || 0,
    oldestId: oldest.msgId, oldestTs: oldest.ts || 0,
    count: all.length,
  });

  return { appended: true };
}

const DEFAULT_LIMIT = 20;
const HARD_MAX_LIMIT = 200;     // §4.3 — over-limit requests are CLAMPED, not honored
const DEFAULT_BYTE_BUDGET = 16 * 1024; // ~16 KB per response (§4.3)
const DEFAULT_ANCHOR_SIDE = 10; // §4.3 — anchored `before`/`after` default per side

// _applyBudget: drain `all` (already in final emit order) into a bounded output
// respecting the limit clamp + byte budget, emitting a `continuation` cursor when
// truncated. Shared by every getSlice path so caps are a single invariant.
function _applyBudget(all, limitApplied, byteBudget) {
  const out = [];
  let bytes = 0;
  let continuation = null;
  for (const m of all) {
    if (out.length >= limitApplied) {
      continuation = `${out[out.length - 1].ts}:${out[out.length - 1].msgId}`;
      break;
    }
    const sz = estimateTokens(JSON.stringify(m)) * 4; // estimateTokens ≈ chars/4; *4 → bytes
    if (out.length > 0 && bytes + sz > byteBudget) {
      continuation = `${out[out.length - 1].ts}:${out[out.length - 1].msgId}`;
      break;
    }
    out.push(m);
    bytes += sz;
  }
  return { out, continuation };
}

// getSlice: latest-N or windowed read of a chat. Order is reconstructed at READ
// time by ts. Three modes (caps are server-side invariants in ALL of them —
// limit clamps to 200, byte budget truncates with a `continuation` cursor):
//
//   1. ANCHORED (opts.anchor = a msgId): the recall-expand path (§4.3, C5). After
//      the ts-DESC sort, locate the anchor and return up to `before` (default 10)
//      OLDER + the anchor + up to `after` (default 10) NEWER messages, emitted in
//      ts ASC order (oldest→newest, a readable timeline). Per-side counts and the
//      total are clamped to HARD_MAX. Anchor not found → empty result (no throw).
//   2. TS-BOUND (no anchor, but `before`/`after` given as epoch-second bounds):
//      filter to `ts <= before` and/or `ts >= after`, then latest-N within bounds.
//   3. LATEST-N (default): newest-first, limit defaults to 20.
//
// `continuation` is an opaque "before this ts/msgId" cursor (we encode ts:msgId)
// for the paging modes; the anchored window is bounded by design and does not page.
export function getSlice(projectDir, opts) {
  const { provider, accountId, chatId } = opts;
  const limitApplied = Math.min(
    HARD_MAX_LIMIT,
    Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT
  );
  const byteBudget = Number.isFinite(opts.byteBudget) && opts.byteBudget > 0
    ? opts.byteBudget : DEFAULT_BYTE_BUDGET;

  let all = readAllMessages(projectDir, provider, accountId, chatId);
  // newest-first by ts; msgId is a stable tiebreaker for equal ts.
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(b.msgId).localeCompare(String(a.msgId)));

  // ---- Mode 1: anchored window around a msgId -------------------------------
  if (opts.anchor != null && opts.anchor !== "") {
    const idx = all.findIndex((m) => String(m.msgId) === String(opts.anchor));
    if (idx < 0) return { messages: [], limitApplied, continuation: null };

    // `all` is newest-first, so NEWER messages sit at LOWER indices and OLDER at
    // HIGHER indices. Clamp each side count to HARD_MAX (and the total via slice).
    const beforeN = Math.min(
      HARD_MAX_LIMIT,
      Number.isFinite(opts.before) && opts.before >= 0 ? Math.floor(opts.before) : DEFAULT_ANCHOR_SIDE
    );
    const afterN = Math.min(
      HARD_MAX_LIMIT,
      Number.isFinite(opts.after) && opts.after >= 0 ? Math.floor(opts.after) : DEFAULT_ANCHOR_SIDE
    );
    const newerStart = Math.max(0, idx - afterN);      // up to afterN newer (toward index 0)
    const olderEnd = idx + 1 + beforeN;                // up to beforeN older (toward the tail)
    const window = all.slice(newerStart, olderEnd);    // still newest-first
    window.reverse();                                  // → ts ASC (oldest → newest) timeline

    // Apply HARD_MAX + byte budget across the assembled window.
    const { out } = _applyBudget(window, HARD_MAX_LIMIT, byteBudget);
    return { messages: out, limitApplied, continuation: null };
  }

  // ---- Mode 2: ts-bound filtering (no anchor) -------------------------------
  // `before`/`after` are epoch-second bounds here: ts <= before, ts >= after.
  if (Number.isFinite(opts.before)) {
    all = all.filter((m) => (m.ts || 0) <= opts.before);
  }
  if (Number.isFinite(opts.after)) {
    all = all.filter((m) => (m.ts || 0) >= opts.after);
  }

  // continuation: resume strictly older than the encoded cursor.
  if (typeof opts.continuation === "string" && opts.continuation.includes(":")) {
    const sep = opts.continuation.indexOf(":");
    const curTs = Number(opts.continuation.slice(0, sep));
    const curId = opts.continuation.slice(sep + 1);
    all = all.filter((m) =>
      (m.ts || 0) < curTs || ((m.ts || 0) === curTs && String(m.msgId).localeCompare(curId) < 0)
    );
  }

  // ---- Mode 3: latest-N (default) -------------------------------------------
  const { out, continuation } = _applyBudget(all, limitApplied, byteBudget);
  return { messages: out, limitApplied, continuation };
}

function readMetaSafe(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

// listChats: enumerate stored chats across all providers/accounts under
// store/, returning ONLY those whose chatId is in allowedJids (read-side
// structural guarantee, §6.4). Each entry merges meta.json (name, chatKind)
// and cursor.json (count, newest/oldest watermarks). A null/empty allowlist
// returns nothing — strict by default.
export function listChats(projectDir, allowedJids) {
  if (!Array.isArray(allowedJids) || allowedJids.length === 0) return [];
  const allowed = new Set(allowedJids.map(normalizeJid));

  const storeRoot = path.join(commsDir(projectDir), "store");
  if (!fs.existsSync(storeRoot)) return [];

  const out = [];
  for (const provider of fs.readdirSync(storeRoot)) {
    const provDir = path.join(storeRoot, provider);
    if (!fs.statSync(provDir).isDirectory()) continue;
    for (const accountId of fs.readdirSync(provDir)) {
      const acctDir = path.join(provDir, accountId);
      if (!fs.statSync(acctDir).isDirectory()) continue;
      for (const chatId of fs.readdirSync(acctDir)) {
        const chatDir = path.join(acctDir, chatId);
        if (!fs.statSync(chatDir).isDirectory()) continue;
        if (!allowed.has(normalizeJid(chatId))) continue; // structural filter
        const meta = readMetaSafe(commsMetaPath(projectDir, provider, accountId, chatId));
        const cursor = readCursor(projectDir, provider, accountId, chatId);
        out.push({
          provider, accountId, chatId,
          name: meta.name ?? null,
          chatKind: meta.chatKind ?? null,
          count: cursor.count,
          newestTs: cursor.newestTs,
          oldestTs: cursor.oldestTs,
        });
      }
    }
  }
  out.sort((a, b) => (b.newestTs || 0) - (a.newestTs || 0));
  return out;
}

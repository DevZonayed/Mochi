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
  estimateTokens,
} from "./paths.js";
import { fingerprint } from "./comms_dedupe.js";

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
  // Tier 2: CROSS-SOURCE identity by fingerprint. live/backfill win over import.
  // Only fires when the incoming message and the existing record have different
  // sources (one is live/backfill, the other is import). Same-source collisions
  // (live-vs-live, import-vs-import) that cleared Tier 1 represent distinct
  // real messages (different msgIds, same content/minute) and must NOT be
  // suppressed — silent loss of a real user message.
  const incomingIsReal = msg.source === "live" || msg.source === "backfill";
  const incomingIsImport = msg.source === "import";
  for (const e of existing) {
    if (e.fingerprint === fp) {
      const existingIsReal = e.source === "live" || e.source === "backfill";
      const existingIsImport = e.source === "import";

      if (existingIsReal && incomingIsImport) {
        // Forward live-wins: live/backfill stored first, import dup arrives -> drop import.
        return { appended: false, reason: "duplicate-fingerprint-live-wins" };
      }
      if (existingIsImport && incomingIsReal) {
        // Reverse live-wins: import stored first, live/backfill arrives later
        // (re-delivery overlap). Per spec §4.2 live wins unconditionally.
        // Supersede exactly ONE import record (greedy 1:1 per §4.2): replace
        // the first matched import with the live record. Any additional same-fp
        // import records that coexist (e.g. intra-minute duplicates minted by
        // reconcileImport with distinct ordinal msgIds) are left intact so no
        // real message is silently lost. Using the index of `e` as found in
        // this iteration avoids over-broad removal.
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
      // Same-source fingerprint collision (both live or both import) with a
      // distinct msgId that cleared Tier 1: these are genuinely distinct messages
      // (e.g. user sent 'ok' twice in the same minute). Do NOT suppress.
      // Continue scanning for a different match; if none found, append.
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

// getSlice: latest-N (or windowed) read of a chat. Order is reconstructed at
// READ time by ts DESC (newest-first) by default. Caps are server-side
// invariants: limit defaults to 20, is HARD-clamped to 200, and the response
// is truncated to a byte budget with a `continuation` cursor for the next page.
// `continuation` is an opaque "before this ts/msgId" cursor (we encode ts:msgId).
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

  // continuation: resume strictly older than the encoded cursor.
  if (typeof opts.continuation === "string" && opts.continuation.includes(":")) {
    const sep = opts.continuation.indexOf(":");
    const curTs = Number(opts.continuation.slice(0, sep));
    const curId = opts.continuation.slice(sep + 1);
    all = all.filter((m) =>
      (m.ts || 0) < curTs || ((m.ts || 0) === curTs && String(m.msgId).localeCompare(curId) < 0)
    );
  }

  const out = [];
  let bytes = 0;
  let continuation = null;
  for (const m of all) {
    if (out.length >= limitApplied) {
      continuation = `${out[out.length - 1].ts}:${out[out.length - 1].msgId}`;
      break;
    }
    const sz = estimateTokens(JSON.stringify(m)); // estimated tokens
    if (out.length > 0 && bytes + sz > byteBudget) {
      continuation = `${out[out.length - 1].ts}:${out[out.length - 1].msgId}`;
      break;
    }
    out.push(m);
    bytes += sz;
  }

  return { messages: out, limitApplied, continuation };
}

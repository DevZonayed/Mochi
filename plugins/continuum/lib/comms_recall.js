// comms_recall.js — stemmed-token search over per-chat messages.jsonl shards.
//
// Reuses the shared scoring primitives (lib/scoring.js) so comms recall scores
// identically to continuum recall. Read-side allowlist-strict (§6.4): only
// chats present in config.allowed_jids are ever scanned. Output honors §10
// (each hit: chatId, tsIso, senderName, excerpt, msgId) and §4.3 caps
// (default limit 10, HARD max 200 clamp). Returns a slice, never the store.

import fs from "node:fs";
import {
  commsMessagesPath,
} from "./paths.js";
import { readConfig } from "./comms_config.js";
import { isAllowed, normalizeJid } from "./comms_allowlist.js";
import { tokenizeStemmed, termFrequency } from "./scoring.js";

// §4.3 efficiency invariants — enforced server-side, not caller-overridable.
const DEFAULT_LIMIT = 10;
const HARD_MAX_LIMIT = 200;
const EXCERPT_MAX = 200; // chars — keep snippets compact (req-5)

// A short, single-line excerpt for the snippet contract (§10).
function excerptOf(text) {
  if (!text) return "";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > EXCERPT_MAX ? oneLine.slice(0, EXCERPT_MAX - 1) + "…" : oneLine;
}

// Walk config -> every (provider, accountId, chatId) that is allowlisted.
// Filtered further by the caller's provider/accountId/chatId if supplied.
// Jids are normalized (strips device suffix, lowercases) so that shard paths
// and chatId comparisons agree with the normalizeJid logic used by listChats
// and isAllowed — preventing silent under-retrieval for device-suffix jids.
function allowedChats(cfg, { provider, accountId, chatId }) {
  const out = [];
  const normalizedChatId = chatId ? normalizeJid(chatId) : null;
  const providers = (cfg && cfg.providers) || {};
  for (const [prov, pv] of Object.entries(providers)) {
    if (provider && prov !== provider) continue;
    const accounts = (pv && pv.accounts) || {};
    for (const [acc, av] of Object.entries(accounts)) {
      if (accountId && acc !== accountId) continue;
      const jids = Array.isArray(av && av.allowed_jids) ? av.allowed_jids : [];
      for (const jid of jids) {
        const normJid = normalizeJid(jid);
        if (!normJid) continue;
        if (normalizedChatId && normJid !== normalizedChatId) continue;
        // Defense in depth: confirm via the shared allowlist decision.
        if (!isAllowed(cfg, prov, acc, jid)) continue;
        out.push({ provider: prov, accountId: acc, chatId: normJid });
      }
    }
  }
  return out;
}

// Read + parse one chat's messages.jsonl (best-effort; tolerate bad lines).
function readShard(projectDir, provider, accountId, chatId) {
  const file = commsMessagesPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const msgs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { msgs.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return msgs;
}

export function commsRecall(projectDir, opts = {}) {
  if (!projectDir) throw new Error("commsRecall: projectDir required");
  const { query, provider, accountId, chatId, since, until } = opts;
  if (!query || !String(query).trim()) throw new Error("commsRecall: query required");

  // Clamp the limit per §4.3 (clamped, not honored, when over-max).
  let limit = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > HARD_MAX_LIMIT) limit = HARD_MAX_LIMIT;

  const queryStems = tokenizeStemmed(query);

  const cfg = readConfig(projectDir);
  const targets = allowedChats(cfg, { provider, accountId, chatId });

  const scored = [];
  let totalScanned = 0;

  for (const t of targets) {
    const msgs = readShard(projectDir, t.provider, t.accountId, t.chatId);
    for (const m of msgs) {
      // Window filter on epoch-second ts (authoritative for ordering).
      if (since != null && Number(m.ts) < Number(since)) continue;
      if (until != null && Number(m.ts) > Number(until)) continue;
      totalScanned++;

      const docStems = tokenizeStemmed(m.text || "");
      if (docStems.length === 0) continue;
      const tf = termFrequency(docStems, queryStems);
      let score = 0;
      const matched = [];
      for (const qt of queryStems) {
        const count = tf.get(qt) || 0;
        if (count > 0) { score += Math.log(1 + count); matched.push(qt); }
      }
      if (score === 0) continue;

      scored.push({
        provider: t.provider,
        accountId: t.accountId,
        chatId: m.chatId ?? t.chatId,
        msgId: m.msgId,
        tsIso: m.tsIso || null,
        ts: Number(m.ts) || 0,
        senderName: m.senderName || m.senderId || "",
        excerpt: excerptOf(m.text),
        score,
        matchedKeywords: matched,
      });
    }
  }

  // Sort: score desc, then recency (newer ts first) — "mostly latest" (req-5).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.ts - a.ts;
  });

  return {
    query,
    queryStems,
    limit,
    totalScanned,
    hitCount: scored.length,
    hits: scored.slice(0, limit),
  };
}

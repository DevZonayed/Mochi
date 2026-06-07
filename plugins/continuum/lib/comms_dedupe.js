// Two-tier dedupe primitives (spec §4.2). Tier 1 (within-source identity by
// (provider,accountId,chatId,msgId)) is enforced in comms_store. This module
// owns the cross-source identity: a CANONICAL, SYMMETRIC fingerprint so a live
// record and an imported record of the same content+minute+sender collide —
// and the greedy 1:1 reconciliation that resolves intra-minute collisions
// without silent loss.

import crypto from "node:crypto";
import { normalizeJid } from "./comms_allowlist.js";

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// fingerprint = "fp:" + sha1( chatId | floor(ts/60) | normalizedSenderId |
//   sha1(text || media.mediaKey || "") ). NO ordinal, NO msgId, NO source —
// so it is identical across live/backfill/import (symmetric by construction).
export function fingerprint(msg) {
  const minute = Math.floor((Number(msg.ts) || 0) / 60);
  const sender = normalizeJid(msg.senderId || "");
  const content = (msg.text && msg.text.length)
    ? msg.text
    : (msg.media && msg.media.mediaKey ? msg.media.mediaKey : "");
  const body = sha1(content);
  return "fp:" + sha1(`${msg.chatId || ""}|${minute}|${sender}|${body}`);
}

// reconcileImport(existing, imports) -> { merged, added }.
// Greedy, time-ordered 1:1 matching per (chatId, minute, normalizedSenderId,
// text) bucket (spec §4.2). Within a bucket each existing live/backfill record
// is consumed at most once; import lines beyond the existing count (N>M) become
// NEW records. The ordinal-within-minute (position among same-minute import
// lines in this bucket) is folded into the synthetic msgId ONLY — never into
// fp — so new same-minute import records stay unique among themselves. live/
// backfill win over import on any 1:1 match.
export function reconcileImport(existingMsgs, importMsgs) {
  const existing = Array.isArray(existingMsgs) ? existingMsgs : [];
  const imports = Array.isArray(importMsgs) ? importMsgs : [];

  const bucketKey = (msg) => {
    const minute = Math.floor((Number(msg.ts) || 0) / 60);
    const sender = normalizeJid(msg.senderId || "");
    const content = (msg.text && msg.text.length)
      ? msg.text
      : (msg.media && msg.media.mediaKey ? msg.media.mediaKey : "");
    return `${msg.chatId || ""}|${minute}|${sender}|${content}`;
  };

  // Count existing capacity per bucket (records the import can match against).
  const capacity = new Map();
  for (const e of existing) {
    const k = bucketKey(e);
    capacity.set(k, (capacity.get(k) || 0) + 1);
  }

  // Walk imports in export-line order (input order is the ordinal source).
  const seenInBucket = new Map(); // bucket -> ordinal counter (0-based)
  const added = [];
  for (const raw of imports) {
    const k = bucketKey(raw);
    const ordinal = seenInBucket.get(k) || 0;
    seenInBucket.set(k, ordinal + 1);

    const cap = capacity.get(k) || 0;
    if (ordinal < cap) continue; // matched a live/backfill record — live wins

    // Unmatched (N>M): mint a NEW import record. Ordinal lives in msgId only.
    const sender = normalizeJid(raw.senderId || "");
    const msgId = "import:" + sha1(`${raw.chatId || ""}|${raw.ts}|${ordinal}|${sender}|${raw.text || ""}`);
    const rec = { ...raw, msgId, source: "import" };
    added.push(rec);
  }

  return { merged: existing.concat(added), added };
}

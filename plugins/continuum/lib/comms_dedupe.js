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

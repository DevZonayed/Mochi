// Channel-strict access decisions (spec §6.4). Two structural guarantees:
//   - Capture side: a message whose normalized chatId isn't allowlisted is
//     dropped BEFORE write (the store never persists non-allowlisted chats).
//   - Read side: list/get/recall only ever return allowlisted chats.
// normalizeJid canonicalizes a JID so one identity isn't stored/checked twice.
// In v1 the @lid <-> phone-JID mapping is a STUB (real mapping is provider-side
// via jidNormalizedUser, Phase 2): @lid is only lowercased/trimmed here.

// Strip a WhatsApp device/agent suffix (":NN") from the user part, lowercase
// the domain, trim. "19999999999:12@s.whatsapp.net" -> "19999999999@s.whatsapp.net".
export function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  let s = jid.trim().toLowerCase();
  if (!s) return "";
  const at = s.indexOf("@");
  if (at === -1) return s;
  let user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const colon = user.indexOf(":");
  if (colon !== -1) user = user.slice(0, colon);
  return `${user}@${domain}`;
}

function accountAllowed(cfg, provider, accountId) {
  const acct = cfg?.providers?.[provider]?.accounts?.[accountId];
  if (!acct || !Array.isArray(acct.allowed_jids)) return new Set();
  // filter(Boolean) drops entries that normalize to "" so a blank/whitespace
  // entry in allowed_jids cannot grant access to null/empty/garbage chatIds.
  return new Set(acct.allowed_jids.map(normalizeJid).filter(Boolean));
}

// isAllowed: strict membership of the normalized jid in this account's
// allowed_jids. Allowing a @g.us grants ONLY that group chat (its chatId);
// a member's 1:1 DM still needs that member's own JID listed (§6.4 m5).
export function isAllowed(cfg, provider, accountId, jid) {
  const norm = normalizeJid(jid);
  // An empty normalized jid can never be allowlisted — reject early so that a
  // null/garbage chatId on the write path never slips past this guard.
  if (!norm) return false;
  const allowed = accountAllowed(cfg, provider, accountId);
  if (allowed.size === 0) return false;
  return allowed.has(norm);
}

// assertAllowed: returns the normalized jid if allowed, else throws. Used on
// the write path so a non-allowlisted message can never be appended.
export function assertAllowed(cfg, provider, accountId, jid) {
  const norm = normalizeJid(jid);
  if (!isAllowed(cfg, provider, accountId, jid)) {
    throw new Error(`comms_allowlist: ${provider}/${accountId} not allowed: ${norm || "(empty jid)"}`);
  }
  return norm;
}

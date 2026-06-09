// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/normalize.js
// Provider-native WhatsApp WAMessage -> normalized Msg (§4.1 / §5.2).
// Pure, fs-free, dependency-free. The fingerprint is added later by the capture
// pipeline (via comms_dedupe.fingerprint) — normalize only produces the shape.

// Unwrap baileys envelope wrappers that hide the real content node (§5.2).
function unwrap(message) {
  let m = message;
  let guard = 0;
  while (m && guard++ < 8) {
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2) { m = m.viewOnceMessageV2.message; continue; }
    if (m.viewOnceMessageV2Extension) { m = m.viewOnceMessageV2Extension.message; continue; }
    if (m.deviceSentMessage) { m = m.deviceSentMessage.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  return m || null;
}

// baileys messageTimestamp can be a number, a string, or a Long {low,high,unsigned}.
function toEpochSeconds(t) {
  if (t == null) return 0;
  if (typeof t === "number") return Math.floor(t);
  if (typeof t === "string") { const n = Number(t); return Number.isFinite(n) ? Math.floor(n) : 0; }
  if (typeof t === "object" && typeof t.low === "number") {
    // Long: value = high*2^32 + (low>>>0). Timestamps fit in low for the next ~century.
    return (t.high * 4294967296) + (t.low >>> 0);
  }
  if (typeof t === "object" && typeof t.toNumber === "function") return Math.floor(t.toNumber());
  return 0;
}

function mediaFrom(node) {
  if (!node) return null;
  const mimetype = node.mimetype || null;
  const fileName = node.fileName || node.title || null;
  let sizeBytes = null;
  if (node.fileLength != null) sizeBytes = toEpochSeconds(node.fileLength); // reuse Long coercion
  if (!mimetype && !fileName && sizeBytes == null) return null;
  return { mimetype, fileName, sizeBytes };
}

// Map an unwrapped content node -> {kind, text, media}.
function classify(node) {
  if (!node) return { kind: "system", text: "", media: null };
  if (node.conversation) return { kind: "text", text: node.conversation, media: null };
  if (node.extendedTextMessage) return { kind: "text", text: node.extendedTextMessage.text || "", media: null };
  if (node.imageMessage) return { kind: "image", text: node.imageMessage.caption || "", media: mediaFrom(node.imageMessage) };
  if (node.videoMessage) return { kind: "video", text: node.videoMessage.caption || "", media: mediaFrom(node.videoMessage) };
  if (node.audioMessage) return { kind: "audio", text: "", media: mediaFrom(node.audioMessage) };
  if (node.documentMessage) return { kind: "document", text: node.documentMessage.caption || "", media: mediaFrom(node.documentMessage) };
  if (node.locationMessage) {
    const l = node.locationMessage;
    const label = l.name ? `${l.name} ` : "";
    return { kind: "location", text: `${label}(${l.degreesLatitude},${l.degreesLongitude})`, media: null };
  }
  if (node.pollCreationMessage || node.pollCreationMessageV3) {
    const p = node.pollCreationMessage || node.pollCreationMessageV3;
    return { kind: "poll", text: p.name || "", media: null };
  }
  return { kind: "system", text: "", media: null };
}

// contextInfo lives on extendedText/media nodes; find the first one that has it.
function replyTo(node) {
  if (!node) return null;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object" && v.contextInfo && v.contextInfo.stanzaId) return v.contextInfo.stanzaId;
  }
  return null;
}

export function normalize(provider, acc, raw, source = "live") {
  const key = raw.key || {};
  const isGroup = typeof key.remoteJid === "string" && key.remoteJid.endsWith("@g.us");
  const chatId = key.remoteJid || "";
  const senderId = isGroup ? (key.participant || key.remoteJid || "") : (key.remoteJid || "");
  const node = unwrap(raw.message);
  const { kind, text, media } = classify(node);
  const ts = toEpochSeconds(raw.messageTimestamp);
  return {
    provider,
    accountId: acc.accountId,
    chatId,
    msgId: key.id || "",
    fingerprint: null, // assigned by capture pipeline via comms_dedupe.fingerprint
    fromMe: !!key.fromMe,
    senderId,
    senderName: raw.pushName || raw.verifiedBizName || "",
    ts,
    tsIso: new Date(ts * 1000).toISOString(),
    kind,
    text,
    media,
    reply_to: replyTo(node),
    source,
  };
}

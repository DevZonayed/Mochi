// comms_import.js — WhatsApp "Export chat" .txt -> normalized Msg[] (spec §4.4,
// Req 7 history gap-fill). Pure, fs-only. The output feeds reconcileImport
// (comms_dedupe.js), which mints the synthetic `import:<sha1>` msgIds and folds
// the intra-minute ordinal — so this module emits the §4.1 Msg SHAPE with a
// provisional msgId/fingerprint and leaves canonical identity to the dedupe
// layer. fromMe:false, media:null, reply_to:null, source:"import" by contract.
//
// Handled line grammars (the two formats WhatsApp emits across platforms):
//   bracketed : "[m/d/yy, h:mm:ss AM] Sender: body"
//   dash      : "m/d/yy, h:mm - Sender: body"
// Continuation lines (no leading timestamp) append to the previous message's
// text. A header line with a timestamp but no "Sender:" is a system/notice line
// (kind:"system", senderId/senderName null). "<Media omitted>" and attachment
// markers map to the matching media kind with any caption preserved as text.

import fs from "node:fs";
import crypto from "node:crypto";
import { fingerprint } from "./comms_dedupe.js";

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// Two anchored header patterns. Both capture: date, time, optional AM/PM, rest.
// rest = everything after the separator ("] " for bracketed, " - " for dash);
// it may be "Sender: body" (a chat line) or a bare system notice.
//
// bracketed: optional leading LTR/RTL/BOM marks (some exports prepend U+200E)
// then "[date, time(:ss)? (AM|PM)?] rest".
const RE_BRACKET = /^[‎‏‪-‮﻿]*\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*([AaPp][Mm]))?\]\s+([\s\S]*)$/;
// dash: "date, time(:ss)? (AM|PM)? - rest"
const RE_DASH = /^[‎‏‪-‮﻿]*(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*([AaPp][Mm]))?\s+-\s+([\s\S]*)$/;

// "Sender: body" split. Sender names never contain a colon in WhatsApp exports,
// so the FIRST ": " delimits sender from body. A header line with no ": " is a
// system/notice line (e.g. "Messages and calls are end-to-end encrypted.").
function splitSender(rest) {
  const idx = rest.indexOf(": ");
  if (idx === -1) return { sender: null, body: rest };
  return { sender: rest.slice(0, idx), body: rest.slice(idx + 2) };
}

// Parse a header line into its components, or null if it is not a header.
function parseHeader(line) {
  let m = RE_BRACKET.exec(line);
  if (!m) m = RE_DASH.exec(line);
  if (!m) return null;
  const [, date, time, ampm, rest] = m;
  return { date, time, ampm: ampm || null, rest };
}

// m/d/yy(yy), h:mm(:ss)?, optional AM/PM -> epoch seconds.
// Two-digit years map to 2000+. Timestamps are minute-resolution per the export
// format; seconds are parsed when the bracketed variant supplies them, else 0.
//
// TIMEZONE: a WhatsApp "Export chat" .txt writes timestamps in the exporting
// DEVICE'S LOCAL timezone and carries NO tz marker, whereas live/backfill
// records carry a real UTC epoch from the provider. So the export's clock value
// is wall-clock LOCAL time. `tzMinutes` is the caller-supplied offset of that
// local clock from UTC, in minutes (the JS `getTimezoneOffset()` sign: minutes
// that must be ADDED to local to reach UTC — e.g. UTC-5 => +300, UTC+2 => -120).
// With it we anchor the parsed wall-clock to UTC so an imported line and the
// same live-captured message land in the SAME floor(ts/60) bucket -> same
// fingerprint -> the §4.2 live-wins tie-break fires and the message is NOT
// stored twice in the live/import overlap window.
//
// When `tzMinutes` is null/undefined the wall-clock is parsed AS-IF UTC (the
// historical behavior, preserved for callers that pass no hint). NOTE the limit
// this leaves: for a non-UTC user with no hint, import-vs-import idempotency
// still holds (all imports share the same skew), but cross-source live-vs-import
// dedupe will NOT collide — the duplicate appears only in the live/import
// overlap region. Pass `tzMinutes` to close that gap.
function toEpochSeconds(date, time, ampm, tzMinutes) {
  const [mo, da, yrRaw] = date.split("/").map((n) => parseInt(n, 10));
  let yr = yrRaw;
  if (yr < 100) yr += 2000;
  const parts = time.split(":").map((n) => parseInt(n, 10));
  let hr = parts[0];
  const min = parts[1] || 0;
  const sec = parts.length > 2 ? parts[2] : 0;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && hr < 12) hr += 12;
    if (!pm && hr === 12) hr = 0;
  }
  // Date.UTC treats the components as UTC wall-clock. Adding tzMinutes*60
  // converts a LOCAL wall-clock to the corresponding UTC instant (the offset
  // uses getTimezoneOffset() sign: +300 for UTC-5, so local 13:13 -> 18:13 UTC).
  const tzAdj = Number.isFinite(tzMinutes) ? tzMinutes * 60 : 0;
  return Math.floor(Date.UTC(yr, mo - 1, da, hr, min, sec) / 1000) + tzAdj;
}

// Attachment / media markers WhatsApp writes in the text export. The real bytes
// are NOT in the .txt, so media is null; we record the KIND and keep any caption.
// Returns { kind, text } where text is the caption (media markers carry none).
const MEDIA_MARKERS = [
  { re: /<Media omitted>/i, kind: "image" },          // generic; exact kind is unknowable from text
  { re: /\bimage omitted\b/i, kind: "image" },
  { re: /\bvideo omitted\b/i, kind: "video" },
  { re: /\baudio omitted\b/i, kind: "audio" },
  { re: /\bsticker omitted\b/i, kind: "image" },
  { re: /\bGIF omitted\b/i, kind: "video" },
  { re: /\bdocument omitted\b/i, kind: "document" },
  { re: /\bContact card omitted\b/i, kind: "system" },
  { re: /[‎‏]*\S+\.\w+\s*\(file attached\)/i, kind: "document" }, // "IMG-001.jpg (file attached)"
];

function classifyBody(body) {
  const trimmed = (body || "").trim();
  for (const { re, kind } of MEDIA_MARKERS) {
    if (re.test(trimmed)) {
      // Strip the marker token to recover any caption text that follows it.
      const caption = trimmed.replace(re, "").trim();
      return { kind, text: caption };
    }
  }
  return { kind: "text", text: body };
}

// parseWhatsAppExport(filePath, {provider, accountId, chatId, tzMinutes}) -> Msg[]
// Emits the §4.1 normalized shape per the import contract. The msgId/fingerprint
// set here are provisional (the canonical synthetic msgId is minted by
// reconcileImport); fingerprint is precomputed so a direct appendMessage of a
// parsed record (without reconcile) still dedupes correctly.
//
// `tzMinutes` (optional): offset of the export's local wall-clock from UTC, in
// `getTimezoneOffset()`-sign minutes (UTC-5 => +300). Aligns import timestamps
// to the provider's UTC epoch so cross-source (live-vs-import) dedupe collides
// in the live/import overlap window. Omit to parse wall-clock as UTC (the
// historical behavior; see toEpochSeconds for the limitation that leaves).
export function parseWhatsAppExport(filePath, { provider, accountId, chatId, tzMinutes } = {}) {
  const content = fs.readFileSync(filePath, "utf8");
  // Normalize CRLF; do NOT drop blank lines yet — a blank line inside a message
  // is a legitimate continuation (multi-paragraph message).
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const out = [];
  let cur = null; // the in-progress message we append continuation lines to
  let ordinal = 0; // per-call running ordinal source for synthetic msgId uniqueness

  const finalize = (msg) => {
    if (!msg) return;
    out.push(msg);
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (!header) {
      // Continuation: append to the previous message's text (preserve newline).
      if (cur) cur.text = cur.text ? `${cur.text}\n${line}` : line;
      // A leading line with no header and no current message is export preamble
      // junk (rare); ignore it.
      continue;
    }

    // New message header. Close out the previous one first.
    finalize(cur);
    cur = null;

    const ts = toEpochSeconds(header.date, header.time, header.ampm, tzMinutes);
    const { sender, body } = splitSender(header.rest);

    let kind, text, senderId, senderName;
    if (sender === null) {
      // System/notice line: timestamp but no "Sender:".
      kind = "system";
      text = body;
      senderId = null;
      senderName = null;
    } else {
      const c = classifyBody(body);
      kind = c.kind;
      text = c.text;
      // Exports identify the sender by display name only (no JID). Use the name
      // as both senderName and the senderId surrogate so the fingerprint's
      // sender component is stable across re-imports of the same export.
      senderName = sender;
      senderId = sender;
    }

    const tsIso = new Date(ts * 1000).toISOString();
    const o = {
      provider,
      accountId,
      chatId,
      msgId: null,          // canonical id minted by reconcileImport
      fingerprint: null,    // filled below
      fromMe: false,
      senderId,
      senderName,
      ts,
      tsIso,
      kind,
      text,
      media: null,          // bytes are not present in a text export
      reply_to: null,
      source: "import",
    };
    // Provisional synthetic msgId (reconcileImport overwrites it for NEW records,
    // but a stable value here keeps a direct appendMessage path well-formed).
    o.msgId = "import:" + sha1(`${chatId || ""}|${ts}|${ordinal}|${senderId || ""}|${text || ""}`);
    o.fingerprint = fingerprint(o);
    ordinal += 1;
    cur = o;
  }
  finalize(cur);

  return out;
}

// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_normalize.test.mjs
import assert from "node:assert/strict";
import { normalize } from "./src/comms/normalize.js";

const ACC = { provider: "whatsapp", accountId: "work" };

// helper: build a baileys-ish WAMessage envelope
function waMsg(over = {}) {
  return {
    key: { remoteJid: "19999999999@s.whatsapp.net", fromMe: false, id: "3EB0ABC", ...(over.key || {}) },
    messageTimestamp: over.messageTimestamp ?? 1717700000,
    pushName: over.pushName ?? "Alice",
    message: over.message ?? { conversation: "hello world" },
  };
}

// 1) plain DM text
{
  const m = normalize("whatsapp", ACC, waMsg(), "live");
  assert.equal(m.provider, "whatsapp");
  assert.equal(m.accountId, "work");
  assert.equal(m.chatId, "19999999999@s.whatsapp.net");
  assert.equal(m.msgId, "3EB0ABC");
  assert.equal(m.fromMe, false);
  assert.equal(m.senderId, "19999999999@s.whatsapp.net"); // DM: sender = remoteJid
  assert.equal(m.senderName, "Alice");
  assert.equal(m.ts, 1717700000);
  assert.equal(m.tsIso, "2024-06-06T18:53:20.000Z");
  assert.equal(m.kind, "text");
  assert.equal(m.text, "hello world");
  assert.equal(m.media, null);
  assert.equal(m.reply_to, null);
  assert.equal(m.source, "live");
  assert.equal(typeof m.ts, "number");
}

// 2) extendedTextMessage with reply (contextInfo.stanzaId)
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { extendedTextMessage: { text: "re: that", contextInfo: { stanzaId: "QUOTED1" } } },
  }), "live");
  assert.equal(m.kind, "text");
  assert.equal(m.text, "re: that");
  assert.equal(m.reply_to, "QUOTED1");
}

// 3) Long-shaped messageTimestamp { low, high, unsigned } -> Number
{
  const m = normalize("whatsapp", ACC, waMsg({ messageTimestamp: { low: 1717700000, high: 0, unsigned: true } }), "live");
  assert.equal(m.ts, 1717700000);
  assert.equal(typeof m.ts, "number");
}

// 4) group: sender is key.participant, chatId is the group jid
{
  const m = normalize("whatsapp", ACC, waMsg({
    key: { remoteJid: "123-456@g.us", participant: "1888@s.whatsapp.net", id: "G1", fromMe: false },
  }), "live");
  assert.equal(m.chatId, "123-456@g.us");
  assert.equal(m.senderId, "1888@s.whatsapp.net");
}

// 5) ephemeral wrapper unwrap
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { ephemeralMessage: { message: { conversation: "secret-ish" } } },
  }), "live");
  assert.equal(m.text, "secret-ish");
  assert.equal(m.kind, "text");
}

// 6) viewOnce + deviceSent nested wrappers unwrap to the inner image
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { deviceSentMessage: { message: { viewOnceMessage: { message: {
      imageMessage: { caption: "look", mimetype: "image/jpeg", fileName: "a.jpg", fileLength: 2048, mediaKey: "MK" },
    } } } } },
  }), "live");
  assert.equal(m.kind, "image");
  assert.equal(m.text, "look");
  assert.deepEqual(m.media, { mimetype: "image/jpeg", fileName: "a.jpg", sizeBytes: 2048 });
}

// 7) control event (message null) -> system, null-safe
// waMsg uses ?? so we pass a raw envelope directly to hit the null message path
{
  const raw = { key: { remoteJid: "19999999999@s.whatsapp.net", fromMe: false, id: "CTRL1" }, messageTimestamp: 1717700000, pushName: "Alice", message: null };
  const m = normalize("whatsapp", ACC, raw, "live");
  assert.equal(m.kind, "system");
  assert.equal(m.text, "");
  assert.equal(m.media, null);
}

// 8) poll
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { pollCreationMessage: { name: "Lunch?", options: [{ optionName: "Yes" }, { optionName: "No" }] } },
  }), "live");
  assert.equal(m.kind, "poll");
  assert.equal(m.text, "Lunch?");
}

// 9) location
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { locationMessage: { degreesLatitude: 1.5, degreesLongitude: 2.5, name: "HQ" } },
  }), "live");
  assert.equal(m.kind, "location");
  assert.ok(m.text.includes("1.5") && m.text.includes("2.5"));
}

console.log("✓ comms normalize");

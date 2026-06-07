// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { WhatsAppProvider } from "./src/comms/whatsapp.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";
import { getSlice } from "../plugins/continuum/lib/comms_store.js";
import { commsAuthDir } from "../plugins/continuum/lib/paths.js";

// A mock baileys socket: EventEmitter with .ev.on/.emit + the methods the
// provider calls. emitsConnectionUpdate(qr) / messages.upsert / history.set /
// close-with-reason are driven by the test.
function mockSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (e, cb) => ev.on(e, cb), emit: (e, d) => ev.emit(e, d) },
    user: { id: "me@s.whatsapp.net" },
    end: () => {},
    logout: async () => {},
    _emit: (e, d) => ev.emit(e, d),
  };
  return sock;
}

function waMsg(over = {}) {
  return {
    key: { remoteJid: over.remoteJid || "111@s.whatsapp.net", fromMe: false, id: over.id || "ID1", participant: over.participant },
    messageTimestamp: over.ts ?? 1717700000,
    pushName: over.name ?? "Bob",
    message: { conversation: over.text ?? "hi" },
  };
}

const ACCOUNT = "work";
const ALLOWED = "111@s.whatsapp.net";
const GROUP = "123-456@g.us";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-cap-"));
  await writeConfig(dir, {
    version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [ALLOWED, GROUP] } } } },
  });
  return dir;
}

// 1) live upsert for an allowlisted chat -> normalized + stored.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "L1", text: "live one" })] });
  await new Promise((r) => setTimeout(r, 10)); // let async append flush

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1);
  assert.equal(slice.messages[0].text, "live one");
  assert.equal(slice.messages[0].source, "live");
  assert.ok(slice.messages[0].fingerprint.startsWith("fp:"));
  await fs.rm(dir, { recursive: true, force: true });
}

// 2) NON-allowlisted chat -> dropped before write (structural guarantee §6.4).
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ remoteJid: "999@s.whatsapp.net", id: "X1", text: "stranger" })] });
  await new Promise((r) => setTimeout(r, 10));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: "999@s.whatsapp.net" });
  assert.equal(slice.messages.length, 0, "non-allowlisted message must never be written");
  await fs.rm(dir, { recursive: true, force: true });
}

// 3) duplicate msgId re-delivery -> idempotent (still 1).
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  const m = waMsg({ id: "DUP", text: "once" });
  sock._emit("messages.upsert", { type: "notify", messages: [m] });
  sock._emit("messages.upsert", { type: "notify", messages: [m] }); // re-emit
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "re-delivered msgId must dedupe");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4) messaging-history.set -> backfill source, deduped against a live record.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  // live first
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "H1", text: "same line" })] });
  await new Promise((r) => setTimeout(r, 10));
  // history ships the same logical message (same id) -> idempotent
  sock._emit("messaging-history.set", { messages: [waMsg({ id: "H1", text: "same line" })], isLatest: true });
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "history overlap with same msgId must dedupe");
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) group upsert: sender = participant; allowlisted group is captured.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("messages.upsert", { type: "notify", messages: [
    waMsg({ remoteJid: GROUP, participant: "1888@s.whatsapp.net", id: "G9", text: "group hi" }),
  ]});
  await new Promise((r) => setTimeout(r, 10));
  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: GROUP });
  assert.equal(slice.messages.length, 1);
  assert.equal(slice.messages[0].senderId, "1888@s.whatsapp.net");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp capture pipeline (mock socket)");

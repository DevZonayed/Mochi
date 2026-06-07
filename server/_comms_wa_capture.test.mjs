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

// 4a) messaging-history.set for a NEW message (no prior live) -> stored with source:'backfill'.
//     This is the positive backfill capture path — previously untested.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  // history-only message: no prior live delivery for this msgId.
  sock._emit("messaging-history.set", { messages: [waMsg({ id: "BF1", text: "history only" })], isLatest: true });
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "history-only message must be stored");
  assert.equal(slice.messages[0].source, "backfill", "history-only message must carry source:'backfill'");
  assert.equal(slice.messages[0].text, "history only");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4b) messaging-history.set overlaps a live message by CONTENT+MINUTE (same fingerprint)
//     but uses a DIFFERENT msgId — exercises cross-source Tier-2 fingerprint dedup.
//     Tier-1 passes (distinct msgIds). Tier-2 fires: existing record is 'live' (real),
//     incoming backfill is also 'real' -> live wins, backfill is dropped. Only 1 record.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  // live arrives first with msgId 'LIVE2'
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "LIVE2", ts: 1717700000, text: "overlap msg" })] });
  await new Promise((r) => setTimeout(r, 10));
  // backfill ships the same logical message but with a DIFFERENT msgId 'BF2' (same ts + text)
  // -> Tier-1 passes (different msgId); Tier-2 detects same fingerprint on a real/live record
  //    and drops the backfill as a duplicate-fingerprint-live-wins.
  sock._emit("messaging-history.set", { messages: [waMsg({ id: "BF2", ts: 1717700000, text: "overlap msg" })], isLatest: true });
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "backfill dup of live (same fp, diff msgId) must be deduplicated by Tier-2");
  assert.equal(slice.messages[0].source, "live", "surviving record must be the live one");
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

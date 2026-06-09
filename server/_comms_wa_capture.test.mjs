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

// 4b) messaging-history.set re-delivers the SAME msgId already stored via live upsert.
//     Exercises Tier-1 (same real provider msgId) dedup — spec §4.2.
//     Backfill arrives with msgId H1 (same as the live record) -> Tier-1 catches it.
//     Count must remain 1; surviving record retains source:'live'.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  // live upsert stores msgId H1
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "H1", ts: 1717700000, text: "shared msg" })] });
  await new Promise((r) => setTimeout(r, 10));
  // backfill re-delivers the SAME msgId H1 (true backfill overlap of the same message)
  // -> Tier-1 msgId dedup catches it; the backfill is dropped. Count stays 1.
  sock._emit("messaging-history.set", { messages: [waMsg({ id: "H1", ts: 1717700000, text: "shared msg" })], isLatest: true });
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "Tier-1: same msgId backfill re-delivery must dedupe (count stays 1)");
  assert.equal(slice.messages[0].source, "live", "surviving record must be the original live one");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4c) Two DISTINCT messages with same content+minute but DIFFERENT real msgIds:
//     one arrives via live, the other ONLY via backfill (REAL_A != REAL_B).
//     Tier-1 passes (different msgIds). Tier-2 must NOT suppress the backfill —
//     both are real provider records with distinct identities. Count must be 2.
//     This guards against the silent-loss bug where live-vs-backfill Tier-2
//     suppression dropped genuinely distinct messages (spec §4.2 violation).
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  // live message with msgId REAL_A
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "REAL_A", ts: 1717700000, text: "ok" })] });
  await new Promise((r) => setTimeout(r, 10));
  // distinct backfill message with msgId REAL_B (same content+minute, different provider msgId)
  // -> Tier-1 passes; Tier-2 must not suppress because both are real records.
  sock._emit("messaging-history.set", { messages: [waMsg({ id: "REAL_B", ts: 1717700000, text: "ok" })], isLatest: true });
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 2, "distinct live+backfill msgs with same content must both be stored (no silent loss)");
  const ids = slice.messages.map((m) => m.msgId).sort();
  assert.deepEqual(ids, ["REAL_A", "REAL_B"], "both real provider msgIds must survive");
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

// 6) onMessage callback fires exactly once across a duplicate re-delivery.
//    A re-delivered duplicate msgId (same raw message emitted twice) must only
//    trigger the onMessage listener once — the second emission is deduped by the
//    store and the listener fan-out must be gated on appendMessage's {appended}
//    return value (quality review fix, Task 16).
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });

  let callCount = 0;
  p.onMessage(() => { callCount++; });

  const m = waMsg({ id: "ONCE", text: "fire once" });
  sock._emit("messages.upsert", { type: "notify", messages: [m] });
  sock._emit("messages.upsert", { type: "notify", messages: [m] }); // duplicate re-delivery
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(callCount, 1, "onMessage callback must fire exactly once even when a duplicate msgId is re-delivered");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp capture pipeline (mock socket)");

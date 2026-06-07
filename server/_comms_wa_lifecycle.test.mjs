// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lifecycle.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { WhatsAppProvider } from "./src/comms/whatsapp.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";

const ACCOUNT = "work";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-life-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  return dir;
}

function mockSocket() {
  const ev = new EventEmitter();
  return {
    ev: { on: (e, cb) => ev.on(e, cb) },
    _emit: (e, d) => ev.emit(e, d),
    user: null,
    end() {},
    pairing: [],
    async requestPairingCode(phone) { this.pairing.push(phone); return "ABCD1234"; },
  };
}

// 1) link() with no phone -> resolves to {method:'qr', payload} when socket emits a qr.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  // inject a fake qr->dataURL so no `qrcode` dep is needed in tests
  const linkP = p.link(ACCOUNT, {}, { makeSocket: () => sock, qrToDataUrl: async (s) => `data:image/png;base64,QR(${s})` });
  // emit a qr a tick later
  setTimeout(() => sock._emit("connection.update", { qr: "QR-STRING" }), 5);
  const res = await linkP;
  assert.equal(res.method, "qr");
  assert.ok(res.payload.dataUrl.includes("QR-STRING"));
  assert.equal(typeof res.payload.ascii, "string");
  await fs.rm(dir, { recursive: true, force: true });
}

// 2) link() with phone -> requests pairing code ONCE, returns {method:'pairing'}.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  const res = await p.link(ACCOUNT, { phone: "19998887777" }, { makeSocket: () => sock });
  assert.equal(res.method, "pairing");
  assert.equal(res.payload.code, "ABCD1234");
  // Re-emitting a qr must NOT trigger a second pairing request (429 guard).
  sock._emit("connection.update", { qr: "ANOTHER-QR" });
  assert.equal(sock.pairing.length, 1, "pairing code must be requested exactly once");
  await fs.rm(dir, { recursive: true, force: true });
}

// 3) connection.update open -> status connected.
{
  const dir = await setup();
  const sock = mockSocket();
  // reconnectBaseMs:0 disables real backoff delays in tests
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("connection.update", { connection: "open" });
  assert.equal(p.status(ACCOUNT), "connected");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4) close with loggedOut(401) -> status logged_out (auth wiped), NO reconnect.
{
  const dir = await setup();
  const sock = mockSocket();
  let made = 0;
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => { made++; return sock; } });
  sock._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.status(ACCOUNT), "logged_out");
  assert.equal(made, 1, "loggedOut must NOT recreate the socket");
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) close with restartRequired(515) -> recreates socket (reconnect).
{
  const dir = await setup();
  let made = 0;
  const sockets = [mockSocket(), mockSocket()];
  // reconnectBaseMs:0 disables real delay so the reconnect happens immediately
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sockets[made++] });
  sockets[0]._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(made, 2, "restartRequired(515) must recreate the socket exactly once");
  assert.notEqual(p.status(ACCOUNT), "logged_out");
  await fs.rm(dir, { recursive: true, force: true });
}

// 6) link() then close(515) -> socket factory invoked exactly twice total (no double-wiring).
// Regression: if _wireConnection is called twice on the same socket (once in connect(),
// once in link()), the factory gets called twice on a single close event, meaning made
// goes from 1 to 3 instead of 1 to 2, orphaning/leaking a socket.
{
  const dir = await setup();
  let made = 0;
  const sockets = [mockSocket(), mockSocket(), mockSocket()];
  // reconnectBaseMs:0 disables real delay
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  // Use link() (QR path) to open the socket -- this is the double-wiring risk path.
  const linkP = p.link(ACCOUNT, {}, { makeSocket: () => { made++; return sockets[made - 1]; }, qrToDataUrl: async (s) => `data:image/png;base64,QR(${s})` });
  setTimeout(() => sockets[0]._emit("connection.update", { qr: "QR-STRING" }), 5);
  await linkP;
  assert.equal(made, 1, "link() must open exactly one socket");
  // Now emit close(515) on the socket opened by link().
  sockets[0]._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(made, 2, "close(515) after link() must create exactly one new socket (no double-wiring)");
  await fs.rm(dir, { recursive: true, force: true });
}

// 7) link() then close(401) -> _wipeAuth called once (no double-wiring duplication),
// status is logged_out, no reconnect.
{
  const dir = await setup();
  let made = 0;
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  const linkP = p.link(ACCOUNT, {}, { makeSocket: () => { made++; return sock; }, qrToDataUrl: async (s) => `data:image/png;base64,QR(${s})` });
  setTimeout(() => sock._emit("connection.update", { qr: "QR-STRING" }), 5);
  await linkP;
  // Track _wipeAuth calls to verify it is called exactly once even if there were
  // previously two handlers registered.
  let wipeCount = 0;
  const origWipe = p._wipeAuth.bind(p);
  p._wipeAuth = async (...args) => { wipeCount++; return origWipe(...args); };
  sock._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.status(ACCOUNT), "logged_out");
  assert.equal(made, 1, "loggedOut after link() must NOT recreate the socket");
  assert.equal(wipeCount, 1, "_wipeAuth must be called exactly once (no double-handler)");
  await fs.rm(dir, { recursive: true, force: true });
}

// 8) close with badSession(500) -> status logged_out, NO reconnect (permanent failure).
{
  const dir = await setup();
  const sock = mockSocket();
  let made = 0;
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => { made++; return sock; } });
  sock._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 500 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.status(ACCOUNT), "logged_out", "badSession(500) must set status logged_out");
  assert.equal(made, 1, "badSession(500) must NOT recreate the socket");
  await fs.rm(dir, { recursive: true, force: true });
}

// 9) close with connectionReplaced(440) -> status logged_out, NO reconnect.
{
  const dir = await setup();
  const sock = mockSocket();
  let made = 0;
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => { made++; return sock; } });
  sock._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 440 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.status(ACCOUNT), "logged_out", "connectionReplaced(440) must set status logged_out");
  assert.equal(made, 1, "connectionReplaced(440) must NOT recreate the socket");
  await fs.rm(dir, { recursive: true, force: true });
}

// 10) reconnect storm cap: after _MAX_RECONNECTS consecutive close(515) events the
// provider stops creating new sockets (no unbounded storm).
{
  const dir = await setup();
  const MAX = WhatsAppProvider._MAX_RECONNECTS;
  // Create enough sockets to satisfy up to MAX reconnects + 1 for the initial connect.
  const sockets = Array.from({ length: MAX + 2 }, () => mockSocket());
  let made = 0;
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sockets[made++] });
  // Emit close(515) up to MAX+2 times; only MAX reconnects should happen.
  for (let i = 0; i <= MAX + 1; i++) {
    // Emit on the most-recently created socket (index made-1).
    sockets[made - 1]._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await new Promise((r) => setTimeout(r, 5));
  }
  // Initial connect: 1, then MAX reconnects = MAX+1 total.
  assert.ok(made <= MAX + 1, `reconnect storm: expected at most ${MAX + 1} sockets, got ${made}`);
  await fs.rm(dir, { recursive: true, force: true });
}

// 11) link() QR path: connection reaches 'open' without emitting qr -> rejected with link_no_qr.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  const linkP = p.link(ACCOUNT, {}, { makeSocket: () => sock, qrToDataUrl: async (s) => `data:image/png;base64,QR(${s})` });
  // Emit connection 'open' without any preceding qr event.
  setTimeout(() => sock._emit("connection.update", { connection: "open" }), 5);
  await assert.rejects(linkP, (err) => {
    assert.equal(err.code, "link_no_qr", `expected code link_no_qr, got ${err.code}`);
    return true;
  }, "link() must reject with link_no_qr when session is already authenticated");
  await fs.rm(dir, { recursive: true, force: true });
}

// 12) link() QR path: timeout fires if no qr and no open event arrive.
// Uses qrTimeoutMs:20 (constructor injection) to drive the REAL link() with a
// tiny timeout instead of the 30-second production default — no subclass needed.
{
  const dir = await setup();
  const sock = mockSocket();
  // qrTimeoutMs:20 mirrors the reconnectBaseMs pattern and makes the real link()
  // timeout path testable without copy-pasting its implementation.
  const p = new WhatsAppProvider({ projectDirFor: () => dir, qrTimeoutMs: 20 });
  const linkP = p.link(ACCOUNT, {}, { makeSocket: () => sock, qrToDataUrl: async (s) => `data:image/png;base64,QR(${s})` });
  // Do NOT emit any event — let the timeout fire.
  await assert.rejects(linkP, (err) => {
    assert.equal(err.code, "link_timeout", `expected code link_timeout, got ${err.code}`);
    return true;
  }, "link() must reject with link_timeout when QR does not arrive");
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Task 3: WhatsAppProvider listGroups / listChats / getMessages / unlink.
// ---------------------------------------------------------------------------
import { appendMessage } from "../plugins/continuum/lib/comms_store.js";
import { commsAuthDir } from "../plugins/continuum/lib/paths.js";
import { acquireLock, readLock } from "./src/comms/whatsapp.js";

function mockGroupSocket(groups) {
  const sock = mockSocket();
  sock.groupFetchAllParticipating = async () => groups;
  return sock;
}

// 13) listGroups(accountId): maps group subjects to {id,name,chatKind:'group'}.
{
  const dir = await setup();
  const groups = {
    "111@g.us": { id: "111@g.us", subject: "Engineering" },
    "222@g.us": { id: "222@g.us", subject: "Random" },
  };
  const sock = mockGroupSocket(groups);
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  const list = await p.listGroups(ACCOUNT);
  assert.equal(list.length, 2);
  const byId = Object.fromEntries(list.map((g) => [g.id, g]));
  assert.equal(byId["111@g.us"].name, "Engineering");
  assert.equal(byId["111@g.us"].chatKind, "group");
  assert.equal(byId["222@g.us"].name, "Random");
  await fs.rm(dir, { recursive: true, force: true });
}

// 14) listGroups(accountId): throws a clear error when not connected.
{
  const dir = await setup();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await assert.rejects(() => p.listGroups(ACCOUNT), (err) => {
    assert.match(String(err.message), /not connected/i);
    return true;
  }, "listGroups must throw 'account not connected' with no live socket");
  await fs.rm(dir, { recursive: true, force: true });
}

// 15) listChats(accountId): returns allowlisted chats from the local store (no network).
{
  const dir = await setup();
  // Allowlist a chat and append a message to seed the store.
  const CHAT = "19998887777@s.whatsapp.net";
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [CHAT] } } } } });
  appendMessage(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: CHAT,
    msgId: "m1", fromMe: false, senderId: CHAT, senderName: "Sam", ts: 100, tsIso: new Date(100000).toISOString(),
    kind: "text", text: "hi", media: null, reply_to: null, source: "live" });
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  const chats = await p.listChats(ACCOUNT);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].chatId, CHAT);
  assert.equal(chats[0].count, 1);
  await fs.rm(dir, { recursive: true, force: true });
}

// 16) getMessages(accountId, chatId): best-effort read of normalized Msgs from the store.
{
  const dir = await setup();
  const CHAT = "19998887777@s.whatsapp.net";
  for (const m of [
    { msgId: "a", ts: 100, text: "one" },
    { msgId: "b", ts: 200, text: "two" },
    { msgId: "c", ts: 300, text: "three" },
  ]) {
    appendMessage(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: CHAT,
      msgId: m.msgId, fromMe: false, senderId: CHAT, senderName: "Sam", ts: m.ts, tsIso: new Date(m.ts * 1000).toISOString(),
      kind: "text", text: m.text, media: null, reply_to: null, source: "live" });
  }
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  const msgs = await p.getMessages(ACCOUNT, CHAT, { limit: 2 });
  assert.ok(Array.isArray(msgs));
  assert.equal(msgs.length, 2);
  // newest-first
  assert.equal(msgs[0].msgId, "c");
  assert.equal(msgs[1].msgId, "b");
  await fs.rm(dir, { recursive: true, force: true });
}

// 17) unlink(accountId): wipes the auth dir, releases the lock, clears in-memory entry.
{
  const dir = await setup();
  const sock = mockSocket();
  let ended = 0;
  sock.end = () => { ended++; };
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  const authDir = commsAuthDir(dir, "whatsapp", ACCOUNT);
  // Acquire the lock + drop a creds file so we can prove they're gone after unlink.
  await acquireLock(authDir);
  await fs.writeFile(path.join(authDir, "creds.json"), "{}");
  assert.ok(await readLock(authDir), "lock should be held before unlink");
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  await p.unlink(ACCOUNT);
  // auth dir is gone
  let exists = true;
  try { await fs.access(authDir); } catch { exists = false; }
  assert.equal(exists, false, "unlink must wipe the auth dir");
  // lock released (dir gone => readLock returns null)
  assert.equal(await readLock(authDir), null, "unlink must release the lock");
  // in-memory entry cleared
  assert.equal(p.sockets.has(ACCOUNT), false, "unlink must clear the in-memory socket entry");
  assert.equal(ended, 1, "unlink must close the live socket exactly once");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp lifecycle (qr/pairing/connection.update/close/backoff/storm-cap/link-timeout)");
console.log("✓ comms whatsapp provider methods (listGroups/listChats/getMessages/unlink)");

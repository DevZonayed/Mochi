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
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
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
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
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
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sockets[made++] });
  sockets[0]._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(made, 2, "restartRequired(515) must recreate the socket exactly once");
  assert.notEqual(p.status(ACCOUNT), "logged_out");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp lifecycle (qr/pairing/connection.update/close)");

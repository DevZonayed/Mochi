// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_state_meta.test.mjs
// Task 6: state writers (setAccountStatus/setSeen) + chat meta.json.
//   - a mock connect writes state.json with "connected" (the init-gate's
//     statusOf() now reflects real status instead of defaulting needs_login).
//   - appendMessage writes/updates meta.json on first append, so listChats
//     returns real name/chatKind instead of null/null.
//   - comms_get_messages / comms_recall advance the .last-session-seen.json
//     watermark via setSeen so the freshness branch is reachable.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fssync from "node:fs";
import { EventEmitter } from "node:events";
import { WhatsAppProvider } from "./src/comms/whatsapp.js";
import { buildServer } from "./src/comms/index.js";
import { ProviderRegistry } from "./src/comms/provider.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";
import { appendMessage, listChats } from "../plugins/continuum/lib/comms_store.js";
import { readState, readSeen } from "../plugins/continuum/lib/comms_state.js";
import { commsMetaPath } from "../plugins/continuum/lib/paths.js";

const ACCOUNT = "work";

function mockSocket() {
  const ev = new EventEmitter();
  return {
    ev: { on: (e, cb) => ev.on(e, cb) },
    _emit: (e, d) => ev.emit(e, d),
    user: null,
    end() {},
  };
}

// 1) connect() writes state.json status "connected" for the account.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-state-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  const state = readState(dir);
  assert.equal(state.whatsapp?.[ACCOUNT]?.status, "connected", "connect must persist status connected");
  assert.equal(typeof state.whatsapp?.[ACCOUNT]?.updatedAt, "number", "status record carries updatedAt");
  await fs.rm(dir, { recursive: true, force: true });
}

// 2) connection.update open also persists "connected" (transition path).
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-state-open-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("connection.update", { connection: "open" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(readState(dir).whatsapp?.[ACCOUNT]?.status, "connected");
  await fs.rm(dir, { recursive: true, force: true });
}

// 3) loggedOut(401) close persists status "logged_out".
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-state-out-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(readState(dir).whatsapp?.[ACCOUNT]?.status, "logged_out");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4) appendMessage writes meta.json (group) so listChats returns real chatKind/name.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-meta-grp-"));
  const GROUP = "123-456@g.us";
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [GROUP] } } } } });
  appendMessage(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: GROUP,
    msgId: "g1", fromMe: false, senderId: "1888@s.whatsapp.net", senderName: "Bob", ts: 100,
    tsIso: new Date(100000).toISOString(), kind: "text", text: "hi", media: null, reply_to: null, source: "live" });
  const meta = JSON.parse(fssync.readFileSync(commsMetaPath(dir, "whatsapp", ACCOUNT, GROUP), "utf8"));
  assert.equal(meta.chatKind, "group", "group chatId yields chatKind:group in meta.json");
  const chats = listChats(dir, [GROUP]);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].chatKind, "group", "listChats reflects meta chatKind (not null)");
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) appendMessage on a DM writes meta with chatKind:dm and a name (senderName).
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-meta-dm-"));
  const DM = "19998887777@s.whatsapp.net";
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [DM] } } } } });
  appendMessage(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: DM,
    msgId: "d1", fromMe: false, senderId: DM, senderName: "Sam", ts: 100,
    tsIso: new Date(100000).toISOString(), kind: "text", text: "yo", media: null, reply_to: null, source: "live" });
  const meta = JSON.parse(fssync.readFileSync(commsMetaPath(dir, "whatsapp", ACCOUNT, DM), "utf8"));
  assert.equal(meta.chatKind, "dm", "non-group chatId yields chatKind:dm");
  assert.equal(meta.name, "Sam", "DM name backfilled from inbound senderName");
  const chats = listChats(dir, [DM]);
  assert.equal(chats[0].name, "Sam");
  assert.equal(chats[0].chatKind, "dm");
  await fs.rm(dir, { recursive: true, force: true });
}

// 5b) a fromMe message must NOT overwrite the DM name with our own pushName, but
//     a later inbound message backfills it.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-meta-fromme-"));
  const DM = "19998887777@s.whatsapp.net";
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [DM] } } } } });
  appendMessage(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: DM,
    msgId: "me1", fromMe: true, senderId: DM, senderName: "Me", ts: 100,
    tsIso: new Date(100000).toISOString(), kind: "text", text: "hello?", media: null, reply_to: null, source: "live" });
  let meta = JSON.parse(fssync.readFileSync(commsMetaPath(dir, "whatsapp", ACCOUNT, DM), "utf8"));
  assert.equal(meta.chatKind, "dm");
  assert.equal(meta.name ?? null, null, "fromMe message must not set the DM name to our own pushName");
  appendMessage(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: DM,
    msgId: "in1", fromMe: false, senderId: DM, senderName: "Sam", ts: 200,
    tsIso: new Date(200000).toISOString(), kind: "text", text: "hi", media: null, reply_to: null, source: "live" });
  meta = JSON.parse(fssync.readFileSync(commsMetaPath(dir, "whatsapp", ACCOUNT, DM), "utf8"));
  assert.equal(meta.name, "Sam", "later inbound message backfills the DM name");
  await fs.rm(dir, { recursive: true, force: true });
}

// 6) comms_get_messages advances the last-seen watermark (setSeen) to newestTs.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-seen-get-"));
  const provider = "whatsapp";
  const chatId = "12345@s.whatsapp.net";
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { [provider]: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [chatId] } } } } });
  for (const m of [{ msgId: "a", ts: 100 }, { msgId: "b", ts: 300 }]) {
    appendMessage(dir, { provider, accountId: ACCOUNT, chatId,
      msgId: m.msgId, fromMe: false, senderId: chatId, senderName: "Sam", ts: m.ts,
      tsIso: new Date(m.ts * 1000).toISOString(), kind: "text", text: "x", media: null, reply_to: null, source: "live" });
  }
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_get_messages",
    arguments: { provider, accountId: ACCOUNT, chatId, limit: 10, project_dir: dir } });
  assert.equal(r.isError, false, `get_messages err: ${r.content[0].text}`);
  const seen = readSeen(dir);
  assert.equal(seen[`${provider}/${ACCOUNT}/${chatId}`], 300, "comms_get_messages advances watermark to newest ts read");
  await fs.rm(dir, { recursive: true, force: true });
}

// 7) comms_recall advances the watermark for each chat that yielded a hit.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-seen-recall-"));
  const provider = "whatsapp";
  const chatId = "12345@s.whatsapp.net";
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { [provider]: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [chatId] } } } } });
  for (const m of [{ msgId: "m1", ts: 100, text: "budget review" }, { msgId: "m2", ts: 300, text: "budget numbers" }]) {
    appendMessage(dir, { provider, accountId: ACCOUNT, chatId,
      msgId: m.msgId, fromMe: false, senderId: chatId, senderName: "Sam", ts: m.ts,
      tsIso: new Date(m.ts * 1000).toISOString(), kind: "text", text: m.text, media: null, reply_to: null, source: "live" });
  }
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_recall",
    arguments: { query: "budget", provider, accountId: ACCOUNT, chatId, project_dir: dir } });
  assert.equal(r.isError, false, `recall err: ${r.content[0].text}`);
  const seen = readSeen(dir);
  assert.equal(seen[`${provider}/${ACCOUNT}/${chatId}`], 300, "comms_recall advances watermark to newest hit ts");
  await fs.rm(dir, { recursive: true, force: true });
}

// 8) comms_account_status persists status into state.json (belt-and-suspenders).
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-state-status-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  const sock = mockSocket();
  // Use a single shared provider across both calls via a custom registry so the
  // status set by connect() survives to the comms_account_status call.
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  const reg = new ProviderRegistry();
  reg.register("whatsapp", () => p);
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_account_status",
    arguments: { provider: "whatsapp", accountId: ACCOUNT, project_dir: dir } });
  assert.equal(r.isError, false);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, "connected");
  assert.equal(readState(dir).whatsapp?.[ACCOUNT]?.status, "connected", "comms_account_status mirrors status into state.json");
  await fs.rm(dir, { recursive: true, force: true });
}

// 9) unlink() persists status "logged_out" into state.json so the fs-only init-gate
//    does not still report the account as connected after an explicit unlink.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-state-unlink-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir, reconnectBaseMs: 0 });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  assert.equal(readState(dir).whatsapp?.[ACCOUNT]?.status, "connected", "precondition: connect persisted connected");
  await p.unlink(ACCOUNT);
  assert.equal(readState(dir).whatsapp?.[ACCOUNT]?.status, "logged_out", "unlink must persist status logged_out into state.json");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms state writers (setAccountStatus/setSeen) + chat meta.json");

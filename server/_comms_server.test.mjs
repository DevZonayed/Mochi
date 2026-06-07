// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildServer } from "./src/comms/index.js";
import { ProviderRegistry, CommsProvider } from "./src/comms/provider.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";
import { appendMessage } from "../plugins/continuum/lib/comms_store.js";

const TOOLS = [
  "comms_link_account","comms_account_status","comms_unlink_account",
  "comms_list_chats","comms_list_groups","comms_set_allowlist",
  "comms_get_messages","comms_recall","comms_import_history","comms_sync_now",
];

// 1) all §10 tools present, valid schema, EVERY tool accepts optional project_dir.
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const names = srv.tools.map((t) => t.name);
  for (const t of TOOLS) assert.ok(names.includes(t), `missing tool ${t}`);
  for (const t of srv.tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} schema not object`);
    assert.ok(t.description && t.description.length > 0, `${t.name} no description`);
    assert.ok(t.inputSchema.properties.project_dir, `${t.name} missing project_dir arg`);
  }
}

// 2) projectDir resolution: COMMS_PROJECT_DIR env is the eager path.
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: { COMMS_PROJECT_DIR: "/eager/dir" } });
  assert.equal(srv.resolveProjectDir({}), "/eager/dir");
  // per-tool arg overrides env (§3.1 guaranteed fallback / explicit override).
  assert.equal(srv.resolveProjectDir({ project_dir: "/arg/dir" }), "/arg/dir");
}

// 3) projectDir resolution: NO env, NO arg -> throws (never use cwd for writes).
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  assert.throws(() => srv.resolveProjectDir({}), /project_dir/);
}

// 4) dispatch: comms_account_status routes to the provider via the registry.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-srv-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false, providers: {} });
  class Fake extends CommsProvider { constructor() { super("whatsapp"); } status() { return "needs_login"; } }
  const reg = new ProviderRegistry();
  reg.register("whatsapp", () => new Fake());
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_account_status", arguments: { provider: "whatsapp", accountId: "work", project_dir: dir } });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, "needs_login");
  assert.equal(r.isError, false);
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) unknown tool -> isError result (MCP convention), not a throw.
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_nope", arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("unknown tool"));
}

// 6) comms_set_allowlist: decided/declined flip, default account scaffold,
//    normalizeJid strip + dedupe-merge. This is the security-relevant path that
//    opens capture for a repo — a regression here would pass CI silently without
//    this test.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-srv-allow-"));
  // Start with an undecided config (no providers block).
  await writeConfig(dir, { version: 1, decided: false, declined: false, providers: {} });

  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });

  // Call with two JIDs: one has a device suffix (:4) that normalizeJid must strip,
  // giving the same canonical JID as the second — only one entry must survive.
  const r = await srv.handleToolCall({
    name: "comms_set_allowlist",
    arguments: {
      provider: "whatsapp",
      accountId: "work",
      allowed_jids: ["123:4@s.whatsapp.net", "123@s.whatsapp.net"],
      project_dir: dir,
    },
  });

  assert.equal(r.isError, false, `set_allowlist returned error: ${r.content[0].text}`);
  const out = JSON.parse(r.content[0].text);
  // After dedup, exactly one normalized JID.
  assert.deepEqual(out.allowed_jids, ["123@s.whatsapp.net"]);

  // Re-read the written config and verify the shape.
  const { readConfig } = await import("../plugins/continuum/lib/comms_config.js");
  const cfg = readConfig(dir);
  assert.equal(cfg.decided, true,  "decided must be flipped to true");
  assert.equal(cfg.declined, false, "declined must remain false");
  const acc = cfg.providers?.whatsapp?.accounts?.work;
  assert.ok(acc, "account scaffold must be created");
  assert.equal(acc.capture, "session", "default capture must be 'session'");
  assert.equal(acc.mode, "strict",     "default mode must be 'strict'");
  assert.deepEqual(acc.allowed_jids, ["123@s.whatsapp.net"], "deduplicated normalized JIDs");

  // Second call: merge-in a new JID without losing the existing one.
  const r2 = await srv.handleToolCall({
    name: "comms_set_allowlist",
    arguments: {
      provider: "whatsapp",
      accountId: "work",
      allowed_jids: ["456@s.whatsapp.net"],
      project_dir: dir,
    },
  });
  assert.equal(r2.isError, false);
  const out2 = JSON.parse(r2.content[0].text);
  assert.deepEqual(
    [...out2.allowed_jids].sort(),
    ["123@s.whatsapp.net", "456@s.whatsapp.net"].sort(),
    "merge must union old + new JIDs",
  );

  await fs.rm(dir, { recursive: true, force: true });
}

// 7) comms_recall: drives the tool through the server's tool-call handler
//    against a tmp projectDir seeded with an allowlisted chat + a few messages.
//    Asserts a non-error scored result (objects with chatId, tsIso,
//    excerpt/text, msgId) — NOT the stub "not wired in this phase" error.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-srv-recall-"));
  const provider = "whatsapp";
  const accountId = "work";
  const chatId = "12345@s.whatsapp.net";

  // Allowlist the chat so the read-side allowlist-strict recall will scan it.
  await writeConfig(dir, {
    version: 1, decided: true, declined: false,
    providers: { [provider]: { accounts: { [accountId]: {
      capture: "session", mode: "strict", allowed_jids: [chatId],
    } } } },
  });

  // Seed a few messages into the store under the allowlisted chat. One clearly
  // matches the query token; another is noise that must not score.
  const base = 1_700_000_000;
  const seed = [
    { msgId: "m1", ts: base + 10, text: "let's discuss the quarterly budget review tomorrow", senderName: "Alice" },
    { msgId: "m2", ts: base + 20, text: "lunch plans anyone?", senderName: "Bob" },
    { msgId: "m3", ts: base + 30, text: "the budget numbers look great this quarter", senderName: "Alice" },
  ];
  for (const s of seed) {
    appendMessage(dir, {
      provider, accountId, chatId,
      msgId: s.msgId, fromMe: false, senderId: "u1", senderName: s.senderName,
      ts: s.ts, tsIso: new Date(s.ts * 1000).toISOString(),
      kind: "text", text: s.text, media: null, reply_to: null, source: "live",
    });
  }

  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({
    name: "comms_recall",
    arguments: { query: "budget", provider, accountId, chatId, project_dir: dir },
  });

  assert.equal(r.isError, false, `comms_recall returned error: ${r.content[0].text}`);
  assert.ok(!String(r.content[0].text).includes("not wired"), "comms_recall must not return the stub error");

  const out = JSON.parse(r.content[0].text);
  assert.ok(Array.isArray(out.hits), "result must carry a hits array");
  assert.ok(out.hits.length >= 1, "the 'budget' query must score at least one message");

  // Both budget messages should hit; the lunch message must not.
  const ids = out.hits.map((h) => h.msgId).sort();
  assert.deepEqual(ids, ["m1", "m3"], "only the two budget messages must score");

  // Each hit carries the §10 snippet contract handles.
  for (const h of out.hits) {
    assert.equal(h.chatId, chatId, "hit chatId");
    assert.ok(typeof h.tsIso === "string" && h.tsIso.length > 0, "hit tsIso");
    assert.ok(typeof h.excerpt === "string" && h.excerpt.length > 0, "hit excerpt/text");
    assert.ok(typeof h.msgId === "string" && h.msgId.length > 0, "hit msgId");
  }

  await fs.rm(dir, { recursive: true, force: true });
}

// 8) comms_import_history: end-to-end through the server tool handler. Parses a
//    real WhatsApp "Export chat" .txt fixture into the store under an allowlisted
//    chat, asserting added>0 on the first run and added===0 on the second
//    (idempotent re-import — Req 7 history gap-fill). NOT the stub error.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-srv-import-"));
  const provider = "whatsapp";
  const accountId = "work";
  const chatId = "12345@s.whatsapp.net";

  await writeConfig(dir, {
    version: 1, decided: true, declined: false,
    providers: { [provider]: { accounts: { [accountId]: {
      capture: "session", mode: "strict", allowed_jids: [chatId],
    } } } },
  });

  // A small but representative export: basic line, multi-line continuation,
  // a <Media omitted> line, a system/notice line, and two same-minute lines
  // (the intra-minute ordinal path).
  const exportTxt = [
    "[6/6/24, 6:13:20 PM] Alice: let's discuss the budget tomorrow",
    "and bring the latest numbers",
    "[6/6/24, 6:14:00 PM] Bob: <Media omitted>",
    "[6/6/24, 6:15:00 PM] Messages and calls are end-to-end encrypted.",
    "6/6/24, 18:16 - Carol: dash format also parses",
    "[6/6/24, 6:18:00 PM] Dave: ok",
    "[6/6/24, 6:18:30 PM] Dave: ok",
  ].join("\n");
  const fixture = path.join(dir, "export.txt");
  await fs.writeFile(fixture, exportTxt);

  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });

  const r1 = await srv.handleToolCall({
    name: "comms_import_history",
    arguments: { provider, accountId, chatId, filePath: fixture, project_dir: dir },
  });
  assert.equal(r1.isError, false, `comms_import_history returned error: ${r1.content[0].text}`);
  assert.ok(!String(r1.content[0].text).includes("not wired"), "must not return the stub error");
  const out1 = JSON.parse(r1.content[0].text);
  assert.ok(out1.added > 0, `first import must add records, got added=${out1.added}`);
  assert.equal(out1.added, 6, "all 6 distinct import messages added on first run");
  assert.equal(out1.total, 6, "total reflects the reconciled set");

  // Second import of the same export must add nothing (idempotent re-import).
  const r2 = await srv.handleToolCall({
    name: "comms_import_history",
    arguments: { provider, accountId, chatId, filePath: fixture, project_dir: dir },
  });
  assert.equal(r2.isError, false, `re-import returned error: ${r2.content[0].text}`);
  const out2 = JSON.parse(r2.content[0].text);
  assert.equal(out2.added, 0, "idempotent re-import adds nothing new");

  // Readback through getSlice proves the import records actually landed in the
  // store under the allowlisted chat and carry source:"import".
  const rs = await srv.handleToolCall({
    name: "comms_get_messages",
    arguments: { provider, accountId, chatId, limit: 50, project_dir: dir },
  });
  const slice = JSON.parse(rs.content[0].text);
  assert.equal(slice.messages.length, 6, "store holds the 6 imported messages");
  assert.ok(slice.messages.every((m) => m.source === "import"), "every stored record is an import");
  // Continuation folded into the first message's text.
  const folded = slice.messages.find((m) => m.text && m.text.includes("bring the latest numbers"));
  assert.ok(folded && folded.text.includes("budget"), "multi-line continuation folded into one message");

  await fs.rm(dir, { recursive: true, force: true });
}

// 8b) comms_import_history WRITE-PATH ALLOWLIST GUARD (§6.4 structural invariant).
//    Importing into a chat that is NOT on the account's allowlist must persist
//    NOTHING — the store never holds a non-allowlisted chat. The live-capture
//    path enforces this (whatsapp.js _capture drops before write); the import
//    path is the parallel write path and must gate identically. Without this
//    test the invariant has zero regression protection on the import path.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-srv-import-deny-"));
  const provider = "whatsapp";
  const accountId = "work";
  const allowedChat = "12345@s.whatsapp.net";
  const deniedChat = "99999@s.whatsapp.net"; // deliberately NOT in allowed_jids

  await writeConfig(dir, {
    version: 1, decided: true, declined: false,
    providers: { [provider]: { accounts: { [accountId]: {
      capture: "session", mode: "strict", allowed_jids: [allowedChat],
    } } } },
  });

  // A valid export that WOULD parse to records if the guard weren't there.
  const exportTxt = [
    "[6/6/24, 6:13:20 PM] Alice: secret message that must never persist",
    "[6/6/24, 6:14:00 PM] Bob: nor this one",
  ].join("\n");
  const fixture = path.join(dir, "export.txt");
  await fs.writeFile(fixture, exportTxt);

  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });

  // Import targeting the NON-allowlisted chat must be rejected and write nothing.
  const r = await srv.handleToolCall({
    name: "comms_import_history",
    arguments: { provider, accountId, chatId: deniedChat, filePath: fixture, project_dir: dir },
  });
  // Either an isError result OR a non-error {added:0}; both are acceptable per
  // §6.4 ("never persists"), but the records must NOT land.
  if (!r.isError) {
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.added, 0, "non-allowlisted import must add nothing");
  } else {
    assert.ok(r.isError === true, "non-allowlisted import returns an error result");
  }

  // Readback of the denied chat through getSlice must be EMPTY — proves nothing
  // was persisted to the store under the non-allowlisted chatId.
  const rs = await srv.handleToolCall({
    name: "comms_get_messages",
    arguments: { provider, accountId, chatId: deniedChat, limit: 50, project_dir: dir },
  });
  const slice = JSON.parse(rs.content[0].text);
  assert.equal(slice.messages.length, 0, "denied chat must hold zero stored messages");

  // Sanity: the ALLOWLISTED chat still imports normally (guard isn't over-broad).
  const rOk = await srv.handleToolCall({
    name: "comms_import_history",
    arguments: { provider, accountId, chatId: allowedChat, filePath: fixture, project_dir: dir },
  });
  assert.equal(rOk.isError, false, `allowlisted import returned error: ${rOk.content[0].text}`);
  const outOk = JSON.parse(rOk.content[0].text);
  assert.ok(outOk.added > 0, "allowlisted import still adds records");

  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms MCP server tool layer + projectDir resolution");

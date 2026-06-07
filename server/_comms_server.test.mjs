// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildServer } from "./src/comms/index.js";
import { ProviderRegistry, CommsProvider } from "./src/comms/provider.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";

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

console.log("✓ comms MCP server tool layer + projectDir resolution");

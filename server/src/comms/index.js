#!/usr/bin/env node
// comms MCP server — bundled to dist/comms.bundle.mjs. Mirrors the browser
// server's @modelcontextprotocol/sdk + StdioServerTransport usage. Channel-
// agnostic: dispatches on `provider` via the registry. Project dir is resolved
// explicitly (env COMMS_PROJECT_DIR -> per-tool project_dir arg), NEVER cwd (§3.1).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ProviderRegistry } from "./provider.js";
import { WhatsAppProvider } from "./whatsapp.js";
import { getSlice, listChats, readAllMessages, appendMessage } from "../../../plugins/continuum/lib/comms_store.js";
import { readConfig, writeConfig } from "../../../plugins/continuum/lib/comms_config.js";
import { normalizeJid } from "../../../plugins/continuum/lib/comms_allowlist.js";
import { commsRecall } from "../../../plugins/continuum/lib/comms_recall.js";
import { parseWhatsAppExport } from "../../../plugins/continuum/lib/comms_import.js";
import { reconcileImport } from "../../../plugins/continuum/lib/comms_dedupe.js";

const log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");

const PROJ = { type: "string", description: "Project root containing .continuum/. Defaults to COMMS_PROJECT_DIR env." };

const TOOL_DEFS = [
  { name: "comms_link_account", description: "Start a login for a comms account; returns a QR (data-URL + ASCII) or, if phone is given, an 8-char pairing code (requested once).",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, phone: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_account_status", description: "Report connection status: connected | needs_login | logged_out.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_unlink_account", description: "Wipe session/auth files for an account.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_list_chats", description: "Enumerate allowlisted DM/group chats for an account.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_list_groups", description: "Enumerate group chats visible to the account (pick-time).",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_set_allowlist", description: "Merge JIDs into an account's allowlist and flip decided:true/declined:false.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, allowed_jids: { type: "array", items: { type: "string" } }, project_dir: PROJ }, required: ["provider", "accountId", "allowed_jids"] } },
  { name: "comms_get_messages", description: "Return a bounded latest-N or windowed slice of a chat from the store (default 20, hard max 200).",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, chatId: { type: "string" }, limit: { type: "number" }, anchor: { type: "string" }, before: { type: "number" }, after: { type: "number" }, continuation: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId", "chatId"] } },
  { name: "comms_recall", description: "Stemmed-token search over the comms store; returns scored snippets with msgId handles (bounded).",
    inputSchema: { type: "object", properties: { query: { type: "string" }, provider: { type: "string" }, accountId: { type: "string" }, chatId: { type: "string" }, since: { type: "number" }, until: { type: "number" }, limit: { type: "number" }, project_dir: PROJ }, required: ["query"] } },
  { name: "comms_import_history", description: "Parse a WhatsApp 'Export chat' .txt and reconcile it into the store by fingerprint.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, chatId: { type: "string" }, filePath: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId", "chatId", "filePath"] } },
  { name: "comms_sync_now", description: "Force a connect + best-effort backfill pass for an account.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
];

function ok(obj) { return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: false }; }
function err(msg) { return { content: [{ type: "text", text: msg }], isError: true }; }

export function buildServer({ registry, env = process.env } = {}) {
  const reg = registry || (() => { const r = new ProviderRegistry(); r.register("whatsapp", (deps) => new WhatsAppProvider(deps)); return r; })();
  const acctProject = new Map(); // accountId -> projectDir (§3.1 in-memory map)

  function resolveProjectDir(args = {}) {
    const dir = args.project_dir || env.COMMS_PROJECT_DIR;
    if (!dir) throw new Error("project_dir is required (no COMMS_PROJECT_DIR env and no project_dir arg)");
    return dir;
  }

  function providerFor(name, projectDir) {
    return reg.get(name, { projectDirFor: (accountId) => acctProject.get(`${name}:${accountId}`) || projectDir });
  }

  async function handleToolCall(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};

    // Check for unknown tool first (before projectDir resolution) so callers
    // get a clear "unknown tool" error rather than a misleading projectDir error.
    const knownTools = new Set(TOOL_DEFS.map((t) => t.name));
    if (!knownTools.has(name)) {
      return err(`unknown tool: ${name}`);
    }

    try {
      let projectDir;
      try { projectDir = resolveProjectDir(args); } catch (e) { return err(String(e.message || e)); }
      if (args.provider && args.accountId) acctProject.set(`${args.provider}:${args.accountId}`, projectDir);

      switch (name) {
        case "comms_account_status": {
          const p = providerFor(args.provider, projectDir);
          return ok({ status: p.status(args.accountId) });
        }
        case "comms_link_account": {
          const p = providerFor(args.provider, projectDir);
          const res = await p.link(args.accountId, { phone: args.phone });
          return ok(res);
        }
        case "comms_unlink_account": {
          const p = providerFor(args.provider, projectDir);
          await p.unlink(args.accountId);
          return ok({ unlinked: true });
        }
        case "comms_list_chats": {
          const cfg = readConfig(projectDir);
          const allowed = cfg?.providers?.[args.provider]?.accounts?.[args.accountId]?.allowed_jids || [];
          return ok({ chats: listChats(projectDir, allowed) });
        }
        case "comms_list_groups": {
          const p = providerFor(args.provider, projectDir);
          return ok({ groups: await p.listGroups(args.accountId) });
        }
        case "comms_set_allowlist": {
          const cfg = readConfig(projectDir);
          cfg.decided = true; cfg.declined = false;
          cfg.providers = cfg.providers || {};
          const prov = cfg.providers[args.provider] = cfg.providers[args.provider] || { accounts: {} };
          const acc = prov.accounts[args.accountId] = prov.accounts[args.accountId] || { capture: "session", mode: "strict", allowed_jids: [] };
          const incoming = (args.allowed_jids || []).map(normalizeJid);
          acc.allowed_jids = [...new Set([...(acc.allowed_jids || []), ...incoming])];
          writeConfig(projectDir, cfg);
          return ok({ allowed_jids: acc.allowed_jids });
        }
        case "comms_get_messages": {
          const slice = getSlice(projectDir, { provider: args.provider, accountId: args.accountId, chatId: args.chatId,
            limit: args.limit, anchor: args.anchor, before: args.before, after: args.after, continuation: args.continuation });
          return ok(slice);
        }
        case "comms_sync_now": {
          const p = providerFor(args.provider, projectDir);
          await p.connect?.(args.accountId, {});
          return ok({ status: p.status(args.accountId) });
        }
        case "comms_recall": {
          return ok(commsRecall(projectDir, {
            query: args.query, provider: args.provider, accountId: args.accountId,
            chatId: args.chatId, since: args.since, until: args.until, limit: args.limit,
          }));
        }
        case "comms_import_history": {
          // Parse the WhatsApp "Export chat" .txt -> normalized Msg[], reconcile
          // against the existing store by fingerprint (live/backfill win, §4.2),
          // then append-only persist exactly the NEW import records.
          const chatId = normalizeJid(args.chatId);
          const existing = readAllMessages(projectDir, args.provider, args.accountId, chatId);
          const parsed = parseWhatsAppExport(args.filePath, {
            provider: args.provider, accountId: args.accountId, chatId,
          });
          const { merged, added } = reconcileImport(existing, parsed);
          for (const m of added) appendMessage(projectDir, m);
          return ok({ added: added.length, total: merged.length });
        }
        default:
          // Should not reach here since unknown tools are caught above.
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`${name} failed: ${String(e?.message ?? e)}`);
    }
  }

  return { tools: TOOL_DEFS, handleToolCall, resolveProjectDir, registry: reg };
}

// Entrypoint wiring (only when run directly / bundled) — eager reconnect of
// known accounts, then stdio MCP. Guarded so unit tests import buildServer only.
export async function main() {
  const srv = buildServer({ env: process.env });
  // Eager reconnect (§3.1): if COMMS_PROJECT_DIR is set and accounts exist, reconnect.
  try {
    const projectDir = process.env.COMMS_PROJECT_DIR;
    if (projectDir) {
      const cfg = readConfig(projectDir);
      const provs = cfg?.providers || {};
      for (const provName of Object.keys(provs)) {
        const accounts = provs[provName]?.accounts || {};
        for (const accountId of Object.keys(accounts)) {
          try {
            const p = srv.registry.get(provName, { projectDirFor: () => projectDir });
            await p.connect?.(accountId, {});
            log(`[comms] eager-reconnected ${provName}:${accountId}`);
          } catch (e) { log(`[comms] eager reconnect failed for ${provName}:${accountId}: ${e.message}`); }
        }
      }
    }
  } catch (e) { log(`[comms] eager reconnect skipped: ${e.message}`); }

  const mcp = new Server({ name: "comms", version: "0.7.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: srv.tools }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => srv.handleToolCall(req.params));
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("[comms] ready");
}

// Run only when invoked as the bundle/entry (not on import).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log(`[comms] fatal: ${e.stack || e}`); process.exit(1); });
}

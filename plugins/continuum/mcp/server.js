#!/usr/bin/env node
// Continuum MCP server — exposes chain recall as an MCP tool so any client
// (Claude Code, etc.) can search past links without the /continuum:recall slash
// command. Zero dependencies by design: a minimal newline-delimited JSON-RPC
// stdio loop (the MCP stdio framing), not the SDK — the continuum plugin ships
// without node_modules and must stay bundle-free.
//
// Speaks: initialize, notifications/initialized, tools/list, tools/call(recall),
// ping. Everything else returns a JSON-RPC "method not found" for requests and
// is ignored for notifications.

import { recall, formatRecallForHuman } from "../lib/recall.js";

const SERVER_INFO = { name: "continuum", version: "0.5.0" };
const DEFAULT_PROTOCOL = "2025-03-26";

const RECALL_TOOL = {
  name: "recall",
  description:
    "Search the continuum context chain (past decision links, including archived/rolled-up ones) by keyword/tag. Returns scored link summaries with provenance and a staleness flag — re-verify stale hits against current code before asserting them as fact.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words/keywords to search for across link tags + summaries." },
      project_dir: { type: "string", description: "Project root containing .continuum/. Defaults to CLAUDE_PROJECT_DIR or cwd." },
      limit: { type: "number", description: "Max hits to return (default 5)." },
      tags: { type: "array", items: { type: "string" }, description: "Restrict to links whose tags overlap these." },
    },
    required: ["query"],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name !== "recall") {
    // MCP convention: tool errors come back as a result with isError:true, not a
    // protocol error, so the model can read and recover from them.
    result(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
    return;
  }
  try {
    const projectDir = args.project_dir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const res = recall({
      projectDir,
      query: args.query,
      limit: typeof args.limit === "number" ? args.limit : 5,
      tags: Array.isArray(args.tags) ? args.tags : null,
    });
    result(id, {
      content: [{ type: "text", text: formatRecallForHuman(res) }],
      structuredContent: res,
      isError: false,
    });
  } catch (e) {
    result(id, { content: [{ type: "text", text: `recall failed: ${String(e?.message ?? e)}` }], isError: true });
  }
}

function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;
  // Notifications (no id) — acknowledge by doing nothing.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      result(id, {
        // Echo the client's protocol version when given (standard negotiation),
        // else advertise our default.
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, { tools: [RECALL_TOOL] });
      return;
    case "tools/call":
      handleToolCall(id, params);
      return;
    default:
      error(id, -32601, `method not found: ${method}`);
      return;
  }
}

// Newline-delimited JSON-RPC over stdin. Buffer across chunks; dispatch complete
// lines as they arrive.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { handleMessage(msg); } catch { /* never let one message kill the loop */ }
  }
});
process.stdin.on("end", () => {
  const line = buf.trim();
  if (line) {
    try { handleMessage(JSON.parse(line)); } catch {}
  }
  process.exit(0);
});

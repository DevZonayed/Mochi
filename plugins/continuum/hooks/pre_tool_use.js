#!/usr/bin/env node
// PreToolUse: fires before EVERY tool call (built-in or MCP, with matcher "*").
// Drains the Mochi popup-message inbox for this session and injects whatever
// the user queued as a system reminder via hookSpecificOutput.additionalContext.
// Claude reads it before deciding on its next tool — so the message lands
// without interrupting the agent mid-thought.
//
// Hot path: this runs on every tool call. Fast-skips via sentinel file
// (.continuum/.inbox-flag, written by the broker on push, deleted on drain).
// If no sentinel → exit 0 with no body (~1ms).

import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { drainInbox } from "../lib/broker.js";
import { formatHints } from "../lib/hint_formatter.js";
import { appendEvent } from "../lib/telemetry_log.js";
import { redactEvent } from "../lib/telemetry_redact.js";
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { getInstallId } from "../lib/install_id.js";

async function readStdin() {
  return new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(d), 100);
  });
}

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: text,
    },
  }));
  process.exit(0);
}


async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let sessionId = payload.session_id || null;

  // [telemetry Arm-1] Record this tool call FIRST, unconditionally, BEFORE the
  // sentinel fast-skip below (§13.7). Hot-path safe: one synchronous JSONL line,
  // NO network/LLM. killSwitch "off" disables capture too (§7). Never throws.
  try {
    const tcfg = readTelemetryConfig(projectDir);
    if (tcfg.killSwitch !== "off") {
      const rawTool = String(payload.tool_name || payload.toolName || "");
      let tool = rawTool, mcp = "";
      const mm = rawTool.match(/^mcp__plugin_([a-z0-9_]+?)__(.+)$/i);
      if (mm) { mcp = mm[1]; tool = mm[2]; }
      appendEvent(projectDir, redactEvent({
        ts: Math.floor(Date.now() / 1000),
        sid: sessionId || "",
        iid: getInstallId(),
        tool, mcp,
        ok: true,            // PreToolUse precedes the result; ok/err set by PostToolUse
        err: "",
        dur_b: "",
        v: process.env.MOCHI_PLUGIN_VERSION || "0.7.0",
        os: process.platform,
      }));
    }
  } catch {}

  // Fast-skip: if no sentinel, no message — exit ~immediately.
  const sentinel = path.join(projectDir, ".continuum", ".inbox-flag");
  if (!fs.existsSync(sentinel)) { process.exit(0); return; }

  // Recover sessionId from the file SessionStart writes, if not in stdin.
  if (!sessionId) {
    try {
      const p = paths(projectDir);
      if (fs.existsSync(p.sessionIdFile)) sessionId = fs.readFileSync(p.sessionIdFile, "utf8").trim();
    } catch {}
  }
  if (!sessionId) { process.exit(0); return; }

  const { messages } = await drainInbox({ sessionId });
  if (!messages || !messages.length) {
    // Self-clean the sentinel if the broker didn't (e.g. session not
    // registered on the broker side — orphan flag from a prior run). Without
    // this, every tool call would re-hit HTTP for nothing.
    try { fs.unlinkSync(sentinel); } catch {}
    process.exit(0); return;
  }

  emit(formatHints(messages, projectDir, sessionId));
}

main().catch((err) => {
  process.stderr.write(`[continuum:pre_tool_use] ${err?.message ?? err}\n`);
  process.exit(0);
});

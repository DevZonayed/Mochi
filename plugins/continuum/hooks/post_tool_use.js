#!/usr/bin/env node
// PostToolUse: if the agent just wrote/edited a frontend file, emit a
// directive telling it to verify the change at the configured viewport
// breakpoints using Mochi's browser MCP tools (before declaring complete).
// Also append a record to .continuum/.frontend-changes.jsonl so the next
// /continuum:checkpoint can surface verification status into the link.
//
// Pure side-effect when the edit is non-frontend or frontend_verify is off.

import { readConfig } from "../lib/paths.js";
import { matchAny } from "../lib/glob.js";
import { recordChange } from "../lib/verification_log.js";
import { appendEvent } from "../lib/telemetry_log.js";
import { redactEvent } from "../lib/telemetry_redact.js";
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { getInstallId } from "../lib/install_id.js";

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Map a tool_response into a coarse Zone-A error category — NEVER the raw text.
const ERR_PATTERNS = [
  [/time(d)? ?out|deadline exceeded|etimedout/i, "timeout"],
  [/not found|no such|enoent|404|missing/i, "not_found"],
  [/permission|denied|forbidden|eacces|401|403/i, "permission"],
  [/network|econnrefused|econnreset|enotfound|dns|socket/i, "network"],
  [/invalid|bad request|malformed|parse|400|unexpected/i, "bad_input"],
];
function classifyResponse(resp) {
  const s = typeof resp === "string" ? resp : (resp == null ? "" : JSON.stringify(resp));
  if (!s) return { ok: true, err: "" };
  const looksError = /error|fail|exception|denied|timeout|refused|invalid|not found/i.test(s);
  if (!looksError) return { ok: true, err: "" };
  for (const [re, cat] of ERR_PATTERNS) if (re.test(s)) return { ok: false, err: cat };
  return { ok: false, err: "other" };
}

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
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  }));
  process.exit(0);
}

function rel(projectDir, p) {
  if (!p) return p;
  if (p.startsWith(projectDir + "/")) return p.slice(projectDir.length + 1);
  return p;
}

async function main() {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const toolName = payload.tool_name || payload.toolName || "";

  // [telemetry Arm-1] Record the RESULT of this tool call FIRST, BEFORE the
  // FILE_EDIT_TOOLS early-return below (§13.7) — so every tool's ok/err category
  // is captured, not just file edits. Hot-path safe, no network, never throws.
  try {
    const tcfg = readTelemetryConfig(projectDir);
    if (tcfg.killSwitch !== "off") {
      const rawTool = String(toolName);
      let tool = rawTool, mcp = "";
      const mm = rawTool.match(/^mcp__plugin_([a-z0-9_]+?)__(.+)$/i);
      if (mm) { mcp = mm[1]; tool = mm[2]; }
      const { ok, err } = classifyResponse(payload.tool_response ?? payload.toolResponse);
      appendEvent(projectDir, redactEvent({
        ts: Math.floor(Date.now() / 1000),
        sid: payload.session_id || "",
        iid: getInstallId(),
        tool, mcp, ok, err,
        dur_b: "",
        v: process.env.MOCHI_PLUGIN_VERSION || "0.7.0",
        os: process.platform,
      }));
    }
  } catch {}

  if (!FILE_EDIT_TOOLS.has(toolName)) { process.exit(0); return; }

  // tool_input shape: { file_path: "...", ... } for Write/Edit/MultiEdit
  const input = payload.tool_input || payload.toolInput || {};
  const filePath = input.file_path || input.notebook_path || null;
  if (!filePath || typeof filePath !== "string") { process.exit(0); return; }

  const cfg = readConfig(projectDir);
  if (cfg.frontend_verify === false) { process.exit(0); return; }
  const relPath = rel(projectDir, filePath);

  const globs = Array.isArray(cfg.frontend_globs) && cfg.frontend_globs.length
    ? cfg.frontend_globs : ["src/**/*.{tsx,jsx,vue,svelte,css}"];
  if (!matchAny(relPath, globs)) { process.exit(0); return; }

  recordChange(projectDir, { filePath: relPath, tool: toolName });

  const breakpoints = Array.isArray(cfg.frontend_breakpoints_px) && cfg.frontend_breakpoints_px.length
    ? cfg.frontend_breakpoints_px : [375, 768, 1280];

  const lines = [];
  lines.push(`**Frontend file edited: \`${relPath}\`** — before you declare this complete, verify it visually.`);
  lines.push("");
  lines.push("If a Mochi browser session is active (or you can start one), run this verification loop:");
  lines.push("");
  lines.push("1. Identify the URL where this change manifests (dev server URL — ask the user if you don't have it).");
  for (let i = 0; i < breakpoints.length; i++) {
    const bp = breakpoints[i];
    lines.push(`${i + 2}. \`mcp__browser__browser_emulate_viewport({ width: ${bp}, height: ${Math.round(bp * 0.75)} })\` → \`browser_navigate(url)\` → \`browser_screenshot()\` → \`browser_console_messages({ level: "error" })\`.`);
  }
  lines.push("");
  lines.push("Record each viewport's outcome (pass/fail + a one-line note) and report back. Failures should become open threads in the next `/continuum:checkpoint` so they survive into the next session.");
  lines.push("");
  lines.push(`_continuum: this change is logged at \`.continuum/.frontend-changes.jsonl\`. \`/continuum:checkpoint\` will surface its verification status into the new link automatically._`);

  emit(lines.join("\n"));
}

main().catch(() => process.exit(0));

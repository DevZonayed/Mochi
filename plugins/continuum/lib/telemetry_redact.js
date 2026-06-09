// telemetry_redact.js — THE privacy keystone (spec §13.1/§13.2), FAIL-CLOSED.
//
// Every Zone-A object that may leave the machine passes through here, AND the
// SAME serializer powers `/mochi:telemetry show` (§13.1 N2) so the audit is
// byte-for-byte what would POST. Rules:
//   - WHITELIST keys: only known Zone-A keys survive; unknown keys are DROPPED.
//   - tool/mcp are CONTENT: any name not in the allowlist -> the literal
//     "thirdparty_tool"/"thirdparty_mcp" (never the real name) — protects client
//     codenames, private MCP server names, internal hostnames (§13.1 B1).
//   - every categorical (err/task_category/redundancy_pattern/suggestion_tag/
//     severity) is COERCED to value-in-enum, else "other" (§13.1 B2/M2).
//   - suggestion_text + quality_issue are Zone-B ALWAYS — never whitelisted,
//     never emitted, even if present in the input.
//   - NO `model` field (§13.6).

// ── shipped enums (small fixed sets, each with an "other" bucket) ────────────
export const ERR_ENUM = ["timeout", "not_found", "bad_input", "permission", "network", "other"];
export const TASK_ENUM = ["web-qa", "coding", "refactor", "debug", "research", "docs", "comms", "other"];
export const REDUNDANCY_ENUM = ["snapshot_then_retry", "repeated_read", "repeated_edit", "retry_loop", "redundant_navigation", "none", "other"];
export const SUGGESTION_ENUM = ["batch_clicks", "use_recall", "fewer_snapshots", "assert_first", "narrower_selector", "reuse_workflow", "none", "other"];
export const SEVERITY_ENUM = ["low", "medium", "high", "other"];

// ── first-party allowlists (mochi/built-in names) ───────────────────────────
// Built-in Claude Code tools + mochi plugin tool short-names. Anything else is
// bucketed. Keep this conservative: when in doubt, bucket.
export const ALLOW_TOOLS = [
  // built-in tools
  "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Task", "WebFetch", "WebSearch",
  "NotebookEdit", "TodoWrite", "MultiEdit",
  // mochi browser MCP (short names, mcp prefix stripped before lookup)
  "browser_navigate", "browser_click", "browser_click_at", "browser_type", "browser_snapshot",
  "browser_snapshot_query", "browser_evaluate", "browser_screenshot", "browser_wait",
  "browser_assert", "browser_assert_no_errors", "browser_console_messages",
  "browser_network_requests", "browser_scroll", "browser_press_key", "browser_links",
  "browser_text", "browser_session_start", "browser_session_end",
  // mochi comms MCP
  "comms_link_account", "comms_account_status", "comms_list_chats", "comms_list_groups",
  "comms_get_messages", "comms_recall", "comms_set_allowlist", "comms_sync_now",
  "comms_import_history", "comms_unlink_account",
  // continuum recall + session signals
  "recall", "session_close", "session_compact",
];
export const ALLOW_MCPS = ["mochi_browser", "mochi_comms", "mochi_continuum", "continuum"];

// ── helpers ──────────────────────────────────────────────────────────────────
function coerceEnum(value, enumList) {
  return enumList.includes(value) ? value : "other";
}

// Strip the mcp__plugin_<server>__ / mcp__<server>__ prefix to compare the bare
// tool name against ALLOW_TOOLS; the prefix itself is never used as a value.
function bareToolName(tool) {
  if (typeof tool !== "string") return "";
  const m = /^mcp__(?:plugin_)?[^_]+(?:_[^_]+)*?__(.+)$/.exec(tool);
  return m ? m[1] : tool;
}

function bucketTool(tool) {
  const bare = bareToolName(tool);
  return ALLOW_TOOLS.includes(bare) ? bare : "thirdparty_tool";
}

function bucketMcp(mcp) {
  if (typeof mcp !== "string" || mcp === "") return ""; // built-in tools have no mcp
  return ALLOW_MCPS.includes(mcp) ? mcp : "thirdparty_mcp";
}

// err is NEVER a raw message. Map a known enum value through; otherwise drop the
// raw string entirely and emit "other" (a best-effort categorize is allowed only
// for a SMALL set of unambiguous tokens, and only the ENUM word is kept).
function coerceErr(err) {
  if (ERR_ENUM.includes(err)) return err;
  if (typeof err !== "string" || err === "") return err === "" ? "" : "other";
  const s = err.toLowerCase();
  if (s.includes("etimedout") || s.includes("timeout") || s.includes("timed out")) return "timeout";
  if (s.includes("enoent") || s.includes("not found") || s.includes("404")) return "not_found";
  if (s.includes("eacces") || s.includes("permission") || s.includes("forbidden") || s.includes("403")) return "permission";
  if (s.includes("econnrefused") || s.includes("econnreset") || s.includes("network") || s.includes("dns") || s.includes("socket")) return "network";
  if (s.includes("invalid") || s.includes("bad request") || s.includes("400") || s.includes("malformed")) return "bad_input";
  return "other"; // raw string discarded — only the enum word ever survives
}

function toBool(v) { return v === true; }

function toIntOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function str(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

// ── public API ────────────────────────────────────────────────────────────
// redactEvent(raw) -> Zone-A event with EXACTLY these keys (no model).
export function redactEvent(raw) {
  const r = raw || {};
  return {
    ts: toIntOr(r.ts, 0),
    sid: str(r.sid),
    iid: str(r.iid),
    tool: bucketTool(r.tool),
    mcp: bucketMcp(r.mcp),
    ok: toBool(r.ok),
    err: coerceErr(r.err),
    dur_b: str(r.dur_b),
    v: str(r.v),
    os: str(r.os),
  };
}

// redactDistillation(raw) -> Zone-A distillation. suggestion_text + quality_issue
// are Zone-B and are NEVER read into the output.
export function redactDistillation(raw) {
  const r = raw || {};
  return {
    task_category: coerceEnum(r.task_category, TASK_ENUM),
    tool_calls: toIntOr(r.tool_calls, 0),
    efficiency_score: clamp01(r.efficiency_score),
    redundancy_pattern: coerceEnum(r.redundancy_pattern, REDUNDANCY_ENUM),
    suggestion_tag: coerceEnum(r.suggestion_tag, SUGGESTION_ENUM),
    severity: coerceEnum(r.severity, SEVERITY_ENUM),
  };
}

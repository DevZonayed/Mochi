// telemetry-server/telemetry_redact.js
// Server-side COPY of the plugin's Zone-A redactor (telemetry-server is separate
// infra — it must not import plugin code). Privacy keystone + defense-in-depth
// (§13.1, §13.5): a tampered client can POST anything, so the server re-applies
// the identical whitelist/enum/allowlist logic before any write. Fail-closed.
// Enums are byte-identical to plugins/continuum/lib/telemetry_redact.js.

export const ERR_ENUM = ["timeout", "not_found", "bad_input", "permission", "network", "other"];
export const TASK_ENUM = ["web-qa", "coding", "refactor", "debug", "research", "docs", "comms", "other"];
export const REDUNDANCY_ENUM = ["snapshot_then_retry", "repeated_read", "repeated_edit", "retry_loop", "redundant_navigation", "none", "other"];
export const SUGGESTION_ENUM = ["batch_clicks", "use_recall", "fewer_snapshots", "assert_first", "narrower_selector", "reuse_workflow", "none", "other"];
export const SEVERITY_ENUM = ["low", "medium", "high", "other"];

export const ALLOW_MCPS = new Set(["mochi_browser", "mochi_comms", "mochi_continuum", "continuum"]);
export const ALLOW_TOOLS = new Set([
  "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Task", "WebFetch", "WebSearch",
  "NotebookEdit", "TodoWrite", "MultiEdit",
  "browser_navigate", "browser_click", "browser_click_at", "browser_type", "browser_snapshot",
  "browser_snapshot_query", "browser_evaluate", "browser_screenshot", "browser_wait",
  "browser_assert", "browser_assert_no_errors", "browser_console_messages",
  "browser_network_requests", "browser_scroll", "browser_press_key", "browser_links",
  "browser_text", "browser_session_start", "browser_session_end",
  "comms_link_account", "comms_account_status", "comms_list_chats", "comms_list_groups",
  "comms_get_messages", "comms_recall", "comms_set_allowlist", "comms_sync_now",
  "comms_import_history", "comms_unlink_account",
  "recall", "session_close", "session_compact",
]);

export const ZONE_A_EVENT_KEYS = ["ts", "sid", "iid", "tool", "mcp", "ok", "err", "dur_b", "v", "os"];
export const ZONE_A_DISTILL_KEYS = ["task_category", "tool_calls", "efficiency_score", "redundancy_pattern", "suggestion_tag", "severity"];

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x, max = 64) => (typeof x === "string" ? x.slice(0, max) : String(x ?? "").slice(0, max));
const enumOrOther = (x, enumArr) => (enumArr.includes(x) ? x : "other");
const numOr = (x, fb) => { const n = typeof x === "number" ? x : Number(x); return Number.isFinite(n) ? n : fb; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function bucketTool(t) { return ALLOW_TOOLS.has(t) ? t : "thirdparty_tool"; }
function bucketMcp(m) { return m === "" ? "" : (ALLOW_MCPS.has(m) ? m : "thirdparty_mcp"); }

export function redactEvent(raw) {
  if (!isObj(raw)) return null;
  return {
    ts: Math.trunc(numOr(raw.ts, 0)),
    sid: str(raw.sid, 64),
    iid: str(raw.iid, 64),
    tool: bucketTool(str(raw.tool, 80)),
    mcp: bucketMcp(str(raw.mcp, 80)),
    ok: raw.ok === true || raw.ok === "true",
    err: str(raw.err) === "" ? "" : enumOrOther(raw.err, ERR_ENUM),
    dur_b: str(raw.dur_b, 16),
    v: str(raw.v, 24),
    os: str(raw.os, 24),
  };
}

export function redactDistillation(raw) {
  if (!isObj(raw)) return null;
  return {
    task_category: enumOrOther(raw.task_category, TASK_ENUM),
    tool_calls: Math.trunc(clamp(numOr(raw.tool_calls, 0), 0, 100000)),
    efficiency_score: clamp(numOr(raw.efficiency_score, 0), 0, 1),
    redundancy_pattern: enumOrOther(raw.redundancy_pattern, REDUNDANCY_ENUM),
    suggestion_tag: enumOrOther(raw.suggestion_tag, SUGGESTION_ENUM),
    severity: enumOrOther(raw.severity, SEVERITY_ENUM),
  };
}

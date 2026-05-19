// MCP tool definitions + dispatcher.
// Production-grade behavior:
//   - Selector cache lives in SQLite (memory.js). click/type write the cache
//     when given an `intent`, and the agent can ask via `browser_recall_selector`.
//   - Every successful action inside a session is auto-traced. The agent can
//     call browser_workflow_save to persist the trace as a named workflow.
//   - browser_workflow_run replays a workflow with cached selectors first,
//     falling back to role/name self-healing on miss.

import { randomUUID } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import { Memory } from "./memory.js";
import { SessionTrace } from "./trace.js";
import { originOf } from "./origin.js";
import { stage as stageUpload, uploadErr, uploadsDir, gcSession, readIndex } from "./uploads.js";

// ---------------- shared state (one process = one server) ----------------

let memory = null;
const trace = new SessionTrace();
let lastKnownUrl = null;     // most recent URL we saw from any action
let activeOrigin = null;     // origin derived from lastKnownUrl
const serverStartedAt = Date.now();

const DEFAULT_SNAPSHOT_MODE = "compact";
const DEFAULT_SNAPSHOT_SCOPE = "viewport";
const DEFAULT_SNAPSHOT_MAX_BYTES = 12000;
const DEFAULT_SNAPSHOT_MAX_DEPTH = 8;
const DEFAULT_SNAPSHOT_TEXT_LIMIT = 120;
const DEFAULT_SNAPSHOT_INCLUDE_BOXES = "interactive";
const SNAPSHOT_STORE_LIMIT = 8;

const snapshotStore = new Map();
let latestSnapshotId = null;

export function initToolsState({ log } = {}) {
  if (!memory) memory = new Memory({ log });
  return { memory, trace };
}

function noteUrl(url) {
  if (!url) return;
  lastKnownUrl = url;
  const o = originOf(url);
  if (o) activeOrigin = o;
}

// ---------------- tool definitions ----------------

export const tools = [
  // --- session lifecycle ---
  {
    name: "browser_session_start",
    description:
      "Start a new browser session. Creates a Chrome tab group with an initial tab; all subsequent operations are scoped to that group. Pass newWindow=true to spawn a fresh Chrome window so window-resize won't disturb the user's other tabs. By default the session tab is brought to the foreground — hidden tabs are throttled by Chrome and SPAs may never finish rendering. Pass bringToFront:false to keep the user's current tab in front. Idempotent: ends a previous session first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", default: "AI Session" },
        color: { type: "string", enum: ["grey","blue","red","yellow","green","pink","purple","cyan","orange"], default: "blue" },
        url:   { type: "string", default: "about:blank" },
        newWindow: { type: "boolean", default: false },
        width:  { type: "number" }, height: { type: "number" },
        left:   { type: "number" }, top: { type: "number" },
        state:  { type: "string", enum: ["normal","maximized","minimized","fullscreen"] },
        bringToFront: { type: "boolean", default: true, description: "Make the session tab the foreground tab in its window. Default true so SPAs aren't throttled by Chrome's hidden-tab budget." },
        visuals: {
          type: "object",
          description: "Visual feedback layer (animated cursor + target ring + HUD). Defaults: enabled with cursor + hud; slowMo:0.",
          properties: {
            enabled: { type: "boolean", default: true,  description: "Master switch — false skips overlay injection." },
            cursor:  { type: "boolean", default: true,  description: "Show animated cursor + target ring + click ripple (visually coupled)." },
            hud:     { type: "boolean", default: true,  description: "Show top-center action narration pill." },
            slowMo:  { type: "number",  default: 0, minimum: 0, maximum: 5000, description: "Per-action dwell time in ms after the CDP call. 0 = no wait." },
          },
        },
      },
    },
  },
  {
    name: "browser_session_end",
    description: "End the current session. Detaches debugger, ungroups tabs (default) or closes them.",
    inputSchema: { type: "object", properties: { closeTabs: { type: "boolean", default: false } } },
  },

  // --- navigation + tabs ---
  {
    name: "browser_navigate",
    description: "Navigate the active session tab to a URL and wait for load. Brings the tab to the foreground by default to avoid Chrome's hidden-tab throttling (SPAs may never finish rendering otherwise). Pass bringToFront:false to keep the user's current tab in front.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        tabId: { type: "number" },
        bringToFront: { type: "boolean", default: true, description: "Make the session tab the foreground tab in its window before loading." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_open_tab",
    description: "Open a new tab inside the session's tab group.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", default: "about:blank" },
        active: { type: "boolean", default: false },
        makePrimary: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "browser_list_tabs",
    description: "List tabs in the current session group.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close_tab",
    description: "Close a specific session tab (cannot close the primary tab).",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] },
  },

  // --- introspection ---
  {
    name: "browser_snapshot",
    description:
      "Capture an ARIA-flavored accessibility tree with stable refs and pixel boxes. Compact by default: viewport-only, redacted, depth-limited, and capped to 12KB. Use refs for browser_click/browser_type. Pass mode='full' only when you intentionally need the uncapped page tree.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        mode: { type: "string", enum: ["compact","full"], default: DEFAULT_SNAPSHOT_MODE, description: "compact applies safe defaults; full skips compacting unless explicit options are passed." },
        scope: { type: "string", enum: ["all","viewport"], default: DEFAULT_SNAPSHOT_SCOPE, description: "viewport drops nodes whose box is fully outside the visible area." },
        maxBytes: { type: "number", default: DEFAULT_SNAPSHOT_MAX_BYTES, description: "Cap on the JSON-serialized result size. Excess subtrees are pruned and `truncated:true` is set. Use 0 with mode='full' for no cap." },
        maxDepth: { type: "number", default: DEFAULT_SNAPSHOT_MAX_DEPTH, description: "Compact mode depth limit before child subtrees are summarized." },
        textLimit: { type: "number", default: DEFAULT_SNAPSHOT_TEXT_LIMIT, description: "Compact mode character limit for name/text fields." },
        includeBoxes: { type: "string", enum: ["all","interactive","none"], default: DEFAULT_SNAPSHOT_INCLUDE_BOXES, description: "Compact mode box retention. interactive keeps boxes only for actionable or semantic nodes." },
        redact: { type: "boolean", default: true, description: "Replace likely-secret strings with [REDACTED]. Defaults to true in compact mode." },
        store: { type: "boolean", default: true, description: "Store the raw snapshot in this MCP process for browser_snapshot_query/browser_snapshot_node drilldown." },
      },
    },
  },
  {
    name: "browser_text",
    description:
      "Return compact visible text lines from the page. Prefer this before browser_snapshot when you need to read/search page content without flooding context.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        query: { type: "string", description: "Optional case-insensitive substring filter." },
        limit: { type: "number", default: 80, description: "Maximum lines returned (capped at 300)." },
        maxChars: { type: "number", default: 6000, description: "Maximum total characters returned (capped at 20000)." },
      },
    },
  },
  {
    name: "browser_links",
    description:
      "Return compact visible links from the page with text, href, and best-effort selector refs. Useful for navigation choices without a full snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        query: { type: "string", description: "Optional case-insensitive filter over link text or href." },
        limit: { type: "number", default: 50, description: "Maximum links returned (capped at 200)." },
      },
    },
  },
  {
    name: "browser_snapshot_query",
    description:
      "Search the latest stored browser_snapshot tree by text/name/role/ref/tag and return tiny matching excerpts plus paths. Use this to drill into a compact snapshot instead of requesting a full page tree.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotId: { type: "string", description: "Defaults to the latest stored snapshot." },
        text: { type: "string", description: "Case-insensitive substring match against name/text/descendant text." },
        role: { type: "string", description: "Case-insensitive role match." },
        tag: { type: "string", description: "Case-insensitive tag match." },
        ref: { type: "string", description: "Exact ref/selector match." },
        limit: { type: "number", default: 20 },
        maxDepth: { type: "number", default: 2, description: "Depth for each returned excerpt." },
        maxBytes: { type: "number", default: 8000 },
        redact: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "browser_snapshot_node",
    description:
      "Return a compact subtree from the latest stored browser_snapshot by ref, text, or path from browser_snapshot_query. Use for targeted drilldown.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotId: { type: "string", description: "Defaults to the latest stored snapshot." },
        ref: { type: "string", description: "Exact ref/selector to return." },
        text: { type: "string", description: "First node whose name/text/descendant text contains this value." },
        path: { type: "string", description: "Dot-separated child path returned by browser_snapshot_query, e.g. '0.3.1'." },
        maxDepth: { type: "number", default: 4 },
        maxBytes: { type: "number", default: 10000 },
        redact: { type: "boolean", default: true },
      },
    },
  },

  // --- input ---
  {
    name: "browser_click",
    description:
      "Click an element by CSS selector via real CDP mouse events. Pass `intent` (e.g. \"click login button\") to cache the selector for this origin so future calls can skip snapshotting. The cached entry survives Chrome restarts.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "CSS selector (use refs from browser_snapshot)" },
        intent: { type: "string", description: "Plain-English description of what this click does. Cached per (origin, intent) for fast replay." },
        button: { type: "string", enum: ["left","right","middle"], default: "left" },
        clickCount: { type: "number", default: 1 },
        tabId: { type: "number" },
      },
      required: ["ref"],
    },
  },
  {
    name: "browser_click_at",
    description: "Click at exact CSS pixel coordinates (viewport-relative). Useful with screenshots when no good selector exists.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" }, y: { type: "number" },
        button: { type: "string", enum: ["left","right","middle"], default: "left" },
        clickCount: { type: "number", default: 1 },
        tabId: { type: "number" },
      },
      required: ["x","y"],
    },
  },
  {
    name: "browser_type",
    description: "Focus + clear + insertText. Optional `submit` presses Enter. Pass `intent` to cache the selector.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        intent: { type: "string", description: "What this field is for, e.g. \"email field\". Cached per (origin, intent)." },
        submit: { type: "boolean", default: false },
        clear: { type: "boolean", default: true },
        tabId: { type: "number" },
      },
      required: ["ref","text"],
    },
  },
  {
    name: "browser_press_key",
    description: "Dispatch a real keyboard event via CDP.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, tabId: { type: "number" } },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the active session tab. Pass {x,y} for absolute or {deltaX,deltaY} for relative.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", default: 0 }, y: { type: "number", default: 0 },
        deltaX: { type: "number", default: 0 }, deltaY: { type: "number", default: 0 },
        tabId: { type: "number" },
      },
    },
  },

  // --- history + sleep ---
  { name: "browser_go_back", description: "History back.",    inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  { name: "browser_go_forward", description: "History forward.", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } },
  {
    name: "browser_wait",
    description: "Sleep up to 60 seconds.",
    inputSchema: { type: "object", properties: { ms: { type: "number", default: 1000 } } },
  },

  // --- visuals ---
  {
    name: "browser_screenshot",
    description:
      "PNG/JPEG screenshot of the session tab (CDP-based; works whether the tab is foreground or background). Modes: viewport (default), fullPage, elementRef.",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean", default: false },
        elementRef: { type: "string" },
        format: { type: "string", enum: ["png","jpeg"], default: "png" },
        tabId: { type: "number" },
      },
    },
  },

  // --- viewport / window ---
  {
    name: "browser_window_resize",
    description: "Resize/move/maximize the session's Chrome window (affects whole window).",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number" }, height: { type: "number" },
        left: { type: "number" }, top: { type: "number" },
        state: { type: "string", enum: ["normal","maximized","minimized","fullscreen"] },
        windowId: { type: "number" },
      },
    },
  },
  {
    name: "browser_emulate_viewport",
    description: "Programmatic Device Mode via CDP (viewport + DPR + mobile/UA). Preset or width/height.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["iphone-15-pro","iphone-se","pixel-7","ipad","desktop-hd","desktop-fhd","desktop-2k"] },
        width: { type: "number" }, height: { type: "number" },
        deviceScaleFactor: { type: "number" },
        mobile: { type: "boolean" },
        userAgent: { type: "string" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "browser_clear_emulation",
    description: "Clear viewport / UA / touch emulation overrides.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
  },

  // --- assertions ---
  {
    name: "browser_assert",
    description:
      "Assert a condition is true on the page. Returns {ok, got}. Kinds: url-contains, url-equals, title-contains, element-exists, element-missing, text-contains, text-equals (text kinds need a target selector; element kinds too).",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["url-contains","url-equals","title-contains","element-exists","element-missing","text-contains","text-equals"],
        },
        target: { type: "string", description: "CSS selector for element/text kinds" },
        value: { type: "string", description: "Expected value (URL fragment, text, etc.)" },
        intent: { type: "string", description: "Optional human description for the trace/workflow." },
        tabId: { type: "number" },
      },
      required: ["kind"],
    },
  },

  // --- diagnostics + observability ---
  {
    name: "browser_session_health",
    description:
      "Diagnostic snapshot of the bridge + active session: bridge mode, extension connectivity, current URL/origin, in-memory trace length, server uptime, MCP client count. Use when something feels stuck before reaching for browser_session_end.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_evaluate",
    description:
      "Execute JavaScript in the active tab via CDP Runtime.evaluate. Returns a serialized value (or {ok:false,error} on exception). Useful for shadow-DOM traversal, reading window state, or programmatic clicks when extensions intercept the synthetic mouse events. The expression is run in the page context as a real user gesture.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JS expression. Wrap statements in an IIFE if needed: `(()=>{ ... return value; })()`." },
        awaitPromise: { type: "boolean", default: true, description: "If the expression returns a Promise, await it before returning." },
        returnByValue: { type: "boolean", default: true, description: "Serialize the result. Set false to get an opaque objectId for later use (rare)." },
        timeoutMs: { type: "number", default: 5000 },
        tabId: { type: "number" },
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_console_messages",
    description:
      "Recent browser console + uncaught exceptions for the active tab. Capture starts when the session attaches CDP (eagerly on session_start). Returns the last N messages, optionally filtered by level or timestamp. Pass clear=true to drain.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        level: { type: "string", description: "Filter: log | info | warn | error | debug." },
        since: { type: "number", description: "Unix-ms timestamp; only messages at or after this are returned." },
        limit: { type: "number", default: 100, description: "Max messages returned (capped at 500)." },
        clear: { type: "boolean", default: false, description: "Empty the buffer after returning." },
      },
    },
  },
  {
    name: "browser_network_requests",
    description:
      "Recent XHR / fetch / document / asset requests for the active tab. Returns method, URL, status, mime, duration, success/failure. Filter by URL substring, method, status range, or failedOnly. Body capture is opt-in via includeRequestHeaders / includeResponseHeaders.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        urlContains: { type: "string" },
        method: { type: "string", description: "GET, POST, etc. Case-insensitive." },
        statusGte: { type: "number" },
        statusLt: { type: "number" },
        failedOnly: { type: "boolean", default: false, description: "Only requests that errored or returned >=400." },
        includeRequestHeaders: { type: "boolean", default: false },
        includeResponseHeaders: { type: "boolean", default: false },
        limit: { type: "number", default: 50, description: "Max entries returned (capped at 200)." },
      },
    },
  },

  // --- selector cache ---
  {
    name: "browser_recall_selector",
    description:
      "Ask the memory if there's a known selector for this intent on the current origin. Returns null if unknown. Useful BEFORE browser_snapshot to skip discovery.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        origin: { type: "string", description: "Defaults to the current page's origin." },
      },
      required: ["intent"],
    },
  },
  {
    name: "browser_forget_selector",
    description: "Drop a cached selector (origin defaults to current).",
    inputSchema: {
      type: "object",
      properties: { intent: { type: "string" }, origin: { type: "string" } },
      required: ["intent"],
    },
  },
  {
    name: "browser_list_selectors",
    description: "List cached selectors. Pass `origin` to filter (defaults to current).",
    inputSchema: {
      type: "object",
      properties: { origin: { type: "string" }, all: { type: "boolean", default: false } },
    },
  },

  // --- workflows ---
  {
    name: "browser_workflow_save",
    description:
      "Persist the current session's auto-traced actions as a named workflow for this origin. The trace is built from successful click/type/navigate/etc. calls since session_start. Overwrites if (origin, name) exists.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        origin: { type: "string", description: "Defaults to the trace's first observed origin." },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_workflow_list",
    description: "List saved workflows. Pass `origin` to filter (defaults to current).",
    inputSchema: {
      type: "object",
      properties: { origin: { type: "string" }, all: { type: "boolean", default: false } },
    },
  },
  {
    name: "browser_workflow_get",
    description: "Get the steps of a named workflow.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, origin: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "browser_workflow_delete",
    description: "Delete a named workflow.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, origin: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "browser_workflow_run",
    description:
      "Replay a saved workflow. Returns {status, stepsTotal, stepsPassed, results:[per-step envelope]}. Steps with cached selectors run first; on selector miss, falls back to role+name self-healing and updates the cache. Stops at first failure unless continueOnError=true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        origin: { type: "string" },
        continueOnError: { type: "boolean", default: false },
        stepDelayMs: { type: "number", default: 0, description: "Sleep between steps (helps flaky pages)." },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_workflow_export",
    description: "Export a workflow as portable JSON (commit to your repo to share).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, origin: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "browser_workflow_import",
    description: "Import a workflow from JSON (the shape returned by browser_workflow_export).",
    inputSchema: {
      type: "object",
      properties: { payload: { type: "object" } },
      required: ["payload"],
    },
  },
  {
    name: "browser_run_history",
    description: "Last N runs of a workflow (status, pass/fail counts, timings).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        origin: { type: "string" },
        limit: { type: "number", default: 20 },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_upload_stage",
    description:
      "Stage a file (image/video/document) into the project's content-addressed upload library at `.continuum/uploads/`. " +
      "Accepts one of: local path, https URL, data URL, or raw base64. Returns a stashId that can be passed to browser_upload_file " +
      "(or reused across multiple uploads). Idempotent — same bytes always produce the same stashId.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "object",
          description: "Exactly one of: path, url, dataUrl, base64. Use `mime` to supplement base64.",
          properties: {
            path:    { type: "string", description: "Absolute filesystem path on this host." },
            url:     { type: "string", description: "https:// URL to fetch." },
            dataUrl: { type: "string", description: "Full data: URL (with mime + base64)." },
            base64:  { type: "string", description: "Raw base64 bytes; pair with `mime`." },
            bytes:   { type: "string", description: "Alias for `base64`." },
          },
        },
        mime: { type: "string", description: "MIME override (used when source is raw base64)." },
        name: { type: "string", description: "Friendly filename (some upload endpoints inspect form-data name)." },
        keep: { type: "string", enum: ["session", "persistent"], default: "session" },
        maxBytes: { type: "number", description: "Reject if file exceeds this many bytes. Default 50MB; hard cap 100MB." },
      },
      required: ["source"],
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Attach a file to a target on the page. Bypasses the native OS file picker via a strategy chain " +
      "(direct DOM.setFileInputFiles → file-chooser intercept → drag-drop synthesis → paste synthesis). " +
      "Source can be a stashId from browser_upload_stage OR inline (path/url/dataUrl/base64). " +
      "Target can be a CSS selector, accessibility ref, visible trigger element, or auto-detected from a nearby anchor.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },

        stashId: { type: "string" },
        path:    { type: "string" },
        url:     { type: "string" },
        dataUrl: { type: "string" },
        base64:  { type: "string" },
        bytes:   { type: "string", description: "Alias for `base64`." },
        mime:    { type: "string" },
        name:    { type: "string" },
        files:   { type: "array", description: "For multi-file inputs: array of source descriptors (each like the inline fields above OR { stashId })." },

        selector: { type: "string" },
        ref:      { type: "string" },
        trigger:  { type: "object", properties: { selector: { type: "string" }, ref: { type: "string" } } },
        auto:     { type: "object", properties: { near: { type: "string", description: "ref or selector" } } },

        strategies: {
          type: "array",
          items: { type: "string", enum: ["direct", "intercept", "drop", "paste"] },
          default: ["direct", "intercept", "drop", "paste"],
        },
        frames:         { type: "string", description: '"all" | "top" | <frameId>', default: "all" },
        dispatchEvents: { type: "array", items: { type: "string" }, default: ["change", "input"] },

        waitFor: {
          type: "object",
          properties: {
            mode:            { type: "string", enum: ["smart", "explicit", "none"], default: "smart" },
            timeoutMs:       { type: "number", default: 15000 },
            previewSelector: { type: "string" },
            networkPattern:  { type: "string", description: "JS regex source" },
            successSelector: { type: "string" },
          },
        },
      },
    },
  },
];

const TOOL_TO_WS_TYPE = {
  browser_session_start: "session_start",
  browser_session_end: "session_end",
  browser_navigate: "navigate",
  browser_open_tab: "open_tab",
  browser_list_tabs: "list_tabs",
  browser_close_tab: "close_tab",
  browser_snapshot: "snapshot",
  browser_text: "text",
  browser_links: "links",
  browser_click: "click",
  browser_click_at: "click_at",
  browser_type: "type",
  browser_press_key: "press_key",
  browser_scroll: "scroll",
  browser_go_back: "go_back",
  browser_go_forward: "go_forward",
  browser_wait: "wait",
  browser_screenshot: "screenshot",
  browser_window_resize: "window_resize",
  browser_emulate_viewport: "emulate_viewport",
  browser_clear_emulation: "clear_emulation",
  browser_assert: "assert",
  browser_evaluate: "evaluate",
  browser_console_messages: "console_messages",
  browser_network_requests: "network_requests",
  browser_upload_file: "upload_file",
};

// ---------------- top-level dispatch ----------------

export async function handleToolCall(bridge, params) {
  const { name, arguments: args = {} } = params;
  if (!memory) initToolsState();

  // Local tools (don't go through the bridge).
  switch (name) {
    case "browser_session_health":    return jsonResult(toolSessionHealth(bridge));
    case "browser_snapshot_query":    return jsonResult(toolSnapshotQuery(args));
    case "browser_snapshot_node":     return jsonResult(toolSnapshotNode(args));
    case "browser_recall_selector":   return jsonResult(toolRecallSelector(args));
    case "browser_forget_selector":   return jsonResult(toolForgetSelector(args));
    case "browser_list_selectors":    return jsonResult(toolListSelectors(args));
    case "browser_workflow_list":     return jsonResult(toolWorkflowList(args));
    case "browser_workflow_get":      return jsonResult(toolWorkflowGet(args));
    case "browser_workflow_delete":   return jsonResult(toolWorkflowDelete(args));
    case "browser_workflow_save":     return jsonResult(toolWorkflowSave(args));
    case "browser_workflow_export":   return jsonResult(toolWorkflowExport(args));
    case "browser_workflow_import":   return jsonResult(toolWorkflowImport(args));
    case "browser_run_history":       return jsonResult(toolRunHistory(args));
    case "browser_workflow_run":      return jsonResult(await toolWorkflowRun(bridge, args));
    case "browser_upload_stage":      return jsonResult(await toolUploadStage(args));
  }

  return jsonResult(await runWireTool(bridge, name, args));
}

async function toolUploadStage(args = {}) {
  try {
    const result = await stageUpload({
      source: args.source,
      mime: args.mime,
      name: args.name,
      keep: args.keep ?? "session",
      maxBytes: args.maxBytes,
      sessionId: currentClaudeSessionId() ?? null,
    });
    return { ok: true, ...result };
  } catch (e) {
    if (e.uploadError) return { ok: false, error: e.uploadError };
    return { ok: false, error: { code: "internal", message: String(e?.message ?? e) } };
  }
}

function currentClaudeSessionId() {
  // The active Claude session ID isn't stamped per-call yet; placeholder for future
  // wiring through bridge.localClientId or a per-request sessionId hook.
  return null;
}

function toolSessionHealth(bridge) {
  const bridgeStatus = typeof bridge.getStatus === "function" ? bridge.getStatus() : null;
  return {
    mode: bridge.mode ?? "uninitialized",
    connected: bridge.isConnected(),
    extensionAttached: bridge.mode === "broker" ? !!bridge.extensionWs : null,
    clientId: bridge.getLocalClientId() ?? null,
    mcpPeerCount: bridge.mode === "broker" ? (bridge.mcpClients?.size ?? 0) : null,
    bridgeStatus,
    activeOrigin,
    lastKnownUrl,
    traceLength: trace.size?.() ?? 0,
    traceSessionId: trace.sessionId ?? null,
    serverUptimeMs: Date.now() - serverStartedAt,
    tip: !bridge.isConnected()
      ? "Extension not connected. Make sure the Super-Tester Chrome extension is loaded and the toggle is ON."
      : (!activeOrigin
        ? "No origin tracked yet. Call browser_navigate(url) to start a real page."
        : "Healthy."),
  };
}

// ---------------- stored snapshot drilldown tools ----------------

function toolSnapshotQuery({
  snapshotId, text, role, tag, ref,
  limit = 20, maxDepth = 2, maxBytes = 8000, redact = true,
} = {}) {
  const { id, entry } = getStoredSnapshot(snapshotId);
  if (!text && !role && !tag && !ref) {
    throw new Error("browser_snapshot_query needs at least one of: text, role, tag, ref");
  }

  const query = {
    text: typeof text === "string" && text ? text.toLowerCase() : null,
    role: typeof role === "string" && role ? role.toLowerCase() : null,
    tag: typeof tag === "string" && tag ? tag.toLowerCase() : null,
    ref: typeof ref === "string" && ref ? ref : null,
  };
  const max = normalizeInt(limit, 20, 1, 100);
  const excerptDepth = normalizeInt(maxDepth, 2, 0, 8);

  let totalMatches = 0;
  const matches = [];
  walkSnapshotTree(entry.result.tree, (node, path) => {
    if (!nodeMatchesQuery(node, query)) return;
    totalMatches += 1;
    if (matches.length >= max) return;
    const excerpt = compactTree(node, {
      maxDepth: excerptDepth,
      textLimit: 180,
      includeBoxes: "interactive",
    }).tree;
    if (redact) redactTree(excerpt);
    const matchName = node.name ? String(node.name).slice(0, 180) : undefined;
    const matchText = extractNodeText(node, 300);
    matches.push({
      path: path.join("."),
      ref: node.ref ?? null,
      role: node.role ?? null,
      tag: node.tag ?? null,
      name: matchName ? (redact ? redactString(matchName) : matchName) : undefined,
      text: redact ? redactString(matchText) : matchText,
      box: node.box ?? undefined,
      excerpt,
    });
  });

  const out = {
    snapshotId: id,
    url: entry.result.url ?? null,
    title: entry.result.title ?? null,
    query: Object.fromEntries(Object.entries(query).filter(([, v]) => v != null)),
    totalMatches,
    returned: matches.length,
    matches,
  };
  fitMatchesToBudget(out, normalizeInt(maxBytes, 8000, 1000, 50000));
  return out;
}

function toolSnapshotNode({
  snapshotId, ref, text, path,
  maxDepth = 4, maxBytes = 10000, redact = true,
} = {}) {
  const { id, entry } = getStoredSnapshot(snapshotId);
  let found = null;
  let foundPath = null;

  if (typeof path === "string") {
    found = nodeAtPath(entry.result.tree, path);
    foundPath = path;
  } else if (typeof ref === "string" && ref.length > 0) {
    walkSnapshotTree(entry.result.tree, (node, p) => {
      if (found || node?.ref !== ref) return;
      found = node;
      foundPath = p.join(".");
    });
  } else if (typeof text === "string" && text.length > 0) {
    const needle = text.toLowerCase();
    walkSnapshotTree(entry.result.tree, (node, p) => {
      if (found || !nodeTextBlob(node).includes(needle)) return;
      found = node;
      foundPath = p.join(".");
    });
  } else {
    throw new Error("browser_snapshot_node needs one of: path, ref, text");
  }

  if (!found) throw new Error("matching snapshot node not found");

  const compacted = compactTree(found, {
    maxDepth: normalizeInt(maxDepth, 4, 0, 12),
    textLimit: 220,
    includeBoxes: "interactive",
  });
  const node = compacted.tree;
  if (redact) redactTree(node);

  const out = {
    snapshotId: id,
    path: foundPath ?? "",
    ref: found.ref ?? null,
    role: found.role ?? null,
    tag: found.tag ?? null,
    url: entry.result.url ?? null,
    title: entry.result.title ?? null,
    node,
    compaction: compacted.stats,
  };
  fitNodeToBudget(out, normalizeInt(maxBytes, 10000, 1000, 50000));
  return out;
}

// ---------------- low-level: send via bridge + post-process ----------------

async function runWireTool(bridge, name, args) {
  const wsType = TOOL_TO_WS_TYPE[name];
  if (!wsType) throw new Error(`unknown tool: ${name}`);

  // Lifecycle: session_start resets trace; session_end finalizes it.
  if (name === "browser_session_start") {
    trace.reset();
    activeOrigin = null;
    lastKnownUrl = null;
    const result = await bridge.send(wsType, args);
    trace.reset(result.sessionId);
    return result;
  }

  if (name === "browser_session_end") {
    const result = await bridge.send(wsType, args);
    trace.reset();
    return result;
  }

  // Strip server-only fields before sending to extension.
  const {
    intent: argIntent,
    scope: argScope,
    maxBytes: argMaxBytes,
    redact: argRedact,
    mode: argSnapshotMode,
    maxDepth: argMaxDepth,
    textLimit: argTextLimit,
    includeBoxes: argIncludeBoxes,
    store: argStore,
    ...wireArgs
  } = args;

  // Wrap interactive failures so the agent gets a screenshot + selector
  // match-count + recent console errors instead of a bare "element not found".
  let result;
  if (name === "browser_click" || name === "browser_type") {
    try {
      result = await bridge.send(wsType, wireArgs);
    } catch (err) {
      const reason = String(err?.message ?? err);
      const diag = await collectFailureDiagnostics(bridge, args, reason).catch(() => null);
      // Auto-trace the failure too — it's useful in run history and for "what
      // did I just try?" introspection. We DON'T add it to the workflow trace
      // since failures shouldn't be replayed.
      return {
        ok: false,
        action: name,
        ref: args.ref,
        reason,
        ...(diag ?? {}),
      };
    }
  } else {
    result = await bridge.send(wsType, wireArgs);
  }

  // Update url/origin tracking from any response that carries it.
  if (result?.url) noteUrl(result.url);

  // Snapshot post-processing: compact defaults, viewport scope, byte budget,
  // secret redaction, and stored raw tree for targeted drilldown.
  if (name === "browser_snapshot" && result?.tree) {
    const mode = argSnapshotMode === "full" ? "full" : DEFAULT_SNAPSHOT_MODE;
    const compact = mode !== "full";
    const scope = argScope ?? (compact ? DEFAULT_SNAPSHOT_SCOPE : "all");
    const redact = typeof argRedact === "boolean" ? argRedact : compact;
    const maxBytes = typeof argMaxBytes === "number"
      ? argMaxBytes
      : (compact ? DEFAULT_SNAPSHOT_MAX_BYTES : 0);
    const maxDepth = normalizePositiveInt(argMaxDepth, DEFAULT_SNAPSHOT_MAX_DEPTH, 1, 25);
    const textLimit = normalizePositiveInt(argTextLimit, DEFAULT_SNAPSHOT_TEXT_LIMIT, 20, 500);
    const includeBoxes = ["all", "interactive", "none"].includes(argIncludeBoxes)
      ? argIncludeBoxes
      : DEFAULT_SNAPSHOT_INCLUDE_BOXES;

    const snapshotId = argStore === false ? null : storeSnapshot(result);
    if (snapshotId) result.snapshotId = snapshotId;
    result.mode = mode;

    if (scope === "viewport" && result.viewport) {
      result.tree = pruneToViewport(result.tree, result.viewport);
    }
    if (compact) {
      const compacted = compactTree(result.tree, {
        maxDepth,
        textLimit,
        includeBoxes,
      });
      result.tree = compacted.tree;
      result.compaction = compacted.stats;
      result.defaultsApplied = {
        scope,
        maxBytes,
        maxDepth,
        textLimit,
        includeBoxes,
        redact,
      };
    }
    if (redact) result.tree = redactTree(result.tree);
    if (typeof maxBytes === "number" && maxBytes > 0) {
      const sized = enforceByteBudget(result, maxBytes);
      if (sized.truncated) result.truncated = true;
    }
    result.bytes = JSON.stringify(result).length;
  }

  // Cache selector hits.
  if ((name === "browser_click" || name === "browser_type") && argIntent && args.ref) {
    const origin = originOf(result?.url) ?? activeOrigin;
    if (origin) {
      memory.recordSelectorHit({
        origin, intent: argIntent, selector: args.ref,
        role: result?.role, name: result?.name,
        lastBox: result?.box ?? null,
      });
    }
  }

  // Auto-trace successful writes.
  switch (name) {
    case "browser_navigate":
      trace.record("navigate", { url: result.url, intent: argIntent });
      break;
    case "browser_click":
      trace.record("click", {
        ref: args.ref, intent: argIntent, role: result?.role, name: result?.name,
        button: args.button, clickCount: args.clickCount, x: result?.x, y: result?.y,
        box: result?.box, url: result?.url,
      });
      break;
    case "browser_click_at":
      trace.record("click_at", { x: args.x, y: args.y, button: args.button, clickCount: args.clickCount, url: result?.url });
      break;
    case "browser_type":
      trace.record("type", {
        ref: args.ref,
        // Truncate huge text values so run-history payloads stay bounded.
        // Pasted secrets/blobs are common; the trace only needs enough to
        // replay or diagnose.
        text: typeof args.text === "string" && args.text.length > 500
          ? `${args.text.slice(0, 500)}…[${args.text.length} chars total]`
          : args.text,
        intent: argIntent,
        role: result?.role, name: result?.name,
        submit: !!args.submit, clear: args.clear !== false, url: result?.url,
      });
      break;
    case "browser_press_key":
      trace.record("press_key", { key: args.key, url: result?.url });
      break;
    case "browser_scroll":
      trace.record("scroll", { x: args.x, y: args.y, deltaX: args.deltaX, deltaY: args.deltaY, url: result?.url });
      break;
    case "browser_wait":
      trace.record("wait", { ms: args.ms });
      break;
    case "browser_assert":
      trace.record("assert", {
        intent: argIntent,
        expected: { kind: args.kind, target: args.target, value: args.value },
      });
      break;
    default: break;
  }

  // Special: screenshot returns image content.
  if (name === "browser_screenshot" && result?.dataUrl) {
    return { __mcpImage: true, ...result };
  }

  return result;
}

// ---------------- selector cache tools ----------------

function toolRecallSelector({ intent, origin }) {
  if (!intent) throw new Error("intent is required");
  const o = origin ?? activeOrigin;
  if (!o) return { found: false, reason: "no current origin — navigate first or pass `origin`" };
  const row = memory.recallSelector(o, intent);
  if (!row) return { found: false, origin: o, intent };
  return {
    found: true,
    origin: o,
    intent: row.intent,
    selector: row.selector,
    role: row.role,
    name: row.name,
    last_box: row.last_box ? safeParse(row.last_box) : null,
    hit_count: row.hit_count,
    miss_count: row.miss_count,
    last_verified: row.last_verified,
  };
}

function toolForgetSelector({ intent, origin }) {
  const o = origin ?? activeOrigin;
  if (!o) throw new Error("no current origin — navigate first or pass `origin`");
  const removed = memory.forgetSelector(o, intent);
  return { removed: removed > 0, origin: o, intent };
}

function toolListSelectors({ origin, all }) {
  const o = all ? null : (origin ?? activeOrigin);
  const items = memory.listSelectors(o);
  return { origin: o, count: items.length, items };
}

// ---------------- workflow tools ----------------

function toolWorkflowSave({ name, description, origin }) {
  if (!name) throw new Error("name is required");
  const o = origin ?? originOf(trace.firstUrl) ?? activeOrigin;
  if (!o) throw new Error("cannot determine origin — navigate to a real URL first or pass `origin`");
  const steps = trace.asSteps();
  if (steps.length === 0) throw new Error("trace is empty — run some browser_* actions before saving");
  return memory.saveWorkflow({ origin: o, name, description, steps });
}

function toolWorkflowList({ origin, all }) {
  const o = all ? null : (origin ?? activeOrigin);
  return { origin: o, items: memory.listWorkflows(o) };
}

function toolWorkflowGet({ name, origin }) {
  const o = origin ?? activeOrigin;
  if (!o) throw new Error("origin required (no current origin)");
  const wf = memory.getWorkflow(o, name);
  if (!wf) return { found: false, origin: o, name };
  return { found: true, ...wf };
}

function toolWorkflowDelete({ name, origin }) {
  const o = origin ?? activeOrigin;
  if (!o) throw new Error("origin required");
  const removed = memory.deleteWorkflow(o, name);
  return { removed: removed > 0, origin: o, name };
}

function toolWorkflowExport({ name, origin }) {
  const o = origin ?? activeOrigin;
  if (!o) throw new Error("origin required");
  const payload = memory.exportWorkflow(o, name);
  if (!payload) return { found: false };
  return { found: true, payload };
}

function toolWorkflowImport({ payload }) {
  return memory.importWorkflow(payload);
}

function toolRunHistory({ name, origin, limit }) {
  const o = origin ?? activeOrigin;
  if (!o) throw new Error("origin required");
  return { origin: o, name, runs: memory.listRuns(o, name, limit ?? 20) };
}

// ---------------- workflow replay (the heart of "remembered testing") ----------------

async function toolWorkflowRun(bridge, { name, origin, continueOnError = false, stepDelayMs = 0 }) {
  const o = origin ?? activeOrigin;
  if (!o) throw new Error("origin required (start a session and navigate first, or pass `origin`)");
  const wf = memory.getWorkflow(o, name);
  if (!wf) throw new Error(`workflow not found: ${o} :: ${name}`);

  const runId = memory.startRun(wf.id, wf.steps.length);
  const results = [];
  let passed = 0;
  let failed = false;

  for (const step of wf.steps) {
    if (failed && !continueOnError) {
      results.push({ step: step.ord, action: step.action, intent: step.intent, status: "skipped" });
      continue;
    }
    const env = await runStep(bridge, o, step);
    results.push(env);
    if (env.status === "pass") passed++;
    else failed = true;
    if (stepDelayMs > 0) await new Promise((r) => setTimeout(r, stepDelayMs));
  }

  const status = failed ? (continueOnError ? "partial" : "fail") : "pass";
  memory.finishRun(runId, { status, stepsPassed: passed, resultJson: results });
  memory.pruneRuns(wf.id, 50);

  return {
    runId,
    workflow: { origin: o, name, id: wf.id },
    status, stepsTotal: wf.steps.length, stepsPassed: passed,
    failedAt: failed ? results.findIndex((r) => r.status !== "pass") : -1,
    results,
  };
}

async function runStep(bridge, origin, step) {
  const t0 = Date.now();
  const baseEnvelope = { step: step.ord, action: step.action, intent: step.intent };

  try {
    switch (step.action) {
      case "navigate": {
        const r = await bridge.send("navigate", { url: step.value });
        if (r?.url) noteUrl(r.url);
        return { ...baseEnvelope, status: "pass", url: r.url, durationMs: Date.now() - t0 };
      }
      case "press_key": {
        const r = await bridge.send("press_key", { key: step.value });
        if (r?.url) noteUrl(r.url);
        return { ...baseEnvelope, status: "pass", durationMs: Date.now() - t0 };
      }
      case "scroll": {
        const r = await bridge.send("scroll", step.params ?? {});
        if (r?.url) noteUrl(r.url);
        return { ...baseEnvelope, status: "pass", durationMs: Date.now() - t0 };
      }
      case "wait": {
        await bridge.send("wait", { ms: Number(step.value ?? 1000) });
        return { ...baseEnvelope, status: "pass", durationMs: Date.now() - t0 };
      }
      case "assert": {
        const r = await bridge.send("assert", step.expected ?? {});
        return {
          ...baseEnvelope,
          status: r.ok ? "pass" : "fail",
          got: r.got, expected: step.expected,
          durationMs: Date.now() - t0,
        };
      }
      case "click":
      case "click_at":
      case "type":
        return await runInteractiveStep(bridge, origin, step, baseEnvelope, t0);
      default:
        return { ...baseEnvelope, status: "fail", reason: `unknown action: ${step.action}` };
    }
  } catch (e) {
    return { ...baseEnvelope, status: "fail", reason: String(e?.message ?? e), durationMs: Date.now() - t0 };
  }
}

async function runInteractiveStep(bridge, origin, step, baseEnvelope, t0) {
  // For click_at, replay coordinates directly.
  if (step.action === "click_at") {
    const r = await bridge.send("click_at", step.params ?? {});
    if (r?.url) noteUrl(r.url);
    return { ...baseEnvelope, status: "pass", x: r.x, y: r.y, durationMs: Date.now() - t0 };
  }

  // 1) Try cached selector from the steps table.
  const candidates = [step.selector, ...(step.selector_alt ?? [])].filter(Boolean);

  // 2) Augment with selector-cache lookup if we have an intent.
  if (step.intent) {
    const recall = memory.recallSelector(origin, step.intent);
    if (recall && !candidates.includes(recall.selector)) candidates.unshift(recall.selector);
  }

  let usedSelector = null;
  let selectorSource = null;

  for (const sel of candidates) {
    const probe = await bridge.send("resolve_box", { ref: sel }).catch(() => ({ found: false }));
    if (probe.found) {
      usedSelector = sel;
      selectorSource = sel === step.selector ? "step_cache" : "selector_cache";
      break;
    }
  }

  // 3) Self-heal by role+name if all cached selectors failed.
  if (!usedSelector && (step.role || step.name)) {
    const healed = await bridge.send("find_by_role_name", { role: step.role, name: step.name })
      .catch(() => null);
    if (healed?.selector) {
      usedSelector = healed.selector;
      selectorSource = "self_healed";
      // Update both stores so next time is fast again.
      memory.patchStep(step.id, { selector: healed.selector, role: healed.role, name: healed.name, last_box: healed.box });
      if (step.intent) {
        memory.updateSelector({
          origin, intent: step.intent, selector: healed.selector,
          role: healed.role, name: healed.name, lastBox: healed.box,
        });
      }
    }
  }

  if (!usedSelector) {
    memory.bumpStepFail(step.id);
    if (step.intent) memory.recordSelectorMiss(origin, step.intent);
    // Capture a screenshot to help the agent diagnose.
    const shot = await bridge.send("screenshot", { format: "png" }).catch(() => null);
    return {
      ...baseEnvelope,
      status: "fail",
      reason: "no working selector (cache + self-heal both missed)",
      tried: candidates,
      role: step.role, name: step.name,
      screenshotDataUrl: shot?.dataUrl ?? null,
      suggestion: "call browser_snapshot to inspect; the selector may need updating",
      durationMs: Date.now() - t0,
    };
  }

  // 4) Execute the action with the resolved selector.
  if (step.action === "click") {
    const r = await bridge.send("click", { ref: usedSelector, button: step.params?.button, clickCount: step.params?.clickCount });
    if (r?.url) noteUrl(r.url);
    return { ...baseEnvelope, status: "pass", selector: usedSelector, selector_source: selectorSource, durationMs: Date.now() - t0 };
  }

  if (step.action === "type") {
    const r = await bridge.send("type", {
      ref: usedSelector, text: step.value ?? "",
      submit: !!step.params?.submit, clear: step.params?.clear !== false,
    });
    if (r?.url) noteUrl(r.url);
    return { ...baseEnvelope, status: "pass", selector: usedSelector, selector_source: selectorSource, durationMs: Date.now() - t0 };
  }

  return { ...baseEnvelope, status: "fail", reason: "unhandled interactive step" };
}

// ---------------- failure diagnostics ----------------

// On a failed click/type, gather: a viewport screenshot, a match count for
// the selector (0 / 1 / many), short samples of the closest matching nodes,
// and the most recent console errors. Each step is best-effort; we never let
// a diagnostic call mask the original failure.
async function collectFailureDiagnostics(bridge, args, reason) {
  const out = { diagnostics: { reason } };
  // 1) Selector match count + samples.
  if (args?.ref) {
    try {
      const m = await bridge.send("match_count", { ref: args.ref });
      out.diagnostics.matchCount = m?.count ?? null;
      out.diagnostics.matchSamples = m?.samples ?? null;
      if (m?.error) out.diagnostics.selectorError = m.error;
    } catch (e) {
      out.diagnostics.matchCount = null;
      out.diagnostics.matchProbeError = String(e?.message ?? e);
    }
  }
  // 2) Recent console errors (last 5).
  try {
    const c = await bridge.send("console_messages", { level: "error", limit: 5 });
    out.diagnostics.recentConsoleErrors = c?.messages ?? [];
  } catch {
    out.diagnostics.recentConsoleErrors = [];
  }
  // 3) Viewport screenshot — small JPEG keeps payload reasonable.
  try {
    const shot = await bridge.send("screenshot", { format: "jpeg" });
    if (shot?.dataUrl) out.diagnostics.screenshotDataUrl = shot.dataUrl;
  } catch {
    /* swallow */
  }
  out.diagnostics.suggestion =
    out.diagnostics.matchCount === 0
      ? "Selector matched 0 elements. Call browser_snapshot or browser_evaluate to find the right ref."
      : out.diagnostics.matchCount > 1
        ? "Selector matched multiple elements — make it more specific (e.g. add :nth-of-type or [data-testid])."
        : "Selector matched but the action failed mid-flight. Check recentConsoleErrors and screenshot.";
  return out;
}

// ---------------- snapshot post-processors ----------------

function storeSnapshot(result) {
  const id = `snap-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  snapshotStore.set(id, { createdAt: Date.now(), result: cloneJson(result) });
  latestSnapshotId = id;
  while (snapshotStore.size > SNAPSHOT_STORE_LIMIT) {
    const oldest = snapshotStore.keys().next().value;
    snapshotStore.delete(oldest);
    if (latestSnapshotId === oldest) latestSnapshotId = snapshotStore.keys().next().value ?? null;
  }
  return id;
}

function getStoredSnapshot(snapshotId) {
  const id = snapshotId ?? latestSnapshotId;
  if (!id) throw new Error("no stored snapshot yet — call browser_snapshot first");
  const entry = snapshotStore.get(id);
  if (!entry) throw new Error(`snapshot not found or expired: ${id}`);
  return { id, entry };
}

function compactTree(root, opts = {}) {
  const stats = {
    nodesSeen: 0,
    nodesReturned: 0,
    textTrimmed: 0,
    boxesDropped: 0,
    depthPruned: 0,
    wrappersCollapsed: 0,
    emptyDropped: 0,
  };
  const tree = compactNode(root, 0, {
    maxDepth: normalizeInt(opts.maxDepth, DEFAULT_SNAPSHOT_MAX_DEPTH, 0, 25),
    textLimit: normalizeInt(opts.textLimit, DEFAULT_SNAPSHOT_TEXT_LIMIT, 20, 500),
    includeBoxes: ["all", "interactive", "none"].includes(opts.includeBoxes)
      ? opts.includeBoxes
      : DEFAULT_SNAPSHOT_INCLUDE_BOXES,
  }, stats);
  return { tree, stats };
}

function compactNode(node, depth, opts, stats) {
  if (!node) return null;
  stats.nodesSeen += 1;

  if (node.kind === "text") {
    const text = trimSnapshotString(node.text ?? "", opts.textLimit, stats);
    if (!text) return null;
    stats.nodesReturned += 1;
    return { kind: "text", text };
  }

  if (node.kind !== "element") return null;

  const interesting = isCompactInteresting(node, depth);
  const out = { kind: "element" };
  if (node.tag) out.tag = node.tag;
  if (node.role) out.role = node.role;
  if (node.ref) out.ref = node.ref;
  if (node.name) out.name = trimSnapshotString(node.name, opts.textLimit, stats);

  if (node.box && shouldKeepBox(node, opts.includeBoxes)) {
    out.box = node.box;
  } else if (node.box) {
    stats.boxesDropped += 1;
  }

  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length) {
    if (depth >= opts.maxDepth) {
      out.truncatedChildren = children.length;
      stats.depthPruned += children.length;
    } else {
      const kept = [];
      for (const child of children) {
        const compacted = compactNode(child, depth + 1, opts, stats);
        if (compacted) kept.push(compacted);
      }
      if (kept.length) out.children = kept;
    }
  }

  const hasChildren = Array.isArray(out.children) && out.children.length > 0;
  const hasOwnValue = !!(out.name || out.ref || out.box || out.truncatedChildren);
  if (!interesting && !hasOwnValue && !hasChildren) {
    stats.emptyDropped += 1;
    return null;
  }
  if (!interesting && !out.name && !out.ref && hasChildren && out.children.length === 1) {
    stats.wrappersCollapsed += 1;
    return out.children[0];
  }

  stats.nodesReturned += 1;
  return out;
}

function trimSnapshotString(value, limit, stats) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  stats.textTrimmed += 1;
  return normalized.slice(0, Math.max(0, limit - 3)) + "...";
}

function isCompactInteresting(node, depth = 0) {
  if (depth === 0) return true;
  if (node.ref || node.name) return true;
  const tag = String(node.tag ?? "").toLowerCase();
  const role = String(node.role ?? "").toLowerCase();
  const semantic = new Set([
    "a", "button", "input", "textarea", "select", "option", "label",
    "summary", "details", "dialog", "form", "nav", "main", "header",
    "footer", "article", "aside", "section", "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "h1", "h2", "h3", "h4", "h5", "h6",
  ]);
  const roles = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch",
    "option", "menuitem", "tab", "listitem", "article", "heading", "main",
    "navigation", "contentinfo", "complementary", "dialog", "alert",
    "status", "table", "row", "cell", "columnheader", "rowheader",
  ]);
  return semantic.has(tag) || roles.has(role);
}

function shouldKeepBox(node, mode) {
  if (mode === "all") return true;
  if (mode === "none") return false;
  return isCompactInteresting(node, 1) || !!node.ref;
}

function pruneToViewport(node, viewport) {
  if (!node) return node;
  const vw = viewport?.width ?? 0;
  const vh = viewport?.height ?? 0;
  function fullyOffscreen(box) {
    if (!box) return false;
    return (box.x + box.w <= 0) || (box.y + box.h <= 0) || (box.x >= vw) || (box.y >= vh);
  }
  function walk(n) {
    if (!n || n.kind !== "element") return n;
    if (fullyOffscreen(n.box)) return null;
    if (Array.isArray(n.children)) {
      const kids = [];
      for (const c of n.children) {
        const w = walk(c);
        if (w) kids.push(w);
      }
      n.children = kids.length ? kids : undefined;
    }
    return n;
  }
  return walk(node);
}

const SECRET_PATTERNS = [
  // Bearer / Basic Authorization header values
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+\/=]{16,}\b/g,
  // JWT-shaped: 3 base64url segments separated by dots
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  // GUIDs / UUIDs (loose but catches most Azure / MS IDs)
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // AWS secret-key-shaped 40-char base64 chunks (high false-positive risk;
  // limit to common contexts)
  /(?<=secret\s*[=:]\s*["']?)[A-Za-z0-9\/+=]{40}\b/gi,
];

function redactString(s) {
  if (typeof s !== "string" || s.length < 16) return s;
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function redactTree(node) {
  if (!node) return node;
  if (node.kind === "text") return { ...node, text: redactString(node.text) };
  if (node.name) node.name = redactString(node.name);
  if (Array.isArray(node.children)) {
    node.children = node.children.map(redactTree);
  }
  return node;
}

// Truncate the snapshot to fit a byte budget. Strategy:
//   1) Trim long `name` and text leaves to 80 chars.
//   2) If still over budget, drop trailing children at progressively shallower
//      depths until we fit, marking the first drop with an ellipsis sentinel.
function enforceByteBudget(result, maxBytes) {
  let json = JSON.stringify(result);
  if (json.length <= maxBytes) return { truncated: false };

  function trimLeaves(n) {
    if (!n) return;
    if (n.kind === "text" && typeof n.text === "string" && n.text.length > 80) n.text = n.text.slice(0, 77) + "...";
    if (typeof n.name === "string" && n.name.length > 80) n.name = n.name.slice(0, 77) + "...";
    if (Array.isArray(n.children)) n.children.forEach(trimLeaves);
  }
  trimLeaves(result.tree);
  json = JSON.stringify(result);
  if (json.length <= maxBytes) return { truncated: false };

  // Iteratively drop the deepest tail children until under budget. Cap iters.
  for (let attempt = 0; attempt < 20; attempt++) {
    let dropped = false;
    function deepestPrune(n, depthBudget) {
      if (!n || !Array.isArray(n.children) || n.children.length === 0) return false;
      if (depthBudget <= 0) {
        const removed = n.children.length;
        n.children = undefined;
        n.truncatedChildren = removed;
        return removed > 0;
      }
      let any = false;
      for (const c of n.children) any = deepestPrune(c, depthBudget - 1) || any;
      // If still over budget after deeper pruning, drop trailing children here.
      if (!any && n.children.length > 1) {
        n.truncatedChildren = (n.truncatedChildren ?? 0) + 1;
        n.children.pop();
        any = true;
      }
      return any;
    }
    dropped = deepestPrune(result.tree, 8 - attempt) || dropped;
    json = JSON.stringify(result);
    if (json.length <= maxBytes) return { truncated: true };
    if (!dropped) break;
  }
  return { truncated: true };
}

function fitMatchesToBudget(result, maxBytes) {
  if (!maxBytes || maxBytes <= 0) return;
  while (JSON.stringify(result).length > maxBytes && result.matches.length > 1) {
    result.matches.pop();
    result.returned = result.matches.length;
    result.truncated = true;
    result.truncatedReason = "maxBytes";
  }
  if (JSON.stringify(result).length <= maxBytes) return;
  for (const match of result.matches) {
    if (!match.excerpt) continue;
    delete match.excerpt;
    result.truncated = true;
    result.truncatedReason = "maxBytes";
    if (JSON.stringify(result).length <= maxBytes) break;
  }
}

function fitNodeToBudget(result, maxBytes) {
  if (!maxBytes || maxBytes <= 0 || !result.node) return;
  if (JSON.stringify(result).length <= maxBytes) return;
  const holder = { tree: result.node };
  const sized = enforceByteBudget(holder, maxBytes);
  result.node = holder.tree;
  if (sized.truncated) {
    result.truncated = true;
    result.truncatedReason = "maxBytes";
  }
}

function walkSnapshotTree(root, visit) {
  function walk(node, path) {
    if (!node) return;
    visit(node, path);
    if (!Array.isArray(node.children)) return;
    node.children.forEach((child, i) => walk(child, [...path, i]));
  }
  walk(root, []);
}

function nodeMatchesQuery(node, query) {
  if (query.ref && node.ref !== query.ref) return false;
  if (query.role && String(node.role ?? "").toLowerCase() !== query.role) return false;
  if (query.tag && String(node.tag ?? "").toLowerCase() !== query.tag) return false;
  if (query.text && !nodeTextBlob(node).includes(query.text)) return false;
  return true;
}

function nodeTextBlob(node) {
  return extractNodeText(node, 4000).toLowerCase();
}

function extractNodeText(node, limit = 1000) {
  const parts = [];
  let size = 0;
  function push(value) {
    if (size >= limit || typeof value !== "string") return;
    const s = value.replace(/\s+/g, " ").trim();
    if (!s) return;
    const room = limit - size;
    const clipped = s.slice(0, room);
    parts.push(clipped);
    size += clipped.length + 1;
  }
  function walk(n) {
    if (!n || size >= limit) return;
    if (n.kind === "text") push(n.text);
    else {
      push(n.name);
      if (Array.isArray(n.children)) n.children.forEach(walk);
    }
  }
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function nodeAtPath(root, path) {
  if (path === "" || path == null) return root;
  const parts = String(path).split(".").filter((p) => p.length > 0);
  let node = root;
  for (const raw of parts) {
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0 || !Array.isArray(node?.children)) return null;
    node = node.children[idx];
    if (!node) return null;
  }
  return node;
}

function normalizePositiveInt(value, fallback, min, max) {
  return normalizeInt(value, fallback, min, max);
}

function normalizeInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------- helpers ----------------

function jsonResult(value) {
  if (value && value.__mcpImage) {
    const m = value.dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (m) {
      const meta = { ...value };
      delete meta.__mcpImage;
      delete meta.dataUrl;
      return {
        content: [
          { type: "image", data: m[2], mimeType: `image/${m[1]}` },
          { type: "text", text: JSON.stringify(meta, null, 2) },
        ],
      };
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

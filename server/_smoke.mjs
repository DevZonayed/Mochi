// Smoke test for Super-Tester tool surface. Doesn't touch a live browser —
// stubs the bridge to verify schemas, post-processing, and failure diagnostics.
import { tools, initToolsState, handleToolCall } from "./src/tools.js";

const want = [
  "browser_session_health",
  "browser_evaluate",
  "browser_console_messages",
  "browser_network_requests",
  "browser_text",
  "browser_links",
  "browser_snapshot_query",
  "browser_snapshot_node",
  "browser_upload_stage",
  "browser_upload_file",
  "browser_playbook_list",
  "browser_playbook_get",
  "browser_playbook_save",
  "browser_playbook_delete",
  "browser_playbook_match",
  "browser_playbook_run",
  "browser_playbook_propose_update",
  "browser_playbook_secret_check",
  "browser_playbook_seed_from_codebase",
  "browser_playbook_diff_accept",
  "browser_playbook_export",
  "browser_playbook_import",
  "browser_playbook_dashboard",
  "browser_request_attention",
  "browser_comment_add",
  "browser_comment_list",
  "browser_comment_sessions",
  "browser_comment_resolve",
];
const names = tools.map(t => t.name);
for (const w of want) {
  if (!names.includes(w)) { console.error("MISSING TOOL:", w); process.exit(1); }
  const t = tools.find(x => x.name === w);
  if (!t.description || !t.inputSchema || t.inputSchema.type !== "object") {
    console.error("BAD SCHEMA:", w, t); process.exit(1);
  }
}
console.log("✓ compact discovery tools present with valid schemas");
console.log("  total tool count:", tools.length);

const snap = tools.find(t => t.name === "browser_snapshot");
const props = snap.inputSchema.properties;
for (const k of ["mode","scope","maxBytes","maxDepth","textLimit","includeBoxes","redact","store"]) {
  if (!props[k]) { console.error("snapshot missing prop:", k); process.exit(1); }
}
if (props.mode.default !== "compact" || props.scope.default !== "viewport" || props.redact.default !== true) {
  console.error("snapshot defaults are not compact-safe:", props); process.exit(1);
}
console.log("✓ browser_snapshot defaults are compact/viewport/redacted");

// 0.5.0: session_start no longer steals focus by default; request_attention exists.
const ss0 = tools.find(t => t.name === "browser_session_start");
if (ss0.inputSchema.properties.bringToFront.default !== false) {
  console.error("session_start bringToFront default should be false in 0.5.0"); process.exit(1);
}
const ra = tools.find(t => t.name === "browser_request_attention");
if (!ra || !ra.inputSchema.properties.reason || !ra.inputSchema.required?.includes("reason")) {
  console.error("browser_request_attention schema bad:", ra); process.exit(1);
}
console.log("✓ session_start defaults to no-focus + browser_request_attention present");

initToolsState({ log: () => {} });
const fakeBridge = { mode: "broker", isConnected: () => false, getLocalClientId: () => "mc-self-abc",
                     mcpClients: new Map(), extensionWs: null };
let r = await handleToolCall(fakeBridge, { name: "browser_session_health", arguments: {} });
let parsed = JSON.parse(r.content[0].text);
if (parsed.mode !== "broker" || parsed.connected !== false || typeof parsed.serverUptimeMs !== "number") {
  console.error("session_health bad shape:", parsed); process.exit(1);
}
console.log("✓ browser_session_health:", { mode: parsed.mode, connected: parsed.connected, uptimeMs: parsed.serverUptimeMs, tip: parsed.tip });

const realBridge = {
  mode: "broker", isConnected: () => true, getLocalClientId: () => "mc-self-abc",
  mcpClients: new Map(), extensionWs: {},
  send: async (type) => {
    if (type === "snapshot") {
      return {
        url: "https://example.com/", title: "X",
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
        tree: {
          kind: "element", tag: "body", role: "body", box: {x:0,y:0,w:800,h:600},
          children: [
            { kind: "element", tag: "h1", role: "heading", name: "Hello Bearer eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr World", box: {x:0,y:0,w:200,h:30} },
            { kind: "element", tag: "div", role: "main", box: {x:0,y:1000,w:200,h:30}, children: [
              { kind: "text", text: "offscreen" }
            ]},
            { kind: "element", tag: "footer", role: "contentinfo", name: "GUID 12345678-1234-1234-1234-123456789012 footer", box: {x:0,y:580,w:200,h:30} },
          ],
        },
      };
    }
    throw new Error("unexpected wire send: " + type);
  },
};

r = await handleToolCall(realBridge, { name: "browser_snapshot", arguments: {} });
let parsedSnap = JSON.parse(r.content[0].text);
const viewportKids = parsedSnap.tree.children?.length ?? 0;
if (viewportKids !== 2) { console.error("viewport scope expected 2 kids, got", viewportKids, parsedSnap); process.exit(1); }
if (!parsedSnap.snapshotId) { console.error("snapshotId missing from default compact snapshot", parsedSnap); process.exit(1); }
if (parsedSnap.mode !== "compact") { console.error("default snapshot mode should be compact", parsedSnap); process.exit(1); }
console.log("✓ default snapshot pruned offscreen subtree and stored snapshotId");

r = await handleToolCall(realBridge, { name: "browser_snapshot", arguments: { redact: true } });
parsedSnap = JSON.parse(r.content[0].text);
const txt2 = JSON.stringify(parsedSnap);
if (txt2.includes("12345678-1234-1234-1234-123456789012")) { console.error("GUID not redacted:", txt2); process.exit(1); }
if (txt2.includes("eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr")) { console.error("JWT not redacted"); process.exit(1); }
if (!txt2.includes("[REDACTED]")) { console.error("no [REDACTED] marker"); process.exit(1); }
console.log("✓ redact=true masked JWT + GUID with [REDACTED]");

r = await handleToolCall(realBridge, { name: "browser_snapshot", arguments: { maxBytes: 200 } });
parsedSnap = JSON.parse(r.content[0].text);
if (!parsedSnap.truncated) { console.error("maxBytes did not set truncated, size=", JSON.stringify(parsedSnap).length); process.exit(1); }
console.log("✓ maxBytes=200 triggered truncated:true (final size:", JSON.stringify(parsedSnap).length, ")");

r = await handleToolCall(realBridge, { name: "browser_snapshot_query", arguments: { text: "Hello", limit: 5 } });
const queryPayload = JSON.parse(r.content[0].text);
if (!queryPayload.matches?.length) { console.error("snapshot_query returned no matches", queryPayload); process.exit(1); }
const firstPath = queryPayload.matches[0].path;
console.log("✓ browser_snapshot_query found stored snapshot match:", { path: firstPath, returned: queryPayload.returned });

r = await handleToolCall(realBridge, { name: "browser_snapshot_node", arguments: { path: firstPath } });
const nodePayload = JSON.parse(r.content[0].text);
if (!nodePayload.node) { console.error("snapshot_node returned no node", nodePayload); process.exit(1); }
console.log("✓ browser_snapshot_node returned targeted subtree");

const failBridge = {
  ...realBridge,
  send: async (type) => {
    if (type === "click") throw new Error("element not found: #nope");
    if (type === "match_count") return { count: 0, samples: [] };
    if (type === "console_messages") return { messages: [{level:"error",text:"boom",ts:1}] };
    if (type === "screenshot") return { dataUrl: "data:image/jpeg;base64,xxx" };
    throw new Error("unexpected: " + type);
  },
};
r = await handleToolCall(failBridge, { name: "browser_click", arguments: { ref: "#nope", intent: "click X" } });
const failPayload = JSON.parse(r.content[0].text);
if (failPayload.ok !== false) { console.error("expected ok:false", failPayload); process.exit(1); }
if (!failPayload.diagnostics) { console.error("missing diagnostics", failPayload); process.exit(1); }
if (failPayload.diagnostics.matchCount !== 0) { console.error("matchCount wrong"); process.exit(1); }
if (!failPayload.diagnostics.recentConsoleErrors?.length) { console.error("no console errors"); process.exit(1); }
if (!failPayload.diagnostics.screenshotDataUrl) { console.error("no screenshot in diag"); process.exit(1); }
console.log("✓ click failure rich envelope:", {
  matchCount: failPayload.diagnostics.matchCount,
  consoleErrors: failPayload.diagnostics.recentConsoleErrors.length,
  hasScreenshot: !!failPayload.diagnostics.screenshotDataUrl,
  suggestion: failPayload.diagnostics.suggestion,
});

// ---- 0.5.0: browser_assert_no_errors composition ----
const cleanBridge = {
  ...realBridge,
  send: async (type) => {
    if (type === "console_messages") return { messages: [], total: 0 };
    if (type === "network_requests") return { requests: [], total: 0 };
    throw new Error("unexpected: " + type);
  },
};
r = await handleToolCall(cleanBridge, { name: "browser_assert_no_errors", arguments: {} });
let ane = JSON.parse(r.content[0].text);
if (ane.ok !== true) { console.error("assert_no_errors should pass on clean page", ane); process.exit(1); }
console.log("✓ assert_no_errors ok=true on a clean page");

const dirtyBridge = {
  ...realBridge,
  send: async (type) => {
    if (type === "console_messages") return { messages: [{ level: "error", text: "TypeError boom", source: "exception", ts: 2 }] };
    if (type === "network_requests") return { requests: [{ method: "POST", url: "https://x/api/report", status: 500, failed: false, body: "SMTP not configured" }] };
    throw new Error("unexpected: " + type);
  },
};
r = await handleToolCall(dirtyBridge, { name: "browser_assert_no_errors", arguments: {} });
ane = JSON.parse(r.content[0].text);
if (ane.ok !== false || ane.consoleErrorCount !== 1 || ane.failedRequestCount !== 1) { console.error("assert_no_errors should fail", ane); process.exit(1); }
if (!ane.failedRequests[0].body?.includes("SMTP")) { console.error("500 body not surfaced", ane); process.exit(1); }
console.log("✓ assert_no_errors ok=false surfaces console error + 500 body:", ane.summary);

r = await handleToolCall({
  ...realBridge,
  send: async (type) => {
    if (type === "console_messages") return { messages: [] };
    if (type === "network_requests") return { requests: [{ method: "GET", url: "https://analytics.example/track", status: 503, failed: false }] };
    throw new Error("unexpected: " + type);
  },
}, { name: "browser_assert_no_errors", arguments: { ignoreUrlContains: ["analytics.example"] } });
ane = JSON.parse(r.content[0].text);
if (ane.ok !== true) { console.error("assert_no_errors should ignore noisy url", ane); process.exit(1); }
console.log("✓ assert_no_errors honors ignoreUrlContains");

// ---- 0.5.0: browser_act_and_observe classification ----
function observeBridge({ click = "ok", net = [], cons = [], beforeUrl = "https://x/a", afterUrl = "https://x/a", beforeCount = 10, afterCount = 10 }) {
  let evalCalls = 0;
  return {
    ...realBridge,
    send: async (type, params) => {
      if (type === "evaluate") {
        evalCalls += 1;
        const first = evalCalls === 1;
        return { ok: true, type: "object", value: { url: first ? beforeUrl : afterUrl, title: "T", elementCount: first ? beforeCount : afterCount, bodyTextLen: 10 } };
      }
      if (type === "click") {
        if (click === "throw") throw new Error("element not found: #x");
        return { tabId: 1, ref: params.ref, url: beforeUrl, role: "button", name: "OK" };
      }
      if (type === "match_count") return { count: 0, samples: [] };
      if (type === "screenshot") return { dataUrl: "data:image/jpeg;base64,xxx" };
      if (type === "network_requests") return { requests: net };
      if (type === "console_messages") return { messages: cons };
      throw new Error("unexpected: " + type);
    },
  };
}
async function classify(cfg, actionArgs) {
  const rr = await handleToolCall(observeBridge(cfg), { name: "browser_act_and_observe", arguments: { settleMs: 0, action: actionArgs } });
  return JSON.parse(rr.content[0].text);
}
let ao = await classify({ net: [{ method: "POST", url: "https://x/api/save", status: 200 }], afterCount: 12 }, { type: "click", ref: "#save" });
if (ao.classification !== "WORKS") { console.error("expected WORKS", ao); process.exit(1); }
console.log("✓ act_and_observe → WORKS (2xx + DOM change)");
ao = await classify({}, { type: "click", ref: "#dead" });
if (ao.classification !== "NO-OP") { console.error("expected NO-OP", ao); process.exit(1); }
console.log("✓ act_and_observe → NO-OP (dead control, no effect)");
ao = await classify({ net: [{ method: "POST", url: "https://x/api/save", status: 500, failed: false }] }, { type: "click", ref: "#err" });
if (ao.classification !== "ERROR") { console.error("expected ERROR", ao); process.exit(1); }
console.log("✓ act_and_observe → ERROR (>=400 response)");
ao = await classify({ beforeUrl: "https://x/a", afterUrl: "https://x/b" }, { type: "click", ref: "#nav" });
if (ao.classification !== "NAVIGATES") { console.error("expected NAVIGATES", ao); process.exit(1); }
console.log("✓ act_and_observe → NAVIGATES (URL changed)");

// ---- 0.5.0: new tool schemas present ----
for (const n of ["browser_assert_no_errors","browser_audit_interactives","browser_act_and_observe","browser_wait_for_response","browser_page_assets","browser_set_storage"]) {
  const t = tools.find(x => x.name === n);
  if (!t || t.inputSchema?.type !== "object") { console.error("missing/bad new tool:", n, t); process.exit(1); }
}
console.log("✓ all six 0.5.0 tools present with valid schemas");

const sessionStart = tools.find(t => t.name === "browser_session_start");
const v = sessionStart?.inputSchema?.properties?.visuals;
if (!v || v.type !== "object") {
  console.error("session_start missing visuals object schema:", v); process.exit(1);
}
for (const k of ["enabled","cursor","hud","slowMo"]) {
  if (!v.properties?.[k]) { console.error("visuals missing prop:", k); process.exit(1); }
}
if (v.properties.enabled.default !== true || v.properties.slowMo.default !== 0) {
  console.error("visuals defaults wrong:", v.properties); process.exit(1);
}
console.log("✓ browser_session_start advertises visuals config");

console.log("\nALL SMOKE TESTS PASSED");

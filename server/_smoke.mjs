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

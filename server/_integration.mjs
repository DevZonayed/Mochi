// Full-stack integration test for Super-Tester.
// Spawns the real MCP server, attaches an MCP stdio client (the "Claude" side)
// and a fake WS extension (the "Chrome" side), then exercises every new tool.
//
// Environment is locked down so nothing tries to launch a real browser.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_PORT = 9119; // distinct from default 9009 to avoid colliding
const SERVER_ENTRY = path.join(__dirname, "src", "index.js");

// ---------- fake extension ----------
//
// Connects to the broker, says hello, and echoes back canned answers for the
// wire types the tools depend on (evaluate, console_messages, network_requests,
// text, links, snapshot, screenshot, click, match_count). Anything else returns
// an error so we can spot regressions.

function startFakeExtension() {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
  const calls = [];

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", role: "extension", version: "test" }));
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "hello") return;
    const { id, type, params } = msg;
    calls.push({ type, params });
    let result;
    let ok = true;
    switch (type) {
      case "session_start":
        result = { sessionId: "sess-test", groupId: 1, primaryTabId: 100, windowId: 1, ownsWindow: false, clientId: msg.clientId };
        break;
      case "navigate":
        result = { tabId: 100, url: params?.url ?? "about:blank" };
        break;
      case "request_attention":
        result = { ok: true, notified: true, hasSession: true, reason: params?.reason ?? null };
        break;
      case "snapshot":
        result = {
          tabId: 100,
          url: "https://example.com/",
          title: "Example",
          viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
          tree: {
            kind: "element", tag: "body", role: "body", box: { x: 0, y: 0, w: 800, h: 600 },
            children: [
              { kind: "element", tag: "h1", role: "heading", name: "Bearer eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr Token", box: { x: 0, y: 0, w: 200, h: 30 } },
              { kind: "element", tag: "section", role: "main", box: { x: 0, y: 30, w: 800, h: 400 } },
              { kind: "element", tag: "div", role: "complementary", box: { x: 0, y: 9999, w: 200, h: 30 }, children: [{ kind: "text", text: "way offscreen" }] },
            ],
          },
        };
        break;
      case "text":
        result = {
          tabId: 100,
          url: "https://example.com/",
          title: "Example",
          totalLines: 2,
          returned: 2,
          truncated: false,
          lines: ["Example login", "Token-free visible copy"],
        };
        break;
      case "links":
        result = {
          tabId: 100,
          url: "https://example.com/",
          title: "Example",
          totalLinks: 1,
          returned: 1,
          truncated: false,
          links: [{ text: "Docs", href: "https://example.com/docs", ref: "a[href=\"/docs\"]", box: { x: 1, y: 2, w: 40, h: 20 } }],
        };
        break;
      case "evaluate":
        // act_and_observe probes DOM state via an evaluate that reads
        // location.href — return a structured object for that so the delta
        // logic has something real to compare.
        if (typeof params?.expression === "string" && params.expression.includes("location.href")) {
          result = { tabId: 100, ok: true, type: "object", value: { url: "https://example.com/login", title: "Example", elementCount: 42, bodyTextLen: 100 }, url: "https://example.com/login" };
        } else {
          result = { tabId: 100, ok: true, type: "string", value: `evaluated:${params?.expression}`, url: "https://example.com/" };
        }
        break;
      case "audit_interactives":
        result = {
          tabId: 100, url: "https://example.com/login", title: "Example",
          scope: params?.scope ?? "all", totalVisible: 3, returned: 2, truncated: false,
          elements: [
            { selector: "#submit", tag: "button", role: "button", accessibleName: "Sign in", visible: true, inViewport: true, disabled: false, hasClickHandler: true, box: { x: 0, y: 0, w: 80, h: 30 } },
            { selector: "#disabled-btn", tag: "button", role: "button", accessibleName: "Save", visible: true, inViewport: true, disabled: true, hasClickHandler: true, box: { x: 0, y: 40, w: 80, h: 30 } },
          ],
        };
        break;
      case "wait_for_response":
        result = { tabId: 100, matched: true, source: "event", request: { url: "https://example.com/api/save", status: 200, method: "POST" } };
        break;
      case "set_storage":
        result = { tabId: 100, url: "https://example.com/login", localSet: 1, sessionSet: 0, cleared: false, cookies: [{ name: "token", success: true }] };
        break;
      case "page_assets":
        result = {
          tabId: 100, url: "https://example.com/login", count: 2, returned: 2, pageHash: "abc123",
          assets: [
            { url: "https://example.com/app.js", type: "script", sha256: "deadbeef", bytes: 1234, status: 200 },
            { url: "https://example.com/app.css", type: "css", sha256: "cafef00d", bytes: 567, status: 200 },
          ],
        };
        break;
      case "session_heal":
        result = { sessionId: "sess-test", primaryTabId: 100, healedTabs: [{ tabId: 100, attached: true }] };
        break;
      case "console_messages": {
        let msgs = [
          { level: "log", text: "loaded", ts: Date.now() - 1000 },
          { level: "error", text: "boom", ts: Date.now(), source: "exception" },
        ];
        if (params?.level) msgs = msgs.filter((m) => m.level === params.level);
        result = { tabId: 100, captureActive: true, total: msgs.length, returned: msgs.length, sinceNavigation: !!params?.sinceNavigation, messages: msgs };
        break;
      }
      case "network_requests": {
        let reqs = [{ id: "1", method: "GET", url: "https://example.com/api", status: 200, mimeType: "application/json", durationMs: 42, finished: true, failed: false }];
        if (params?.failedOnly) reqs = reqs.filter((r) => r.failed || (r.status >= 400));
        if (params?.urlContains) reqs = reqs.filter((r) => r.url.includes(params.urlContains));
        result = { tabId: 100, captureActive: true, total: reqs.length, returned: reqs.length, sinceNavigation: !!params?.sinceNavigation, requests: reqs };
        break;
      }
      case "screenshot":
        result = { tabId: 100, mode: "viewport", dataUrl: "data:image/jpeg;base64,Zm9v" };
        break;
      case "click":
        // Simulate a failure path so we can verify the diagnostic envelope.
        if (params?.ref === "#nope") {
          ok = false;
          result = "element not found: #nope";
        } else {
          result = { tabId: 100, ref: params?.ref, x: 100, y: 100, role: "button", name: "OK", url: "https://example.com/", box: { x: 90, y: 90, w: 20, h: 20, viewport: { w: 800, h: 600, dpr: 1 } } };
        }
        break;
      case "match_count":
        result = { count: 0, samples: [] };
        break;
      case "session_end":
        result = { ended: true, sessionId: "sess-test", tabCount: 1 };
        break;
      default:
        ok = false;
        result = `unhandled wire type in fake extension: ${type}`;
    }
    ws.send(JSON.stringify(ok ? { id, ok: true, result } : { id, ok: false, error: result }));
  });

  return { ws, calls, close: () => { try { ws.close(); } catch {} } };
}

// ---------- helpers ----------
function logStep(label) { console.log(`\n→ ${label}`); }
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { console.error(`✗ ${label}\n  expected: ${e}\n  actual:   ${a}`); process.exit(1); }
  console.log(`  ✓ ${label}`);
}
function assertOk(label, cond, info) {
  if (!cond) { console.error(`✗ ${label}`, info ?? ""); process.exit(1); }
  console.log(`  ✓ ${label}`);
}
function parsePayload(callResult) {
  const txt = callResult.content?.[0]?.text ?? "";
  return JSON.parse(txt);
}

// ---------- main ----------
async function main() {
  logStep("Starting MCP server (auto-launch off, port 9119)");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      SUPER_TESTER_WS_PORT: String(TEST_PORT),
      SUPER_TESTER_AUTO_LAUNCH: "false",
      SUPER_TESTER_EXTENSION_WAIT_MS: "5000",
      // Don't actually open macOS System Settings during the test.
      MOCHI_NO_OS_EXEC: "1",
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "super-tester-integration", version: "0.0.1" }, { capabilities: {} });

  // Drain server stderr so we see what's happening but don't block on it.
  const serverErr = [];
  if (transport.stderr) {
    transport.stderr.on("data", (b) => { serverErr.push(b.toString()); });
  }

  await client.connect(transport);
  console.log("  ✓ MCP client connected over stdio");

  // Wait briefly for broker to bind.
  await sleep(300);

  logStep("Connecting fake Chrome extension over WS");
  const ext = startFakeExtension();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("extension WS open timeout")), 3000);
    ext.ws.once("open", () => { clearTimeout(t); resolve(); });
    ext.ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  console.log("  ✓ fake extension connected and said hello");
  await sleep(150); // let broker process the hello

  // ----- 1) tools/list ------
  logStep("Listing tools");
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  assertEq("total tool count", names.length, 61);
  for (const n of [
    "browser_session_health",
    "browser_evaluate",
    "browser_console_messages",
    "browser_network_requests",
    "browser_text",
    "browser_links",
    "browser_snapshot_query",
    "browser_snapshot_node",
  ]) {
    assertOk(`tool present: ${n}`, names.includes(n));
  }

  // ----- 2) session_health (no extension data needed; pure server) -----
  logStep("Calling browser_session_health");
  const health = parsePayload(await client.callTool({ name: "browser_session_health", arguments: {} }));
  assertEq("health.mode", health.mode, "broker");
  assertOk("health.connected = true (extension is up)", health.connected === true, health);
  assertOk("health.serverUptimeMs is number", typeof health.serverUptimeMs === "number");
  console.log("    health:", health);

  // ----- 3) session_start + navigate (warm up for downstream) -----
  logStep("Starting session and navigating");
  await client.callTool({ name: "browser_session_start", arguments: { url: "https://example.com/" } });
  const navRes = parsePayload(await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/login" } }));
  assertEq("nav url", navRes.url, "https://example.com/login");

  // ----- 4) browser_evaluate end-to-end through WS -----
  logStep("Calling browser_evaluate");
  const evRes = parsePayload(await client.callTool({ name: "browser_evaluate", arguments: { expression: "1+2" } }));
  assertOk("evaluate ok", evRes.ok === true, evRes);
  assertEq("evaluate value", evRes.value, "evaluated:1+2");

  // ----- 5) console_messages end-to-end -----
  logStep("Calling browser_console_messages");
  const cmRes = parsePayload(await client.callTool({ name: "browser_console_messages", arguments: { limit: 5 } }));
  assertOk("console returned messages", Array.isArray(cmRes.messages) && cmRes.messages.length === 2);
  assertEq("first message level", cmRes.messages[0].level, "log");

  // ----- 6) network_requests end-to-end -----
  logStep("Calling browser_network_requests");
  const nrRes = parsePayload(await client.callTool({ name: "browser_network_requests", arguments: { urlContains: "api" } }));
  assertOk("network returned 1", nrRes.requests.length === 1);
  assertEq("network status", nrRes.requests[0].status, 200);

  // ----- 7) snapshot with redact + viewport scope + maxBytes -----
  logStep("Calling browser_snapshot with scope+redact+maxBytes");
  const snapRes = parsePayload(await client.callTool({ name: "browser_snapshot", arguments: { scope: "viewport", redact: true, maxBytes: 600 } }));
  const snapStr = JSON.stringify(snapRes);
  assertOk("offscreen child pruned", !snapStr.includes("way offscreen"));
  assertOk("JWT redacted", !snapStr.includes("eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr.eyJabcdefghijklmnopqr"));
  assertOk("[REDACTED] present", snapStr.includes("[REDACTED]"));
  assertOk("truncated flag set", snapRes.truncated === true || snapStr.length <= 600, `len=${snapStr.length}`);
  assertOk("snapshotId returned", typeof snapRes.snapshotId === "string", snapRes);

  // ----- 7b) compact text/links + stored snapshot drilldown -----
  logStep("Calling browser_text/browser_links and snapshot drilldown");
  const textRes = parsePayload(await client.callTool({ name: "browser_text", arguments: { query: "Example" } }));
  assertOk("text returned lines", textRes.lines?.length === 2, textRes);
  const linksRes = parsePayload(await client.callTool({ name: "browser_links", arguments: { limit: 5 } }));
  assertOk("links returned one link", linksRes.links?.length === 1, linksRes);
  const qRes = parsePayload(await client.callTool({ name: "browser_snapshot_query", arguments: { text: "Token", limit: 5 } }));
  assertOk("snapshot query returned matches", qRes.matches?.length >= 1, qRes);
  const nRes = parsePayload(await client.callTool({ name: "browser_snapshot_node", arguments: { path: qRes.matches[0].path } }));
  assertOk("snapshot node returned compact subtree", !!nRes.node, nRes);

  // ----- 8) click failure → diagnostic envelope -----
  logStep("Calling browser_click on non-existent element (failure path)");
  const clickFail = parsePayload(await client.callTool({ name: "browser_click", arguments: { ref: "#nope", intent: "click missing" } }));
  assertEq("click ok=false", clickFail.ok, false);
  assertOk("diagnostics present", !!clickFail.diagnostics);
  assertEq("matchCount=0", clickFail.diagnostics.matchCount, 0);
  assertOk("screenshot in diag", typeof clickFail.diagnostics.screenshotDataUrl === "string");
  console.log("    suggestion:", clickFail.diagnostics.suggestion);

  // ----- 9) click happy path still works -----
  logStep("Calling browser_click on a valid ref (happy path)");
  const clickOk = parsePayload(await client.callTool({ name: "browser_click", arguments: { ref: "button.ok", intent: "click ok" } }));
  assertEq("happy click ref", clickOk.ref, "button.ok");
  assertOk("happy click no diagnostics", clickOk.diagnostics === undefined);

  // ----- 9b) 0.5.0 QA primitives -----
  logStep("Calling browser_audit_interactives");
  const audit = parsePayload(await client.callTool({ name: "browser_audit_interactives", arguments: { scope: "all" } }));
  assertOk("audit returned elements", Array.isArray(audit.elements) && audit.elements.length === 2, audit);
  assertOk("audit flags disabled control", audit.elements.some((e) => e.disabled === true), audit);
  const auditCall = ext.calls.find((c) => c.type === "audit_interactives");
  assertEq("audit scope forwarded", auditCall?.params?.scope, "all");

  logStep("Calling browser_wait_for_response");
  const waited = parsePayload(await client.callTool({ name: "browser_wait_for_response", arguments: { urlGlob: "*/api/save*", method: "POST" } }));
  assertOk("wait matched", waited.matched === true, waited);
  assertEq("wait status", waited.request.status, 200);

  logStep("Calling browser_assert_no_errors (composition)");
  const noErr = parsePayload(await client.callTool({ name: "browser_assert_no_errors", arguments: {} }));
  assertOk("assert_no_errors flags the console error", noErr.ok === false, noErr);
  assertEq("one console error counted", noErr.consoleErrorCount, 1);
  assertEq("no failed requests counted", noErr.failedRequestCount, 0);

  logStep("Calling browser_act_and_observe (composition)");
  const observed = parsePayload(await client.callTool({ name: "browser_act_and_observe", arguments: { action: { type: "click", ref: "button.ok" }, settleMs: 0 } }));
  assertOk("act_and_observe classified", ["WORKS", "NO-OP", "ERROR", "NAVIGATES"].includes(observed.classification), observed);
  assertOk("act_and_observe returns deltas", Array.isArray(observed.networkDelta) && Array.isArray(observed.consoleDelta), observed);

  logStep("Calling browser_page_assets");
  const assets = parsePayload(await client.callTool({ name: "browser_page_assets", arguments: {} }));
  assertOk("page_assets returned assets", Array.isArray(assets.assets) && assets.assets.length === 2, assets);
  assertEq("page_assets pageHash", assets.pageHash, "abc123");

  logStep("Calling browser_set_storage");
  const stored = parsePayload(await client.callTool({ name: "browser_set_storage", arguments: { localStorage: { token: "abc" }, cookies: [{ name: "token", value: "abc" }] } }));
  assertEq("set_storage localSet", stored.localSet, 1);
  assertOk("set_storage cookie set", stored.cookies?.[0]?.success === true, stored);

  logStep("Calling browser_session_health with heal:true");
  const healed = parsePayload(await client.callTool({ name: "browser_session_health", arguments: { heal: true } }));
  assertOk("session_health healed", !!healed.healed && Array.isArray(healed.healed.healedTabs), healed);

  // ----- 9d) request_attention round-trips through the broker (0.5.0) -----
  logStep("Calling browser_request_attention");
  const attnRes = parsePayload(await client.callTool({ name: "browser_request_attention", arguments: { reason: "look here" } }));
  assertOk("request_attention ok", attnRes.ok === true, attnRes);
  assertEq("request_attention reason echoed", attnRes.reason, "look here");

  // ----- 9e) /os/open-notification-settings HTTP route is reachable (0.5.0) -----
  // (regression guard: it must NOT 404 behind the /claude/ path prefix gate)
  logStep("Hitting /os/open-notification-settings over HTTP");
  const osResp = await fetch(`http://127.0.0.1:${TEST_PORT}/os/open-notification-settings`, { method: "POST" });
  assertEq("os route status 200 (not 404)", osResp.status, 200);
  const osBody = await osResp.json();
  assertOk("os route returns a boolean ok", typeof osBody.ok === "boolean", osBody);

  // ----- 10) Confirm wire types the broker actually forwarded -----
  logStep("Verifying wire types reached the fake extension");
  const types = ext.calls.map((c) => c.type);
  for (const expected of ["session_start", "navigate", "evaluate", "console_messages", "network_requests", "snapshot", "text", "links", "click", "audit_interactives", "wait_for_response", "page_assets", "set_storage", "session_heal"]) {
    assertOk(`extension received: ${expected}`, types.includes(expected));
  }

  logStep("Cleanup");
  await client.callTool({ name: "browser_session_end", arguments: {} }).catch(() => {});
  ext.close();
  await client.close();
  await sleep(100);

  console.log("\n========== ALL INTEGRATION CHECKS PASSED ==========");
  console.log(`tools: ${names.length} | wire types covered: ${types.length} | server stderr lines: ${serverErr.join("").split("\n").length}`);
  if (process.env.DUMP_SERVER_ERR) console.log("\n--- server stderr ---\n" + serverErr.join(""));
  process.exit(0);
}

main().catch((e) => {
  console.error("\n✗ INTEGRATION FAILED:", e);
  process.exit(1);
});

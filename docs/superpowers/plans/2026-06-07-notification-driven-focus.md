# Notification-driven Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop browser automation from stealing OS focus; instead post click-to-focus OS notifications (on session start, on errors/dialogs/crash, and on an explicit agent request), each naming the project, with a non-technical macOS permission onboarding flow.

**Architecture:** Per-project MCP server injects `label = basename(cwd)` into `session_start`. The extension stores `session.label`, never auto-raises the window (default `bringToFront:false`), and posts `chrome.notifications`; `notifications.onClicked` is the only path that focuses a window. A new `browser_request_attention` tool + additive `chrome.debugger` observers (dialog/crash) + the auto-recover failure path feed the same `notify()` helper. The popup gains a notifications toggle + test/confirm/deep-link onboarding; the broker exposes `/os/open-notification-settings` to open the macOS Notifications pane.

**Tech Stack:** Node 22 ESM (MCP server, esbuild bundle), Chrome MV3 extension (service worker), `chrome.notifications`, `chrome.debugger` (CDP), WebSocket broker.

**Spec:** `docs/superpowers/specs/2026-06-07-notification-driven-focus-design.md`

---

## Task 1: Server — project label + `browser_request_attention` tool

**Files:**
- Modify: `server/src/tools.js`

- [ ] **Step 1: Add `PROJECT_LABEL` constant** near the other module state (after line ~30, `path` already imported):

```js
// Human label for notifications/tab-group title. Each project gets its own
// MCP server process launched with cwd = project root, so basename(cwd) is a
// reliable per-project name even though one shared broker serves all projects.
const PROJECT_LABEL = path.basename(process.cwd()) || "Mochi";
```

- [ ] **Step 2: Flip `browser_session_start` schema default + description.** Replace the `bringToFront` property (line ~73) and the tool description (line ~62):

```js
description:
  "Start a new browser session. Creates a Chrome tab group with an initial tab; all subsequent operations are scoped to that group. Pass newWindow=true to spawn a fresh Chrome window. By default automation does NOT raise the Chrome window to the OS foreground — instead the extension posts a notification (the user clicks it to bring the window forward). The tab is always made active within its window (prevents Chrome throttling). Pass bringToFront:true to force the window forward (e.g. you want to watch). Idempotent: ends a previous session first.",
```
```js
bringToFront: { type: "boolean", default: false, description: "Raise the new window to OS foreground on start (steals focus). Default false in 0.5.0+ — a click-to-focus notification is posted instead. The tab is always made active within its window regardless." },
```

- [ ] **Step 3: Add the `browser_request_attention` tool** to the `tools` array, right after the `browser_session_end` entry (line ~91):

```js
{
  name: "browser_request_attention",
  description:
    "Post an OS notification asking the human to look at this browser session — e.g. a suspected captcha/login wall, an ambiguous choice you want them to make, or 'task finished — come look'. Does NOT steal focus; the user clicks the notification to bring the window forward. Use sparingly — only when you genuinely need the human or want them to see a result.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Short message shown in the notification." },
      tabId:  { type: "number", description: "Optional tab to focus when the user clicks the notification." },
      urgent: { type: "boolean", default: true, description: "Keep the notification on screen until the user acts (requireInteraction)." },
    },
    required: ["reason"],
  },
},
```

- [ ] **Step 4: Register the wire mapping.** Add to `TOOL_TO_WS_TYPE` (line ~733):

```js
  browser_request_attention: "request_attention",
```

- [ ] **Step 5: Inject the label in `runWireTool`'s session_start branch** (line ~1070). Replace the branch body:

```js
  if (name === "browser_session_start") {
    trace.reset();
    activeOrigin = null;
    lastKnownUrl = null;
    const startArgs = { ...args };
    if (!startArgs.title) startArgs.title = PROJECT_LABEL;
    startArgs.label = startArgs.label || startArgs.title || PROJECT_LABEL;
    const result = await bridge.send(wsType, startArgs);
    trace.reset(result.sessionId);
    return result;
  }
```

- [ ] **Step 6: Run smoke + integration after Task 4 test updates** (see Task 6). Defer running until tests are updated.

---

## Task 2: Extension — notification helper + click-to-focus + manifest permission

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`

- [ ] **Step 1: Add the `notifications` permission** in `extension/manifest.json`:

```json
  "permissions": [
    "tabs", "tabGroups", "scripting", "storage", "alarms", "activeTab", "debugger", "notifications"
  ],
```

- [ ] **Step 2: Add notification state + helper** in `background.js` after the `attachedTabs` set (line ~37):

```js
// notificationId → { clientId, windowId?, tabId? } so a click can focus the
// right window. The ONLY place we ever raise a window to the OS foreground.
const notifTargets = new Map();

// User prefs for OS notifications (mirrored from chrome.storage.local).
const notifPrefs = { enabled: true, verified: false };
chrome.storage.local.get(["notifEnabled", "notifVerified"]).then((o) => {
  if (typeof o.notifEnabled === "boolean") notifPrefs.enabled = o.notifEnabled;
  if (typeof o.notifVerified === "boolean") notifPrefs.verified = o.notifVerified;
}).catch(() => {});

async function notify(clientId, { kind = "info", message = "", requireInteraction = false } = {}) {
  if (!notifPrefs.enabled) {
    // Fallback nudge for users who turned toasts off: a dot on the toolbar icon.
    try { chrome.action.setBadgeText({ text: "•" }); } catch {}
    return false;
  }
  const s = clientId ? sessions.get(clientId) : null;
  const label = (s && s.label) || "Mochi";
  const notificationId = `mochi:${clientId || "global"}:${kind}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/mochi-128.png"),
      title: `Mochi · ${label}`,
      message: String(message || "").slice(0, 250),
      requireInteraction: !!requireInteraction,
      priority: requireInteraction ? 2 : 0,
    });
    notifTargets.set(notificationId, s
      ? { clientId, windowId: s.windowId, tabId: s.primaryTabId }
      : { clientId });
    return true;
  } catch { return false; }
}

chrome.notifications.onClicked.addListener(async (id) => {
  const target = notifTargets.get(id);
  try { await chrome.notifications.clear(id); } catch {}
  notifTargets.delete(id);
  if (!target) return;
  if (target.windowId != null) {
    try { await chrome.windows.update(target.windowId, { focused: true }); } catch {}
  }
  if (target.tabId != null) {
    try { await chrome.tabs.update(target.tabId, { active: true }); } catch {}
  }
});
chrome.notifications.onClosed.addListener((id) => { notifTargets.delete(id); });
```

- [ ] **Step 3: Verify** — load the unpacked extension in `chrome://extensions`, confirm no manifest errors and the service worker boots (DevTools console clean).

---

## Task 3: Extension — stop focus stealing, store label, notify on start; request_attention; auto-recover error notify; dialog/crash observers

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Flip `sessionStart` default + capture label** (line ~911). Change the destructure:

```js
  const {
    title = "AI Session", color = "blue", url = "about:blank",
    newWindow = false, width, height, left, top, state,
    bringToFront = false,
    label,
    visuals,
  } = input;
```

- [ ] **Step 2: Store the label on the session** (line ~957, inside the `session` object literal add a field):

```js
    label: label || (title && title !== "AI Session" ? title : `Session ${clientId.slice(-4)}`),
```

- [ ] **Step 3: Notify on start instead of focusing** — after `schedulePersistSessions();` (line ~969) add:

```js
  // 0.5.0: announce via a click-to-focus notification rather than stealing OS
  // focus. When bringToFront is true the window was already raised above, so
  // skip the toast.
  if (!bringToFront) {
    notify(clientId, {
      kind: "start",
      message: "Automation started — click to bring the window forward.",
    }).catch(() => {});
  }
```

- [ ] **Step 4: Add the `request_attention` dispatch case** (line ~877, in the `dispatch` switch):

```js
    case "request_attention":  return requestAttention(p, clientId);
```

- [ ] **Step 5: Implement `requestAttention`** right after `sessionStart`/`forceCleanupClient` (e.g. after line ~1044):

```js
async function requestAttention({ reason, tabId, urgent = true } = {}, clientId) {
  const s = clientId ? sessions.get(clientId) : null;
  const shown = await notify(clientId, {
    kind: "attention",
    message: reason || "Mochi needs your attention.",
    requireInteraction: urgent !== false,
  });
  // If a specific tab was named, point the click target at it.
  if (s && tabId != null && s.tabIds.has(tabId)) {
    notifTargets.set(`mochi:${clientId}:attention`, { clientId, windowId: s.windowId, tabId });
  }
  return { ok: true, notified: shown, hasSession: !!s, reason: reason ?? null };
}
```

- [ ] **Step 6: Notify on unrecoverable session loss** in `dispatchWithAutoRecover` (line ~838). Replace the `if (!cfg) throw e;` line:

```js
    const cfg = await getCachedSessionConfig(clientId);
    if (!cfg) {
      notify(clientId, {
        kind: "error",
        message: "The browser session was lost and could not be restored. Click to check.",
        requireInteraction: true,
      }).catch(() => {});
      throw e;
    }
```

- [ ] **Step 7: Add `Inspector.enable`** to the attach sequence (line ~379, after `Network.enable`):

```js
  try { await chrome.debugger.sendCommand({ tabId }, "Inspector.enable"); } catch {}
```

- [ ] **Step 8: Add dialog + crash observers** to the `chrome.debugger.onEvent` switch. Insert new cases after `Runtime.exceptionThrown` (line ~592). These are pure observers — they send no CDP command, so dialog handling is unchanged:

```js
      case "Page.javascriptDialogOpening": {
        const cid = tabOwner.get(tabId);
        if (cid) {
          const kindLabel = params?.type ? params.type : "dialog";
          const msg = params?.message ? String(params.message).slice(0, 160) : "";
          notify(cid, {
            kind: "dialog",
            message: `The page opened a ${kindLabel}${msg ? `: ${msg}` : ""}. Click to take a look.`,
            requireInteraction: true,
          }).catch(() => {});
        }
        break;
      }
      case "Inspector.targetCrashed": {
        const cid = tabOwner.get(tabId);
        if (cid) {
          notify(cid, {
            kind: "crash",
            message: "The page crashed. Click to take a look.",
            requireInteraction: true,
          }).catch(() => {});
        }
        break;
      }
```

- [ ] **Step 9: Verify** — reload extension; start a session via the MCP and confirm a "Automation started" toast appears, no focus steal; click it → window focuses.

---

## Task 4: Extension — popup notifications toggle + onboarding (test/confirm/deep-link)

**Files:**
- Modify: `extension/background.js` (popup message handlers)
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`

- [ ] **Step 1: Add popup message handlers** in the `chrome.runtime.onMessage` listener (line ~2346, before the final `else`):

```js
      } else if (req?.type === "popup_notif_status") {
        let permission = "granted";
        try { permission = await new Promise((r) => chrome.notifications.getPermissionLevel(r)); } catch {}
        sendResponse({ enabled: notifPrefs.enabled, verified: notifPrefs.verified, permission });
      } else if (req?.type === "popup_set_notif_enabled") {
        notifPrefs.enabled = !!req.enabled;
        await chrome.storage.local.set({ notifEnabled: notifPrefs.enabled });
        if (notifPrefs.enabled) { try { chrome.action.setBadgeText({ text: "" }); } catch {} }
        sendResponse({ enabled: notifPrefs.enabled });
      } else if (req?.type === "popup_set_notif_verified") {
        notifPrefs.verified = !!req.verified;
        await chrome.storage.local.set({ notifVerified: notifPrefs.verified });
        sendResponse({ verified: notifPrefs.verified });
      } else if (req?.type === "popup_send_test_notification") {
        let ok = false;
        try {
          await chrome.notifications.create("mochi:global:test", {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/mochi-128.png"),
            title: "Mochi · Test",
            message: "If you can see this, notifications are working! 🎉",
            requireInteraction: false,
          });
          notifTargets.set("mochi:global:test", {});
          ok = true;
        } catch {}
        sendResponse({ ok });
      } else if (req?.type === "popup_open_os_notification_settings") {
        let ok = false;
        try {
          const r = await fetch(`http://127.0.0.1:9009/os/open-notification-settings`, { method: "POST" });
          ok = r.ok;
        } catch {}
        sendResponse({ ok });
```

> Note: the broker host:port matches the extension's `WS_URL` (`127.0.0.1:9009`). If `SUPER_TESTER_WS_PORT` is customized, derive the port from `WS_URL` instead of hardcoding.

- [ ] **Step 2: Add the Notifications section markup** in `popup.html` after the Visuals section (line ~253):

```html
    <div class="section" id="notif-section">
      <div class="section-title">Notifications</div>
      <div class="kv"><span class="k">OS notifications</span>
        <label class="switch">
          <input type="checkbox" id="notif-switch" />
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div id="notif-onboard" style="display:none; margin-top:6px;">
        <div class="empty-state" id="notif-onboard-text" style="padding-top:2px;">
          Let Mochi tap you on the shoulder when it needs you — instead of jumping in front of your work.
        </div>
        <button class="btn" id="notif-test-btn" style="width:100%; margin-top:6px;">Send test notification</button>
        <div id="notif-confirm" style="display:none; margin-top:8px;">
          <div class="empty-state" style="padding-top:0;">Did a notification appear in the corner of your screen?</div>
          <div style="display:flex; gap:8px; margin-top:6px;">
            <button class="btn primary" id="notif-yes-btn" style="flex:1;">Yes, I saw it</button>
            <button class="btn" id="notif-no-btn" style="flex:1;">No</button>
          </div>
        </div>
        <div id="notif-help" style="display:none; margin-top:8px;">
          <div class="empty-state" style="padding-top:0; line-height:1.5;">
            macOS is hiding Chrome's notifications. To fix it:
            <br/>1. Click <b>Open notification settings</b>
            <br/>2. Find <b>Google Chrome</b> in the list
            <br/>3. Turn on <b>Allow Notifications</b>
            <br/>4. Come back and tap <b>Send test notification</b> again
          </div>
          <button class="btn primary" id="notif-open-settings-btn" style="width:100%; margin-top:6px;">Open notification settings</button>
        </div>
        <div class="status" id="notif-status" style="margin-top:6px;"></div>
      </div>
    </div>
```

- [ ] **Step 3: Add popup JS** at the end of `popup.js`:

```js
// ---------- Notifications ----------
const notifEls = {
  sw:      () => document.getElementById("notif-switch"),
  onboard: () => document.getElementById("notif-onboard"),
  test:    () => document.getElementById("notif-test-btn"),
  confirm: () => document.getElementById("notif-confirm"),
  help:    () => document.getElementById("notif-help"),
  status:  () => document.getElementById("notif-status"),
};

async function refreshNotif() {
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "popup_notif_status" }); } catch { return; }
  if (!res) return;
  const sw = notifEls.sw();
  if (sw && document.activeElement !== sw) sw.checked = !!res.enabled;
  // Show onboarding until verified (and only when notifications are enabled).
  notifEls.onboard().style.display = (res.enabled && !res.verified) ? "block" : "none";
}

notifEls.sw().addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "popup_set_notif_enabled", enabled: e.target.checked });
  refreshNotif();
});

notifEls.test().addEventListener("click", async () => {
  notifEls.status().textContent = "";
  await chrome.runtime.sendMessage({ type: "popup_send_test_notification" });
  notifEls.confirm().style.display = "block";
  notifEls.help().style.display = "none";
});

document.getElementById("notif-yes-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_set_notif_verified", verified: true });
  notifEls.confirm().style.display = "none";
  notifEls.status().className = "status ok";
  notifEls.status().textContent = "🎉 You're all set!";
  setTimeout(refreshNotif, 1200);
});

document.getElementById("notif-no-btn").addEventListener("click", () => {
  notifEls.confirm().style.display = "none";
  notifEls.help().style.display = "block";
});

document.getElementById("notif-open-settings-btn").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "popup_open_os_notification_settings" });
  notifEls.status().className = r?.ok ? "status ok" : "status err";
  notifEls.status().textContent = r?.ok
    ? "Opened macOS settings — enable Google Chrome, then test again."
    : "Couldn't open settings automatically. Open System Settings → Notifications → Google Chrome.";
});

refreshNotif();
setInterval(refreshNotif, 2000);
```

- [ ] **Step 4: Verify** — open the popup, toggle works; "Send test notification" → toast; "Yes" hides onboarding and persists; "No" shows the deep-link help.

---

## Task 5: Broker — `/os/open-notification-settings` route

**Files:**
- Modify: `server/src/bridge.js`

- [ ] **Step 1: Import `child_process`** at the top of `bridge.js` (with the other node imports):

```js
import { exec } from "node:child_process";
```

- [ ] **Step 2: Handle the route** in `_handleHttpRequest`. It must run BEFORE the `if (req.method !== "POST")` guard is fine (this is POST), so add it inside the POST branch alongside the `/claude/*` handlers (line ~314, before the final 404):

```js
      if (p === "/os/open-notification-settings") {
        if (process.platform !== "darwin") {
          return this._respondJson(res, 200, { ok: false, reason: "not-macos" });
        }
        try {
          exec('open "x-apple.systempreferences:com.apple.preference.notifications"');
          return this._respondJson(res, 200, { ok: true });
        } catch (e) {
          return this._respondJson(res, 200, { ok: false, reason: String(e?.message ?? e) });
        }
      }
```

- [ ] **Step 3: Verify** — `curl -X POST http://127.0.0.1:9009/os/open-notification-settings` (with a broker running) returns `{"ok":true}` on macOS and opens the Notifications pane.

---

## Task 6: Tests — update counts + assertions, add request_attention coverage

**Files:**
- Modify: `server/_smoke.mjs`
- Modify: `server/_integration.mjs`

- [ ] **Step 1: Add `browser_request_attention` to `_smoke.mjs`'s `want` array** and assert the session_start default:

```js
  "browser_request_attention",
```
After the snapshot defaults block, add:
```js
const ss = tools.find(t => t.name === "browser_session_start");
if (ss.inputSchema.properties.bringToFront.default !== false) {
  console.error("session_start bringToFront default should be false in 0.5.0"); process.exit(1);
}
const ra = tools.find(t => t.name === "browser_request_attention");
if (!ra || ra.inputSchema.properties.reason == null) { console.error("request_attention schema bad"); process.exit(1); }
console.log("✓ session_start defaults to no-focus + browser_request_attention present");
```

- [ ] **Step 2: Bump the tool count in `_integration.mjs`** (line 195):

```js
  assertEq("total tool count", names.length, 55);
```

- [ ] **Step 3: Add a `request_attention` case to the fake extension** in `_integration.mjs` `startFakeExtension` switch (so a tool call round-trips):

```js
      case "request_attention":
        result = { ok: true, notified: true, hasSession: true, reason: params?.reason ?? null };
        break;
```

- [ ] **Step 4: Add a tool-call assertion** in `_integration.mjs` after an existing session is started (near the other `client.callTool` checks):

```js
  const attn = parsePayload(await client.callTool({ name: "browser_request_attention", arguments: { reason: "look here" } }));
  assertOk("request_attention ok", attn.ok === true, attn);
```

- [ ] **Step 5: Run the full server suite:**

Run: `cd server && npm test`
Expected: all green; smoke reports `total tool count: 55`.

- [ ] **Step 6: Commit** server + extension + tests:

```bash
git add server/src/tools.js server/src/bridge.js server/_smoke.mjs server/_integration.mjs extension/manifest.json extension/background.js extension/popup.html extension/popup.js
git commit -m "feat(notifications): click-to-focus notifications + request_attention (no focus steal)"
```

---

## Task 7: Versions, docs, bundle rebuild

**Files:**
- Modify: `.claude-plugin/plugin.json`, `server/package.json`
- Modify: `CHANGELOG.md`, `README.md`
- Rebuild: `server/dist/server.bundle.mjs`

- [ ] **Step 1: Bump versions** to `0.5.0` in `.claude-plugin/plugin.json` and `server/package.json`.

- [ ] **Step 2: README** — change `54 tools` → `55 tools` (line 139); add a short "Notifications (no focus stealing)" paragraph documenting the one-time extension reload + macOS Notifications step.

- [ ] **Step 3: CHANGELOG** — add a `0.5.0` entry describing the change (focus behavior, new tool, macOS onboarding, +1 tool count).

- [ ] **Step 4: Rebuild the bundle:**

Run: `cd server && npm run build`
Expected: `dist/server.bundle.mjs` regenerated, no errors.

- [ ] **Step 5: Re-run smoke against the build sanity** and commit:

```bash
cd server && npm run test:smoke
git add .claude-plugin/plugin.json server/package.json CHANGELOG.md README.md server/dist/server.bundle.mjs server/dist/server.bundle.mjs.LEGAL.txt
git commit -m "chore(release): 0.5.0 — notifications, tool count 55, bundle + docs"
```

---

## Manual verification checklist (post-implementation)

- [ ] Reload unpacked extension (new `notifications` permission).
- [ ] Start a session → "Automation started" toast, **no** focus steal; click → window focuses.
- [ ] Run several `browser_navigate` → focus never leaves your editor.
- [ ] Call `browser_request_attention({reason})` → persistent toast titled `Mochi · <project>`; click → focuses session window/tab.
- [ ] Trigger a JS `alert()` on a page → dialog toast appears.
- [ ] Popup: toggle off suppresses toasts; "Send test notification" + Yes/No onboarding works; "Open notification settings" opens the macOS pane.

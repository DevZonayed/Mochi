# Notification-driven focus — design

**Date:** 2026-06-07
**Status:** Approved (brainstorming) — pending spec review
**Version target:** `0.5.0`
**Author:** Mochi plugin (DevZonayed/riga)

## Problem

Browser automation still raises the Chrome window to the macOS foreground and
steals keyboard focus at certain moments. 0.4.1 fixed this for
`browser_navigate` (default `bringToFront:false`), but `browser_session_start`
still defaults to `bringToFront:true`, and `browser_window_resize` can surface
the window via state changes. When the user is doing something else (typing in
an editor, another app), the automation window yanks focus away.

The user wants the opposite default: automation **never** pulls focus on its
own. Instead, the extension posts an **OS notification**. The window only comes
forward when the **user clicks the notification**. The notification must name
the **project/session** that wants attention, so with multiple sessions running
the user knows who is asking.

## Goals

1. Automation never raises the Chrome window to the OS foreground automatically.
   The session tab stays `active:true` *inside* its window (prevents Chrome
   hidden-tab throttling that breaks SPAs), but OS-level focus is never grabbed
   unless the user clicks a notification (or a caller explicitly passes
   `bringToFront:true`).
2. The extension posts OS notifications on:
   - **Session start** (replaces the old auto-focus), and
   - **Attention-worthy moments** — a hybrid of automatic detection and an
     explicit agent-triggered tool.
3. Clicking a notification raises + focuses that session's window and its tab.
   This is the **only** code path that brings the window forward.
4. Notifications name the project/session (`Mochi · <project>`).
5. A first-run, non-technical-friendly onboarding flow verifies that macOS will
   actually display Chrome's notifications, and walks the user through enabling
   them if not.

## Non-goals

- Reading the macOS System Settings notification toggle via an API (not
  possible from a Chrome extension — see "macOS permission" below).
- Linking the browser session to the `/mochi:rename` Claude-session name
  (deferred; `basename(cwd)` is reliable and always available today).
- Auto-detecting captchas/login walls heuristically (the agent flags these via
  the explicit tool instead).

## Approach decisions (resolved during brainstorming)

- **Triggers:** notify on **session start** + **attention-worthy events**
  (user picked options A + C).
- **Attention mechanism:** **hybrid** — automatic for unambiguous events
  (errors, native JS dialogs, page crash) **plus** an explicit
  `browser_request_attention` tool for agent judgment calls.
- **Notification delivery:** OS toasts via `chrome.notifications` (vs. a toolbar
  badge or in-page banner, which are too easy to miss).
- **macOS permission:** confirm-probe handshake + deep-link button (a silent API
  read of the OS toggle is impossible), optimized for a non-technical user.

## Architecture context (as-is)

- **Two identity systems:**
  - *Browser session* — lives in `extension/background.js`, keyed by `clientId`
    (`sessions` Map): `{ id, clientId, groupId, windowId, primaryTabId, tabIds,
    ownsWindow }` plus a tab-group `title` (defaults to `"AI Session <id>"`).
  - *Claude session* — lives server-side in `server/src/bridge.js`
    (`claudeSessions` Map): `{ name, projectDir, ... }`, set/renamed by the
    continuum plugin via `/claude/*` HTTP routes. **Not linked to `clientId`.**
- **Process model:** one **broker** (first MCP process to bind port 9009) holds
  the WS to the extension and the `/claude/*` HTTP routes; other projects'
  MCP servers become **clients** of that broker. **Each project gets its own
  MCP server process, launched with `cwd` = that project root.** So
  `basename(process.cwd())` of the per-project MCP process is the reliable
  project label.
- **Messaging seams:**
  - popup → background: `chrome.runtime.sendMessage({ type: "popup_*" })`,
    listener at `extension/background.js:2240`.
  - background → broker: WebSocket `ws.send(...)` (`background.js:757`).
  - broker HTTP: `bridge._handleHttpRequest` already serves `/claude/*`; can
    host a new `/os/*` route.
- **Focus today:** `sessionStart` (`background.js:~929` create / `~946` update),
  `navigate` (`~1057`), `window_resize` (`~1379-1389`).

## Design

### 1. Stop automatic focus-stealing

- `browser_session_start`: flip `bringToFront` default **`true` → `false`** in
  both the tool schema (`server/src/tools.js`) and the extension handler
  (`background.js` `sessionStart` destructuring). When `bringToFront` is falsy,
  do **not** call `chrome.windows.update({focused:true})` / create with
  `focused:true`; instead post a "session started" notification. Tab still
  created `active:true`.
- `browser_navigate`: already `false` since 0.4.1 — unchanged.
- `browser_window_resize`: set bounds/state without requesting OS focus. Note in
  the schema description that `maximized`/`fullscreen` may inherently surface the
  window; that is OS behavior, not an explicit focus request.
- **Escape hatch preserved:** passing `bringToFront:true` on any of these still
  force-focuses (for "watch it work" / "show me" moments).

### 2. Project label plumbing (notifications name the session)

- In `server/src/tools.js`, compute `PROJECT_LABEL = path.basename(process.cwd())`
  once at module init.
- In `handleToolCall`, for `browser_session_start`: if the caller did not pass a
  `title`, default `params.title = PROJECT_LABEL`; always forward an explicit
  `params.label = params.title || PROJECT_LABEL` field.
- In `background.js` `sessionStart`, store `session.label` on the session object
  and use it for: the tab-group title (nice side benefit) **and** every
  notification for that `clientId`.
- Notification title format: **`Mochi · <label>`**.

### 3. Notification infrastructure (extension)

- **Manifest:** add `"notifications"` to `extension/manifest.json` permissions.
  ⚠ Requires a one-time "reload unpacked extension" by the user.
- **Helper** `notify(clientId, { kind, message, requireInteraction })` in
  `background.js`:
  - Stable `notificationId = "mochi:" + clientId + ":" + kind` so repeat events
    of the same kind **update in place** instead of stacking.
  - `type: "basic"`, `iconUrl: chrome.runtime.getURL("icons/mochi-128.png")`,
    `title: "Mochi · " + label`, `message`, `requireInteraction`.
  - No-op (early return) when the user has notifications toggled off (see §5) —
    in that case set a toolbar badge as a fallback signal (see §6).
  - Maintain `notifById = Map(notificationId → { clientId, windowId, tabId })`.
- **Click → focus (the only window-raise path):**
  `chrome.notifications.onClicked(id)` → look up `{ windowId, tabId }` →
  `chrome.windows.update(windowId, { focused: true })` +
  `chrome.tabs.update(tabId, { active: true })` → `chrome.notifications.clear(id)`.
- `chrome.notifications.onClosed(id)` → delete the `notifById` entry.

### 4. Event sources (hybrid)

**Automatic (extension-detected):**

- **Session start** → `notify(clientId, { kind: "start",
  message: "Automation started — click to view", requireInteraction: false })`.
  Fires in place of the old auto-focus.
- **Unrecoverable automation error** → in `dispatchWithAutoRecover`'s failure
  path (after auto-recovery fails: session lost / target gone), `notify(...,
  { kind: "error", message: "Hit an error: <short>", requireInteraction: true })`.
  Scoped narrowly so routine retryable failures do not spam.
- **Native JS dialog** (`alert`/`confirm`/`prompt`/`beforeunload`) and **page
  crash** → `notify(..., { kind: "dialog" | "crash", requireInteraction: true })`.
  Detected via existing `chrome.debugger` events
  (`Page.javascriptDialogOpening`, `Inspector.targetCrashed` /
  `Target.targetCrashed`). **Risk/staging:** this is the least-certain piece. If
  it complicates the core, ship start + error + explicit-tool first and add
  dialog/crash detection as a fast-follow behind the same `notify()` helper.

**Explicit (agent-triggered) — new tool `browser_request_attention`:**

- Schema (`server/src/tools.js`):
  ```
  name: "browser_request_attention"
  description: "Post an OS notification asking the human to look at this browser
    session — e.g. a suspected captcha/login wall, an ambiguous choice you want
    them to make, or 'task finished — come look'. Does NOT steal focus; the user
    clicks the notification to bring the window forward. Use sparingly — only
    when you genuinely need the human or want them to see a result."
  inputSchema:
    reason: { type: "string" }            // required, shown in the toast
    tabId: { type: "number" }             // optional
    urgent: { type: "boolean", default: true }  // requireInteraction
  required: ["reason"]
  ```
- Routing: `handleToolCall` maps it to bridge command type `request_attention`;
  `background.js` `dispatch` adds a `case "request_attention"` →
  `notify(clientId, { kind: "attention", message: reason,
  requireInteraction: !!urgent })`.
- **Tool count 54 → 55.**

### 5. Popup notification toggle

- A single "Notifications" on/off control in `extension/popup.html` /
  `popup.js`, default **on**, persisted in `chrome.storage.local`
  (`notifEnabled`). `notify()` consults it and no-ops when off.

### 6. macOS permission onboarding (non-technical UX)

**Why a handshake, not an API read:** a Chrome extension cannot read the macOS
System Settings notification toggle. `chrome.notifications.getPermissionLevel()`
reports only Chrome's *own* setting (`granted`/`denied`), not the OS toggle.
When macOS has Chrome notifications off, `chrome.notifications.create()` silently
no-ops with no error and no callback signal — so "check if enabled" must
actually *test delivery* and ask the user to confirm.

**State (in `chrome.storage.local`):** `notifEnabled` (default true),
`notifVerified` (default false).

**Flow (driven from the popup; copy is plain-language, no jargon):**

1. **Chrome-level check (reliable):** on popup open, background reports
   `getPermissionLevel()`. If `"denied"`, show a friendly banner: "Chrome has
   notifications turned off" with guidance toward Chrome's own setting.
2. **First-run card** (shown when `notifVerified` is false): a short, friendly
   card —
   > 🔔 **Let Mochi tap you on the shoulder**
   > Mochi will send a small notification when it needs you — instead of jumping
   > in front of whatever you're working on.
   > **[ Send test notification ]**
3. **Confirm-probe:** the button fires a real test toast via `notify(...,
   { kind: "test" })`, then the card asks:
   > Did a notification appear in the top-right corner of your screen?
   > **[ Yes, I saw it ]   [ No, I didn't ]**
   - **Yes** → set `notifVerified = true`; show "🎉 You're all set!"; never nag
     again.
   - **No** → show numbered, illustrated steps and a one-click button:
     > macOS is hiding Chrome's notifications. Let's turn them on:
     > 1. Click **[ Open notification settings ]**
     > 2. Find **Google Chrome** in the list
     > 3. Turn on **Allow Notifications**
     > 4. Come back and click **[ Send test notification ]** again
4. **Deep-link button** ("Open notification settings"): popup →
   `chrome.runtime.sendMessage({ type: "popup_open_os_notification_settings" })`
   → background `fetch` to the broker's HTTP origin (same host:port as the
   extension's existing WS connection — default `127.0.0.1:9009`, configurable
   via `SUPER_TESTER_WS_PORT`) at `/os/open-notification-settings`
   → broker handles `/os/open-notification-settings` in `_handleHttpRequest`
   and runs (guarded to `process.platform === "darwin"`):
   `child_process.exec('open "x-apple.systempreferences:com.apple.preference.notifications"')`,
   dropping the user directly on the macOS **Notifications** pane. On non-macOS
   platforms the route returns a friendly "not applicable" payload and the popup
   shows manual instructions instead.
5. **Never block automation:** if unverified, browser work still runs. As a
   fallback nudge, set a toolbar badge (e.g. "!") with title "Click to set up
   Mochi notifications" so a user who never opens the popup is still prompted.
   Best-effort `chrome.action.openPopup()` may be attempted once on first
   session but is not relied upon (MV3 support is flaky).

**New popup ↔ background messages:** `popup_notif_status` (returns
`getPermissionLevel`, `notifEnabled`, `notifVerified`),
`popup_send_test_notification`, `popup_set_notif_verified`,
`popup_set_notif_enabled`, `popup_open_os_notification_settings`.

### 7. Versioning & artifacts

- `.claude-plugin/plugin.json`: `0.4.1 → 0.5.0`.
- `server/package.json`: `0.4.1 → 0.5.0`.
- `extension/manifest.json`: add `notifications` permission (optionally bump the
  extension `version` for clarity; it is loaded unpacked).
- `CHANGELOG.md`: new `0.5.0` entry.
- `README.md`: tool count `54 → 55` (line 139); add a "notifications / no focus
  stealing" capability paragraph; document the one-time reload + macOS step.
- `server/dist/server.bundle.mjs`: rebuild via esbuild (CI rebuilds on push to
  master; also build locally for testing).

### 8. Testing

- `server/_smoke.mjs` — expect **55** tools; assert `browser_request_attention`
  present.
- `server/_integration.mjs:195` — bump `assertEq("total tool count", ..., 54)`
  to `55`; add a routing assertion for `request_attention`; assert
  `browser_session_start` schema `bringToFront` default is `false`.
- Label injection unit check: `browser_session_start` without `title` forwards
  `title`/`label` = `basename(cwd)`.
- Extension-side (popup synthetic harness): `notify()` builds the correct
  `notificationId`/title; `onClicked` focuses the mapped window/tab; toggle-off
  no-ops; confirm-probe state transitions (`notifVerified`).
- **Manual:** real toast on session start; on `browser_request_attention`; click
  → window focuses; a multi-`navigate` flow never steals focus; the macOS
  onboarding deep-link opens the Notifications pane; toggle off suppresses toasts.

## Risks & call-outs

- **One-time extension reload** is unavoidable (new manifest permission).
- **macOS toggle is not API-readable** — the confirm-probe is the robust
  substitute; document clearly.
- **Dialog/crash detection via `chrome.debugger`** is the least-certain piece;
  staged as a fast-follow if it threatens the core (§4).
- **Notification fatigue** — mitigated by stable per-kind `notificationId`
  (update-in-place), narrow error scoping, "use sparingly" guidance on the
  explicit tool, and the popup off switch.

## File touch list (for planning)

- `server/src/tools.js` — `browser_request_attention` schema; `session_start`
  schema (`bringToFront` default false + description); `PROJECT_LABEL` +
  label/title injection in `handleToolCall`; `request_attention` routing.
- `server/src/bridge.js` — `/os/open-notification-settings` route in
  `_handleHttpRequest` (macOS-guarded `child_process.exec`).
- `extension/manifest.json` — `notifications` permission.
- `extension/background.js` — `notify()` helper + `notifById`;
  `notifications.onClicked`/`onClosed`; `sessionStart` default flip + label store
  + start notification; `dispatch` `request_attention` case; error notification
  in `dispatchWithAutoRecover`; (staged) debugger dialog/crash listeners;
  popup-message handlers; fallback badge.
- `extension/popup.html` + `extension/popup.js` — notifications toggle +
  onboarding card (test/confirm/deep-link), plain-language copy.
- `server/_smoke.mjs`, `server/_integration.mjs` — counts + assertions.
- `.claude-plugin/plugin.json`, `server/package.json`, `CHANGELOG.md`,
  `README.md` — version + docs.
- `server/dist/server.bundle.mjs` — rebuild.

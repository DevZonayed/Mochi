// Super-Tester Browser Bridge — service worker.
// Owns: WebSocket to MCP broker, a Map of active sessions (one per Claude
// Code session / MCP client), per-session tab groups, and chrome.debugger
// (CDP) attachments. Boundary listeners find the right session per-tab.

import { handleUploadFile } from "./upload.js";

const WS_URL = "ws://127.0.0.1:9009";
const NAV_TIMEOUT_MS = 30000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const SESSION_STATE_KEY = "superTesterSessionsV1";
const PERSIST_DEBOUNCE_MS = 75;

let ws = null;
let connectionEnabled = true;
let reconnectAttempts = 0;
let reconnectTimer = null;
// "active" = receiving/dispatching commands. "standby" = WS open but parked,
// because another Chrome profile's extension owns the broker right now.
// "disconnected" = no socket.
let extensionRole = "disconnected";
let standbyReason = null;
let persistTimer = null;
let restorePromise = null;

// clientId → { id, clientId, groupId, windowId, primaryTabId, tabIds:Set, ownsWindow }
const sessions = new Map();

// clientId → Promise tail. Commands for the same session are serialized, while
// different Claude/MCP clients can continue in parallel.
const clientQueues = new Map();

// tabId → clientId (which session owns this tab)
const tabOwner = new Map();

// tabId → true (we hold a chrome.debugger attachment to this tab)
const attachedTabs = new Set();

// ---------------- notifications (0.5.0: focus on click, never auto-steal) ----
// notificationId → { clientId, windowId?, tabId? }. Clicking a notification is
// the ONLY path that raises a window to the OS foreground.
const notifTargets = new Map();

// User prefs for OS notifications, mirrored from chrome.storage.local.
const notifPrefs = { enabled: true, verified: false };
chrome.storage.local.get(["notifEnabled", "notifVerified"]).then((o) => {
  if (typeof o.notifEnabled === "boolean") notifPrefs.enabled = o.notifEnabled;
  if (typeof o.notifVerified === "boolean") notifPrefs.verified = o.notifVerified;
}).catch(() => {});

// ---------------- comment mode (standalone visual annotation) ----------------
// Tabs that currently run a comment session — kept injected across navigation.
// Persisted so the set survives service-worker eviction.
const COMMENT_TABS_KEY = "mochiCommentTabs";
const COMMENT_SESSION_KEY = "mochiCommentSession";
const commentTabs = new Set();
// Hydration is async on a cold service-worker boot; handlers await this before
// trusting commentTabs so a toggle/status doesn't race an empty set.
const commentTabsReady = chrome.storage.local.get([COMMENT_TABS_KEY]).then((o) => {
  const arr = o && o[COMMENT_TABS_KEY];
  if (Array.isArray(arr)) for (const id of arr) commentTabs.add(id);
}).catch(() => {});
function persistCommentTabs() {
  try { chrome.storage.local.set({ [COMMENT_TABS_KEY]: [...commentTabs] }); } catch {}
}
async function setCommentActive(active) {
  try {
    const o = await chrome.storage.local.get([COMMENT_SESSION_KEY]);
    const s = (o && o[COMMENT_SESSION_KEY]) || {};
    s.active = active;
    if (active && !s.startedAt) s.startedAt = Date.now();
    if (!Array.isArray(s.comments)) s.comments = [];
    await chrome.storage.local.set({ [COMMENT_SESSION_KEY]: s });
  } catch {}
}
async function isCommentActive() {
  try { const o = await chrome.storage.local.get([COMMENT_SESSION_KEY]); return !!(o && o[COMMENT_SESSION_KEY] && o[COMMENT_SESSION_KEY].active); } catch { return false; }
}
async function injectCommentMode(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["comment-merge.js", "comment-mode.js"] });
    return true;
  } catch (e) {
    try { console.warn("[mochi] comment-mode inject failed:", e?.message); } catch {}
    return false;
  }
}
async function startCommentSession(tabId) {
  await commentTabsReady;
  await setCommentActive(true);   // active before injecting so the script renders
  commentTabs.add(tabId); persistCommentTabs();
  return injectCommentMode(tabId);
}
// Stop ONE tab (or all when tabId is omitted). The global active flag is only
// cleared once the last commenting tab is gone, so other tabs keep their overlay.
async function stopCommentSession(tabId) {
  await commentTabsReady;
  const targets = tabId != null ? [tabId] : [...commentTabs];
  for (const id of targets) {
    try { await chrome.tabs.sendMessage(id, { type: "comment_teardown" }); } catch {}
    commentTabs.delete(id);
  }
  persistCommentTabs();
  if (commentTabs.size === 0) await setCommentActive(false);
}
async function unregisterCommentTab(tabId) {
  await commentTabsReady;
  if (commentTabs.delete(tabId)) persistCommentTabs();
  if (commentTabs.size === 0) await setCommentActive(false);
}
// Re-inject comment mode after navigation/reload so the FAB + pins persist —
// but only while the session is genuinely active.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete") return;
  commentTabsReady.then(async () => {
    if (!commentTabs.has(tabId)) return;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || !t.url || !/^https?:\/\//i.test(t.url)) return;
    if (await isCommentActive()) injectCommentMode(tabId);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (commentTabs.delete(tabId)) { persistCommentTabs(); if (commentTabs.size === 0) setCommentActive(false); }
});
// Tab IDs are not stable across a browser restart — drop the persisted set so
// comment mode never force-injects into an unrelated restored tab.
chrome.runtime.onStartup.addListener(() => {
  commentTabs.clear(); persistCommentTabs(); setCommentActive(false);
});

// Post an OS notification for a session. Never raises the window — that only
// happens if the user clicks (see chrome.notifications.onClicked below).
// When notifications are off we just no-op: a toolbar badge would collide with
// the painted status dot in the icon and never reliably clear, so it's worse
// than nothing.
async function notify(clientId, { kind = "info", message = "", requireInteraction = false } = {}) {
  if (!notifPrefs.enabled) return false;
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

// Recover the focus target for a notification whose in-memory entry was lost to
// an MV3 service-worker eviction. The id encodes the clientId; persisted session
// state (windowId/primaryTabId) is rehydrated by restoreSessions().
async function resolveNotifTarget(id) {
  const direct = notifTargets.get(id);
  if (direct) return direct;
  const parts = String(id).split(":");
  if (parts[0] !== "mochi" || parts.length < 3) return null;
  const clientId = parts.slice(1, -1).join(":");
  if (!clientId || clientId === "global") return null;
  try { await restoreSessions(); } catch {}
  const s = sessions.get(clientId);
  return s ? { clientId, windowId: s.windowId, tabId: s.primaryTabId } : null;
}

chrome.notifications.onClicked.addListener(async (id) => {
  const target = await resolveNotifTarget(id);
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

// Drop any lingering notifications/targets for a session that's ending, so a
// later click can't resolve to a torn-down window/tab.
function clearClientNotifications(clientId) {
  if (!clientId) return;
  const prefix = `mochi:${clientId}:`;
  for (const id of [...notifTargets.keys()]) {
    if (id.startsWith(prefix)) {
      notifTargets.delete(id);
      try { chrome.notifications.clear(id); } catch {}
    }
  }
}

// Diagnostic logger. Two sinks: SW DevTools console (for live tailing) and a
// ring buffer in chrome.storage.local (survives SW restarts so we can see the
// full attach/detach history even when MV3 unloads the worker between events).
// Dump from the SW DevTools console with:
//   copy(JSON.stringify((await chrome.storage.local.get("mochiDbgLog")).mochiDbgLog, null, 2))
// or clear with:
//   chrome.storage.local.remove("mochiDbgLog")
const SW_BOOT_AT = Date.now();
const DBG_BUFFER_MAX = 800;
const dbgBuffer = [];
let dbgPersistTimer = null;
function dbgPersistSoon() {
  if (dbgPersistTimer) return;
  dbgPersistTimer = setTimeout(async () => {
    dbgPersistTimer = null;
    try { await chrome.storage.local.set({ mochiDbgLog: dbgBuffer }); } catch {}
  }, 250);
}
function DBG(event, data) {
  const ts = Date.now();
  const t = new Date(ts).toISOString().slice(11, 23);
  const sinceBoot = ((ts - SW_BOOT_AT) / 1000).toFixed(1) + "s";
  try { console.log(`[mochi:dbg ${t} +${sinceBoot}] ${event}`, data ?? ""); }
  catch {}
  dbgBuffer.push({ ts, event, data: data ?? null });
  if (dbgBuffer.length > DBG_BUFFER_MAX) {
    dbgBuffer.splice(0, dbgBuffer.length - DBG_BUFFER_MAX);
  }
  dbgPersistSoon();
}
// Rehydrate any prior entries so we have history across SW restarts.
chrome.storage.local.get("mochiDbgLog").then((o) => {
  if (Array.isArray(o?.mochiDbgLog) && o.mochiDbgLog.length > 0) {
    dbgBuffer.unshift(...o.mochiDbgLog);
    if (dbgBuffer.length > DBG_BUFFER_MAX) {
      dbgBuffer.splice(0, dbgBuffer.length - DBG_BUFFER_MAX);
    }
  }
  DBG("sw.boot", { wsUrl: WS_URL, hydratedEntries: o?.mochiDbgLog?.length ?? 0 });
}).catch(() => DBG("sw.boot", { wsUrl: WS_URL, hydratedEntries: 0 }));

// Per-tab capture buffers. Created lazily on attach. Trimmed to MAX_* on insert
// so service-worker memory stays bounded. Cleared on tab removal.
//   console: [{ level, text, args, url, line, col, ts }]
//   network: Map<requestId, { id, method, url, type, status, mimeType,
//                              durationMs, sentMs, recvMs, finished, failed,
//                              size, requestHeaders, responseHeaders }>
const MAX_CONSOLE = 400;
const MAX_NETWORK = 200;
const tabBuffers = new Map();

function getTabBuf(tabId) {
  let b = tabBuffers.get(tabId);
  if (!b) {
    // lastNavAt: wall-clock ms of the most recent main-frame navigation on this
    // tab. Stamped by navigate() and the Page.frameNavigated CDP event. Lets
    // console/network reads scope to "since the current page loaded" so a stale
    // pre-navigation buffer can't masquerade as the page under test.
    b = { console: [], network: new Map(), netOrder: [], lastNavAt: 0 };
    tabBuffers.set(tabId, b);
  }
  return b;
}

// Stamp the navigation epoch for a tab. Called on real main-frame navigations
// so `sinceNavigation` reads only reflect the live page.
function markNavigation(tabId) {
  if (tabId == null) return;
  const b = getTabBuf(tabId);
  b.lastNavAt = Date.now();
}

function pushConsole(tabId, entry) {
  const b = getTabBuf(tabId);
  b.console.push(entry);
  if (b.console.length > MAX_CONSOLE) b.console.splice(0, b.console.length - MAX_CONSOLE);
}

const MAX_BODY_CHARS = 8000;
let __waitRespSeq = 0; // unique-ifies wait_for_response listener keys
// Tabs whose cache must stay disabled for the rest of the session (navigate
// {disableCache:true}). CDP's setCacheDisabled is per-debugger-session state, so
// it's re-applied on every (re)attach — otherwise session_heal or an MV3 SW
// restart would silently re-enable caching and a "fix verified" could be read
// off a stale bundle. Cleared on tab close / session end.
const cacheDisabledTabs = new Set();

// Fire-and-forget capture of an error response's body. CDP keeps the body only
// briefly after loadingFinished, so we grab it immediately. Never throws.
function captureResponseBody(tabId, requestId, entry) {
  entry.body = ""; // mark as in-flight so we don't double-fetch
  Promise.resolve()
    .then(() => chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }))
    .then((res) => {
      if (!res) return;
      let body = res.body ?? "";
      if (res.base64Encoded) {
        try { body = atob(body); } catch { /* leave as-is */ }
      }
      entry.body = String(body).slice(0, MAX_BODY_CHARS);
      entry.bodyTruncated = String(body).length > MAX_BODY_CHARS;
    })
    .catch(() => { /* body unavailable — leave the empty marker */ });
}

function recordNetwork(tabId, requestId, patch) {
  const b = getTabBuf(tabId);
  const existing = b.network.get(requestId);
  if (!existing) {
    b.network.set(requestId, { id: requestId, ...patch });
    b.netOrder.push(requestId);
    if (b.netOrder.length > MAX_NETWORK) {
      const drop = b.netOrder.shift();
      b.network.delete(drop);
    }
  } else {
    Object.assign(existing, patch);
  }
}

// ---------------- helpers ----------------

function getSession(clientId) {
  if (!clientId) throw new Error("missing clientId in command — broker/extension protocol mismatch");
  const s = sessions.get(clientId);
  if (!s) throw new Error("no active session — call browser_session_start first");
  return s;
}

const DEFAULT_VISUALS = Object.freeze({ enabled: true, cursor: true, hud: true, slowMo: 0 });

async function resolveVisualsConfig(input) {
  let base = DEFAULT_VISUALS;
  if (!input) {
    try {
      const stored = (await chrome.storage.local.get(["visualsDefault"])).visualsDefault;
      if (stored && typeof stored === "object") base = { ...DEFAULT_VISUALS, ...stored };
    } catch {}
  }
  const merged = { ...base, ...(input ?? {}) };
  const n = Number(merged.slowMo);
  merged.slowMo = Math.max(0, Math.min(5000, Number.isNaN(n) ? 0 : n));
  merged.enabled = !!merged.enabled;
  merged.cursor = !!merged.cursor;
  merged.hud = !!merged.hud;
  return merged;
}

function quoteLabel(s) {
  const str = String(s ?? "").trim().slice(0, 60);
  return str ? `"${str}"` : "element";
}

function tabIn(s, tabId) { return s.tabIds.has(tabId); }

function targetTab(s, tabId) {
  const t = tabId ?? s.primaryTabId;
  if (!tabIn(s, t)) throw new Error(`tab ${t} is not in this session's group`);
  return t;
}

async function getTabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId))?.url ?? null; } catch { return null; }
}

function dropSession(clientId) {
  const s = sessions.get(clientId);
  if (!s) return;
  for (const tabId of s.tabIds) tabOwner.delete(tabId);
  sessions.delete(clientId);
  schedulePersistSessions();
}

function serializeSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    clientId: s.clientId,
    groupId: s.groupId,
    windowId: s.windowId,
    primaryTabId: s.primaryTabId,
    tabIds: [...s.tabIds],
    ownsWindow: !!s.ownsWindow,
    label: s.label,
    visuals: s.visuals,
  }));
}

function schedulePersistSessions() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSessionsNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistSessionsNow() {
  try {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: serializeSessions() });
  } catch {
    // Persistence is a resilience layer; never let it break live automation.
  }
}

async function restoreSessions() {
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    let stored;
    try {
      stored = await chrome.storage.local.get([SESSION_STATE_KEY]);
    } catch {
      return;
    }
    const saved = Array.isArray(stored?.[SESSION_STATE_KEY])
      ? stored[SESSION_STATE_KEY]
      : [];
    let changed = false;

    for (const raw of saved) {
      if (!raw?.clientId || !Array.isArray(raw.tabIds) || raw.tabIds.length === 0) {
        changed = true;
        continue;
      }

      const validTabs = [];
      for (const tabId of raw.tabIds) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || tab.groupId !== raw.groupId) {
          changed = true;
          continue;
        }
        validTabs.push(tab);
      }

      if (validTabs.length === 0) {
        changed = true;
        continue;
      }

      const validIds = validTabs.map((t) => t.id);
      const primaryTabId = validIds.includes(raw.primaryTabId)
        ? raw.primaryTabId
        : validIds[0];
      const primaryTab = validTabs.find((t) => t.id === primaryTabId) ?? validTabs[0];
      const session = {
        id: raw.id || crypto.randomUUID(),
        clientId: raw.clientId,
        groupId: raw.groupId,
        windowId: raw.windowId ?? primaryTab.windowId,
        primaryTabId,
        tabIds: new Set(validIds),
        ownsWindow: !!raw.ownsWindow,
        label: raw.label,
        visuals: raw.visuals && typeof raw.visuals === "object"
          ? { ...DEFAULT_VISUALS, ...raw.visuals }
          : { ...DEFAULT_VISUALS },
      };
      sessions.set(raw.clientId, session);
      for (const tabId of validIds) tabOwner.set(tabId, raw.clientId);
    }

    if (changed) schedulePersistSessions();
  })();
  return restorePromise;
}

function enqueueClientCommand(clientId, task) {
  const key = clientId || "__global__";
  const prev = clientQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  const tail = run.catch(() => {}).finally(() => {
    if (clientQueues.get(key) === tail) clientQueues.delete(key);
  });
  clientQueues.set(key, tail);
  return run;
}

// ---------------- CDP helpers ----------------

async function describeDebuggerHolder(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const t = targets.find((x) => x.tabId === tabId && x.attached);
    if (!t) return "unknown holder (DevTools may have just closed)";
    if (t.extensionId) return `extension id=${t.extensionId}`;
    return "DevTools or an external debugger";
  } catch {
    return "another debugger client";
  }
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) { DBG("attach.skip already-attached", { tabId }); return; }
  const tryAttach = () => chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  const isTransient = (msg) =>
    msg.includes("Another debugger") ||
    msg.includes("Cannot attach") ||
    // Chrome refuses attach mid-navigation if the tab is momentarily at a
    // chrome-extension:// or chrome:// target (e.g. some redirects pass
    // through such pages briefly). The condition usually resolves in <1s.
    msg.includes("Cannot access");
  DBG("attach.try", { tabId });
  try {
    await tryAttach();
    DBG("attach.ok", { tabId, attempt: 1 });
  } catch (e) {
    const msg = String(e?.message ?? e);
    DBG("attach.fail.first", { tabId, msg, transient: isTransient(msg) });
    if (isTransient(msg)) {
      // Progressive backoff — handles both fast (DevTools mid-transition,
      // ~250ms) and slow (navigation through a non-debuggable URL, ~1s) cases.
      let attached = false;
      let attempt = 1;
      for (const delay of [300, 1000]) {
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
        try {
          await tryAttach();
          attached = true;
          DBG("attach.ok", { tabId, attempt, delayBeforeMs: delay });
          break;
        } catch (e2) {
          DBG("attach.fail.retry", { tabId, attempt, delayBeforeMs: delay, msg: String(e2?.message ?? e2) });
        }
      }
      if (!attached) {
        // Enumerate ALL attached targets — Chrome only tells us "attached: bool",
        // never which client. But listing every attached target (not just our
        // tabId) often reveals a service worker or iframe target on the same
        // origin that's the actual blocker.
        let allAttached = [];
        try {
          const targets = await chrome.debugger.getTargets();
          allAttached = targets.filter((t) => t.attached).map((t) => ({
            type: t.type, tabId: t.tabId, url: t.url, extensionId: t.extensionId,
          }));
        } catch {}
        const holder = await describeDebuggerHolder(tabId);
        let urlHint = "";
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.url) urlHint = ` (current URL: ${tab.url})`;
        } catch {}
        DBG("attach.fail.final", { tabId, holder, urlHint, allAttached, msg });
        // Chrome's "Cannot access a chrome-extension:// URL of different
        // extension" is structurally different from a debugger-lock conflict.
        // It means another installed extension has injected a
        // chrome-extension:// iframe/resource into this tab — Chrome blocks
        // cross-extension DevTools access for security. No "holder" exists in
        // this case; the misleading "holder" wording sent multiple debugging
        // sessions down the wrong path.
        const crossExtensionFrame =
          msg.includes("Cannot access") &&
          msg.includes("chrome-extension://") &&
          msg.includes("different extension");
        if (crossExtensionFrame) {
          throw new Error(
            `chrome.debugger attach blocked for tab ${tabId}${urlHint} — ` +
            `another installed Chrome extension has injected a chrome-extension:// ` +
            `frame into this page, and Chrome forbids cross-extension DevTools access. ` +
            `Disable other extensions that inject overlays into this site (Grammarly, ` +
            `Boomerang, Mixmax, password managers, etc.) and reload the tab. ` +
            `To identify culprits, open page DevTools on this tab and run: ` +
            `[...document.querySelectorAll('iframe,frame,embed')].map(e=>e.src).filter(s=>s.startsWith('chrome-extension://'))`
          );
        }
        throw new Error(
          `chrome.debugger attach failed for tab ${tabId}${urlHint} — ${holder} is debugging it ` +
          `or the page is at a non-debuggable URL. Close DevTools (Cmd+Opt+I), pause the ` +
          `conflicting extension, or navigate away and retry. (raw: ${msg})`
        );
      }
    } else {
      throw e;
    }
  }
  attachedTabs.add(tabId);
  // Enable the domains we passively observe. Failures are non-fatal — the
  // attachment is still useful for click/type even if Runtime/Network can't
  // be enabled (e.g. on chrome:// pages).
  try { await chrome.debugger.sendCommand({ tabId }, "Page.enable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Runtime.enable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Network.enable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Inspector.enable"); } catch {}
  // Re-apply a sticky cache-off (navigate {disableCache:true}) — CDP loses it on
  // every re-attach, so without this a heal/SW-restart silently re-enables cache.
  if (cacheDisabledTabs.has(tabId)) {
    try { await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", { cacheDisabled: true }); } catch {}
  }
  // Make sure a buffer exists so capture from now on is recorded.
  getTabBuf(tabId);
}

async function detachIfAttached(tabId, source = "unknown") {
  if (!attachedTabs.has(tabId)) return;
  DBG("detach.self", { tabId, source });
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (e) {
    DBG("detach.self.error", { tabId, source, msg: String(e?.message ?? e) });
  }
}

async function detachSessionTabs(s) {
  for (const id of [...s.tabIds]) {
    cacheDisabledTabs.delete(id); // session over — drop sticky cache-off
    await detachIfAttached(id);
  }
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // "Detached while handling command" fires when the page navigates
    // cross-process or DevTools opens mid-call. Re-attach once and retry.
    if (msg.includes("Detached")) {
      DBG("cdp.detached-mid-cmd", { tabId, method, msg });
      attachedTabs.delete(tabId);
      await ensureAttached(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    DBG("cdp.error", { tabId, method, msg });
    throw e;
  }
}

// Expose a handful of helpers on globalThis so the upload.js module (statically
// imported above) can reach back into them without forming a circular import.
// Reads happen lazily, inside async request handlers, so module-eval order
// doesn't matter.
globalThis.cdp = cdp;
globalThis.ensureAttached = ensureAttached;
globalThis.getSession = getSession;
globalThis.targetTab = targetTab;

// Wrapper used by the dispatch switch above. Kept tiny so upload.js owns the
// strategy logic and background.js only routes the call.
async function uploadFile(p, clientId) {
  return handleUploadFile(p, clientId);
}

// Chrome calls this whenever a debugger session ends without our asking. The
// `reason` field is the most useful clue: "target_closed" (tab/process died),
// "canceled_by_user" (user clicked the "Cancel" banner button), or undefined
// (SW shutdown / Chrome detached us internally).
chrome.debugger.onDetach.addListener(({ tabId, extensionId }, reason) => {
  DBG("debugger.onDetach", { tabId, extensionId, reason });
  if (tabId != null) attachedTabs.delete(tabId);
});

const overlayInjected = new Set(); // tabId

async function injectOverlay(tabId, visualsConfig) {
  if (!visualsConfig?.enabled) return;
  if (!overlayInjected.has(tabId)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["overlay.js"],
      });
      overlayInjected.add(tabId);
    } catch {
      // chrome:// pages and the like — silently skip; the rest of the
      // automation still works.
      return;
    }
  }
  try {
    await chrome.tabs.sendMessage(tabId, { kind: "overlay.init", config: visualsConfig });
  } catch {
    // The content script may not be listening yet on the very first inject;
    // it's idempotent and will pick up the next message.
  }
}

// Wait briefly for the tab to settle after a user action that may have
// triggered a navigation. Uses a short grace period because link-clicks don't
// flip the tab to "loading" synchronously, then a bounded wait so a slow page
// doesn't make every action stall.
async function settleAfterAction(tabId) {
  await new Promise((r) => setTimeout(r, 120));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "loading") {
      await Promise.race([
        waitForLoad(tabId).catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
  } catch {}
}

// Show a failure HUD for an action that errored BEFORE reaching withVisuals
// (e.g. selector resolution failed in click/typeText). Skips ring/ripple
// because there's no target rect to highlight.
async function showActionFailureHud(tabId, clientId, action, errorMsg) {
  const session = sessions.get(clientId);
  const cfg = session?.visuals;
  if (!cfg?.enabled) return;
  try { await injectOverlay(tabId, cfg); } catch {}
  const text = `✗ ${action} failed: ${String(errorMsg).slice(0, 120)}`;
  try { await chrome.tabs.sendMessage(tabId, { kind: "overlay.hud", text, fail: true }); } catch {}
  if (cfg.slowMo > 0) await new Promise((r) => setTimeout(r, cfg.slowMo));
}

async function withVisuals(tabId, clientId, intent, doAction) {
  const session = sessions.get(clientId);
  const cfg = session?.visuals;
  // Lazy re-inject (covers post-navigation re-creates).
  if (cfg?.enabled) await injectOverlay(tabId, cfg);

  if (cfg?.enabled) {
    try {
      await chrome.tabs.sendMessage(tabId, { kind: "overlay.intent", ...intent });
    } catch {}
  }

  let result, error;
  try {
    result = await doAction();
  } catch (e) {
    error = e;
  }

  if (cfg?.enabled) {
    // Action may have navigated the page (e.g. browser_navigate, form submit).
    // Wait for the tab to finish loading before re-injecting; otherwise the
    // success HUD races the new page's overlay listener registration and the
    // result message gets dropped on the floor.
    await settleAfterAction(tabId);
    await injectOverlay(tabId, cfg);

    const okMessage = {
      kind: "overlay.result",
      ok: !error,
      text: error
        ? `✗ ${intent.action} failed: ${String(error.message ?? error).slice(0, 120)}`
        : `✓ ${intent.action} succeeded`,
      rect: error ? intent.rect : undefined,
      ripple: !error && intent.x != null && intent.y != null ? { x: intent.x, y: intent.y } : undefined,
    };
    try { await chrome.tabs.sendMessage(tabId, okMessage); } catch {}
    if (cfg.slowMo > 0) await new Promise((r) => setTimeout(r, cfg.slowMo));
  }

  if (error) throw error;
  return result;
}

// CDP event tap. Routes Runtime + Network events to per-tab ring buffers.
// Console + exception events become console entries; Network lifecycle events
// build up a request map. Anything else is ignored.
chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId == null || !tabBuffers.has(tabId) && !attachedTabs.has(tabId)) return;
  // Fan transient CDP events out to any registered upload-module listeners
  // (Page.fileChooserOpened, Network.responseReceived for smart-wait, ...).
  // Listeners are short-lived and own their own teardown.
  const transient = globalThis.__mochiCdpListeners;
  if (transient && transient.size) {
    for (const entry of transient.values()) {
      if (entry.tabId === tabId) {
        try { entry.listener(method, params); } catch {}
      }
    }
  }
  try {
    switch (method) {
      case "Page.frameNavigated": {
        // Only the top-level frame resets the navigation epoch — subframe
        // navigations (ads, iframes) must not clear the page's console/network
        // history out from under a `sinceNavigation` read.
        if (!params.frame?.parentId) markNavigation(tabId);
        break;
      }
      case "Runtime.consoleAPICalled": {
        const args = (params.args || []).map((a) => {
          if (a.unserializableValue) return String(a.unserializableValue);
          if (a.value !== undefined) return a.value;
          if (a.description) return a.description;
          if (a.type) return `[${a.type}]`;
          return null;
        });
        const text = args.map((v) =>
          typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()
        ).join(" ").slice(0, 2000);
        const top = params.stackTrace?.callFrames?.[0];
        pushConsole(tabId, {
          level: params.type || "log",
          text,
          ts: Date.now(),
          url: top?.url ?? null,
          line: top?.lineNumber ?? null,
          col: top?.columnNumber ?? null,
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const ex = params.exceptionDetails;
        const text = (ex?.exception?.description || ex?.text || "Uncaught exception").slice(0, 2000);
        pushConsole(tabId, {
          level: "error",
          text,
          ts: Date.now(),
          url: ex?.url ?? null,
          line: ex?.lineNumber ?? null,
          col: ex?.columnNumber ?? null,
          source: "exception",
        });
        break;
      }
      // Pure observers — they send no CDP command, so native dialog handling
      // and crash behavior are unchanged; we only surface a notification.
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
      case "Network.requestWillBeSent": {
        const r = params.request;
        recordNetwork(tabId, params.requestId, {
          method: r?.method,
          url: r?.url,
          type: params.type,
          requestHeaders: r?.headers,
          sentMs: Date.now(),
          finished: false,
          failed: false,
        });
        break;
      }
      case "Network.responseReceived": {
        const r = params.response;
        recordNetwork(tabId, params.requestId, {
          status: r?.status,
          mimeType: r?.mimeType,
          responseHeaders: r?.headers,
          recvMs: Date.now(),
        });
        break;
      }
      case "Network.loadingFinished": {
        const buf = tabBuffers.get(tabId);
        const entry = buf?.network.get(params.requestId);
        if (entry) {
          entry.finished = true;
          entry.size = params.encodedDataLength;
          entry.durationMs = entry.sentMs ? Date.now() - entry.sentMs : null;
          // Eagerly grab the response body for error responses (>=400) while
          // it's still resident in CDP. This is the difference between "the
          // save 500'd" and "the save 500'd: SMTP not configured". Bodies are
          // truncated and fire-and-forget so a slow/failed fetch never blocks
          // capture. 2xx bodies are skipped to keep memory bounded.
          if (typeof entry.status === "number" && entry.status >= 400 && entry.body == null) {
            captureResponseBody(tabId, params.requestId, entry);
          }
        }
        break;
      }
      case "Network.loadingFailed": {
        const buf = tabBuffers.get(tabId);
        const entry = buf?.network.get(params.requestId);
        if (entry) {
          entry.failed = true;
          entry.errorText = params.errorText;
          entry.finished = true;
          entry.durationMs = entry.sentMs ? Date.now() - entry.sentMs : null;
        }
        break;
      }
      default: break;
    }
  } catch {
    // Never let event handling kill the SW.
  }
});

// ---------------- connection lifecycle ----------------

async function loadState() {
  const stored = await chrome.storage.local.get(["connectionEnabled"]);
  connectionEnabled = stored.connectionEnabled !== false;
}

// State-color dots are painted DIRECTLY onto the icon (via OffscreenCanvas)
// instead of using the chrome action badge. The badge has a minimum pill
// size we can't shrink, and it covered the mochi's face. Compositing a real
// circle in the corner of the icon gives us a much smaller, cleaner dot.
let baseIconBitmaps = null;
async function loadBaseIcons() {
  if (baseIconBitmaps) return baseIconBitmaps;
  const sizes = [16, 32, 48, 128];
  const out = {};
  for (const s of sizes) {
    const resp = await fetch(chrome.runtime.getURL(`icons/mochi-${s}.png`));
    out[s] = await createImageBitmap(await resp.blob());
  }
  baseIconBitmaps = out;
  return out;
}

async function setIconWithDot(color) {
  try {
    const bitmaps = await loadBaseIcons();
    const imageData = {};
    for (const sizeStr of Object.keys(bitmaps)) {
      const s = Number(sizeStr);
      const canvas = new OffscreenCanvas(s, s);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmaps[s], 0, 0);
      // Dot radius scales with icon size; bottom-right corner with a thin
      // white ring for contrast against the pink mochi.
      const r = Math.max(2, Math.round(s * 0.16));
      const cx = s - r - 1;
      const cy = s - r - 1;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, r + Math.max(1, Math.round(s * 0.025)), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      imageData[s] = ctx.getImageData(0, 0, s, s);
    }
    await chrome.action.setIcon({ imageData });
  } catch {}
}

// Make sure the text-badge slot is empty — we draw on the icon directly now.
function clearBadge() {
  try { chrome.action.setBadgeText({ text: "" }); } catch {}
}

function connect() {
  if (!connectionEnabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try { ws = new WebSocket(WS_URL); } catch { scheduleReconnect(); return; }

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    // Provisionally show ON; the broker may immediately demote us to standby.
    extensionRole = "active";
    standbyReason = null;
    setIconWithDot("#16a34a");  // green = active
    safeSend({ type: "hello", role: "extension", version: chrome.runtime.getManifest().version });
  });

  ws.addEventListener("message", (e) => handleMessage(e.data));

  ws.addEventListener("close", () => {
    extensionRole = "disconnected";
    standbyReason = null;
    setIconWithDot("#dc2626");  // red = disconnected
    scheduleReconnect();
  });

  ws.addEventListener("error", () => { try { ws.close(); } catch {} });
}

// Called from handleMessage when broker sends {type: "standby"}. We're still
// connected; we just don't process commands. Don't disconnect — closing would
// trigger reconnect and we'd fight the active extension all over again.
function enterStandby(reason) {
  extensionRole = "standby";
  standbyReason = reason ?? "another profile is active";
  setIconWithDot("#f59e0b");  // yellow = standby
}

function enterActive() {
  extensionRole = "active";
  standbyReason = null;
  setIconWithDot("#16a34a");  // green = active
}

function requestTakeover() {
  if (extensionRole !== "standby") return;
  safeSend({ type: "request_takeover" });
}

function scheduleReconnect() {
  if (!connectionEnabled) return;
  if (reconnectTimer) return;
  const delayMs = Math.min(1000 * 2 ** reconnectAttempts, 15000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delayMs);
}

function safeSend(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

chrome.alarms.create("super-tester-tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "super-tester-tick") {
    DBG("alarm.tick", {
      connectionEnabled,
      wsState: ws?.readyState ?? "null",
      attachedTabs: [...attachedTabs],
      sessions: sessions.size,
    });
    if (connectionEnabled) {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
    }
  }
});

// Best-effort hook: fires shortly before Chrome unloads the service worker.
// If you see this followed by "sw.boot" in the next log line, that's MV3 idle
// timeout — the debugger attachment is released by Chrome on SW unload.
chrome.runtime.onSuspend.addListener(() => {
  DBG("sw.onSuspend", { attachedTabs: [...attachedTabs], sessions: sessions.size });
});

function boot() {
  clearBadge();  // wipe any leftover text badge from earlier versions
  loadState()
    .then(restoreSessions)
    .catch(() => {})
    .then(connect);
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
boot();

// ---------------- protocol dispatch ----------------

// Updated whenever the broker pushes its claude_sessions_update broadcast.
// Read by the popup via the popup_get_claude_sessions IPC.
let claudeSessionsCache = [];

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  // Broker-initiated lifecycle messages have no id and don't go through dispatch.
  if (msg.type === "standby") { enterStandby(msg.reason); return; }
  if (msg.type === "promoted") { enterActive(); return; }
  if (msg.type === "claude_sessions_update") {
    claudeSessionsCache = Array.isArray(msg.sessions) ? msg.sessions : [];
    return;
  }
  const { id, type, params, clientId } = msg;
  if (id == null) return;
  try {
    await restoreSessions();
    const result = await enqueueClientCommand(
      clientId,
      () => dispatchWithAutoRecover(type, params ?? {}, clientId)
    );
    safeSend({ id, ok: true, result });
  } catch (e) {
    safeSend({ id, ok: false, error: String(e?.message ?? e) });
  }
}

// Commands that manage session lifecycle themselves — never auto-recover for
// these (would cause loops or double-starts).
const LIFECYCLE_COMMANDS = new Set(["session_start", "session_end", "client_cleanup"]);

// Wrap dispatch so a "no active session" error transparently re-creates the
// session from the last cached config and retries once. Triggered when the
// user manually closes/ungroups the session tabs but keeps issuing commands.
async function dispatchWithAutoRecover(type, p, clientId) {
  try {
    return await dispatch(type, p, clientId);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!msg.includes("no active session")) throw e;
    if (LIFECYCLE_COMMANDS.has(type)) throw e;
    const cfg = await getCachedSessionConfig(clientId);
    if (!cfg) {
      notify(clientId, {
        kind: "error",
        message: "The browser session was lost and could not be restored. Click to check.",
        requireInteraction: true,
      }).catch(() => {});
      throw e;
    }
    await sessionStart(cfg, clientId);
    const result = await dispatch(type, p, clientId);
    // Tag the result so the caller (and traces) can see the auto-recovery.
    if (result && typeof result === "object" && !Array.isArray(result)) {
      result.recovered = true;
    }
    return result;
  }
}

const SESSION_CONFIG_KEY_PREFIX = "lastSessionConfig:";
async function cacheSessionConfig(clientId, config) {
  if (!clientId) return;
  try {
    await chrome.storage.local.set({ [SESSION_CONFIG_KEY_PREFIX + clientId]: config });
  } catch {}
}
async function getCachedSessionConfig(clientId) {
  if (!clientId) return null;
  try {
    const key = SESSION_CONFIG_KEY_PREFIX + clientId;
    const out = await chrome.storage.local.get([key]);
    return out[key] ?? null;
  } catch { return null; }
}
async function clearCachedSessionConfig(clientId) {
  if (!clientId) return;
  try {
    await chrome.storage.local.remove(SESSION_CONFIG_KEY_PREFIX + clientId);
  } catch {}
}

async function dispatch(type, p, clientId) {
  switch (type) {
    case "session_start":      return sessionStart(p, clientId);
    case "session_end":        return sessionEnd(p, clientId);
    case "request_attention":  return requestAttention(p, clientId);
    case "comment_add":        return commentAdd(p, clientId);
    case "comment_list":       return commentList(p, clientId);
    case "comment_sessions":   return commentSessions(p, clientId);
    case "comment_resolve":    return commentResolve(p, clientId);
    case "client_cleanup":     return clientCleanup(clientId);
    case "navigate":           return navigate(p, clientId);
    case "open_tab":           return openTab(p, clientId);
    case "list_tabs":          return listTabs(clientId);
    case "close_tab":          return closeTab(p, clientId);
    case "snapshot":           return snapshot(p, clientId);
    case "text":               return textExtract(p, clientId);
    case "links":              return linksExtract(p, clientId);
    case "click":              return click(p, clientId);
    case "click_at":           return clickAt(p, clientId);
    case "type":               return typeText(p, clientId);
    case "press_key":          return pressKey(p, clientId);
    case "scroll":             return scroll(p, clientId);
    case "go_back":            return goBack(p, clientId);
    case "go_forward":         return goForward(p, clientId);
    case "wait":               return waitMs(p);
    case "screenshot":         return screenshot(p, clientId);
    case "window_resize":      return windowResize(p, clientId);
    case "emulate_viewport":   return emulateViewport(p, clientId);
    case "clear_emulation":    return clearEmulation(p, clientId);
    case "find_by_role_name":  return findByRoleName(p, clientId);
    case "resolve_box":        return resolveBox(p, clientId);
    case "match_count":        return matchCount(p, clientId);
    case "assert":             return assertCondition(p, clientId);
    case "tab_url":            return tabUrl(p, clientId);
    case "evaluate":           return evaluate(p, clientId);
    case "console_messages":   return consoleMessages(p, clientId);
    case "network_requests":   return networkRequests(p, clientId);
    case "audit_interactives": return auditInteractives(p, clientId);
    case "wait_for_response":  return waitForResponse(p, clientId);
    case "set_storage":        return setStorage(p, clientId);
    case "page_assets":        return pageAssets(p, clientId);
    case "session_heal":       return sessionHeal(p, clientId);
    case "upload_file":        return uploadFile(p, clientId);
    default: throw new Error(`unknown command: ${type}`);
  }
}

// ---------------- session lifecycle ----------------

async function sessionStart(input = {}, clientId) {
  const {
    title = "AI Session", color = "blue", url = "about:blank",
    newWindow = false, width, height, left, top, state,
    bringToFront = false,
    label,
    visuals,
  } = input;
  if (!clientId) throw new Error("session_start: missing clientId");
  // Idempotent — clean up any prior state for this client (including orphan
  // tabOwner entries from a half-formed previous start, where sessions.set
  // never ran but tabOwner did).
  await forceCleanupClient(clientId);

  let win, tab;
  if (newWindow) {
    // 0.4.1: only force focus on window creation when bringToFront is true (default).
    // Most callers want a one-time visible signal that the automation window
    // opened — that's expected and not the bug we fixed in 0.4.1.
    const opts = { url, focused: !!bringToFront, type: "normal" };
    if (typeof width === "number") opts.width = width;
    if (typeof height === "number") opts.height = height;
    if (typeof left === "number") opts.left = left;
    if (typeof top === "number") opts.top = top;
    if (state && state !== "normal") opts.state = state;
    win = await chrome.windows.create(opts);
    tab = win.tabs?.[0] ?? (await chrome.tabs.query({ windowId: win.id }))[0];
  } else {
    try { win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); }
    catch { win = await chrome.windows.create({ type: "normal" }); }
    // ALWAYS create the session tab as `active: true` within its window — that
    // prevents Chrome's hidden-tab throttling (rAF paused, timers ≥1s) which
    // breaks SPAs like React/Cloudflare during automation. The OS-level focus
    // (raising the window) is only requested when bringToFront is true.
    tab = await chrome.tabs.create({ url, windowId: win.id, active: true });
    if (bringToFront) {
      try { await chrome.windows.update(win.id, { focused: true }); } catch {}
    }
  }

  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  // Title shows the clientId suffix so multiple sessions are visually distinct.
  const niceTitle = title === "AI Session"
    ? `AI Session ${clientId.slice(-4)}`
    : title;
  await chrome.tabGroups.update(groupId, { title: niceTitle, color, collapsed: false });

  const session = {
    id: crypto.randomUUID(),
    clientId,
    groupId,
    windowId: win.id,
    primaryTabId: tab.id,
    tabIds: new Set([tab.id]),
    ownsWindow: !!newWindow,
    // Human label (project name) for notifications. Server injects `label`;
    // fall back to a custom title or a clientId suffix for older callers.
    label: label || (title && title !== "AI Session" ? title : `Session ${clientId.slice(-4)}`),
    visuals: await resolveVisualsConfig(visuals),
  };
  sessions.set(clientId, session);
  tabOwner.set(tab.id, clientId);
  schedulePersistSessions();

  // 0.5.0: announce via a click-to-focus notification instead of stealing OS
  // focus. When bringToFront is true the window was already raised above, so
  // skip the toast.
  if (!bringToFront) {
    notify(clientId, {
      kind: "start",
      message: "Automation started — click to bring the window forward.",
    }).catch(() => {});
  }

  // Don't block the session_start response on a slow page — the session is
  // already committed (tab exists, group exists, state is recorded). If the
  // load stalls, the caller can browser_wait or browser_navigate from a known
  // good state, which is better than letting the broker's request timeout fire
  // and strand the in-flight start behind the per-client queue.
  if (url && url !== "about:blank") await waitForLoad(tab.id).catch(() => {});

  // Attach proactively so console + network capture is running from t=0.
  // If the page is chrome:// or otherwise un-attachable, we silently skip.
  ensureAttached(tab.id).catch(() => {});
  // Stamp the nav epoch for the initial page so the first sinceNavigation read
  // is scoped correctly even if Page.frameNavigated fired before attach.
  if (url && url !== "about:blank") markNavigation(tab.id);
  injectOverlay(tab.id, session.visuals).catch(() => {});

  // Persist the inputs so dispatchWithAutoRecover can rebuild this session if
  // the user closes/ungroups its tabs and keeps issuing commands. We cache
  // exactly what the caller passed (not derived state like ids), so the
  // replay matches their original intent.
  await cacheSessionConfig(clientId, input);

  return {
    sessionId: session.id,
    groupId,
    primaryTabId: tab.id,
    windowId: win.id,
    ownsWindow: session.ownsWindow,
    clientId,
  };
}

async function sessionEnd({ closeTabs = false } = {}, clientId) {
  if (!clientId) throw new Error("session_end: missing clientId");
  const s = sessions.get(clientId);
  if (!s) return { ended: false };

  // Snapshot everything before async ops can mutate state from listeners.
  const sessionId = s.id;
  const ids = [...s.tabIds];
  await detachSessionTabs(s);
  if (closeTabs) {
    for (const id of ids) { try { await chrome.tabs.remove(id); } catch {} }
  } else {
    try { await chrome.tabs.ungroup(ids); } catch {}
  }
  // Remove ownership map entries (listeners may also do this — idempotent).
  for (const id of ids) tabOwner.delete(id);
  sessions.delete(clientId);
  clearClientNotifications(clientId);
  schedulePersistSessions();
  // Explicit end → don't auto-restart on the next command.
  await clearCachedSessionConfig(clientId);

  return { ended: true, sessionId, tabCount: ids.length };
}

// Broker tells us a client process disconnected — best-effort end its session.
async function clientCleanup(clientId) {
  if (!clientId) return { cleaned: false };
  if (!sessions.has(clientId)) return { cleaned: false };
  const r = await sessionEnd({ closeTabs: false }, clientId).catch(() => ({ ended: false }));
  return { cleaned: r.ended, clientId };
}

// Aggressive pre-start cleanup. Covers the "half-formed session" case where a
// previous session_start crashed/timed out after tabOwner.set but before
// sessions.set (or vice versa) — sessionEnd alone misses those because it's
// keyed off sessions.has(clientId).
async function forceCleanupClient(clientId) {
  if (sessions.has(clientId)) {
    try { await sessionEnd({ closeTabs: false }, clientId); } catch {}
  }
  for (const [tabId, owner] of [...tabOwner.entries()]) {
    if (owner !== clientId) continue;
    await detachIfAttached(tabId);
    tabOwner.delete(tabId);
  }
}

// Agent-triggered: post a notification asking the human to look. Does not raise
// the window — the user clicks the toast to focus (chrome.notifications.onClicked).
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

// ---------------- comment-mode bridge (agent QA ↔ human Comment Mode) ---------
// Read-modify-write the SAME chrome.storage.local document Comment Mode uses, so
// agent-created comments appear live as pins in the human's extension.
const MC_KEY = "mochiComments";
function mcGet() {
  return new Promise((r) => {
    try { chrome.storage.local.get([MC_KEY], (o) => r((o && o[MC_KEY]) || { v: 2, taughtScroll: false, activeByOrigin: {}, pending: null, sessions: {} })); }
    catch { r({ v: 2, taughtScroll: false, activeByOrigin: {}, pending: null, sessions: {} }); }
  });
}
function mcSet(store) { return new Promise((r) => { try { chrome.storage.local.set({ [MC_KEY]: store }, r); } catch { r(); } }); }
const mcUid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

// Resolve an element's selector/box/route metadata on the session's primary tab.
async function resolveElementMeta(tabId, selector) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId }, args: [selector || ""],
      func: (sel) => {
        function uniq(el) {
          if (!el || el.nodeType !== 1) return "";
          if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return "#" + el.id;
          const parts = []; let c = el;
          while (c && c.nodeType === 1 && c !== document.documentElement) {
            let p = c.tagName.toLowerCase();
            if (c.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(c.id)) { parts.unshift("#" + c.id); break; }
            if (c.classList && c.classList.length) { const cl = [...c.classList].slice(0, 2).map((x) => x.replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join("."); if (cl) p += "." + cl; }
            const par = c.parentElement;
            if (par) { const sib = [...par.children].filter((x) => x.tagName === c.tagName); if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(c) + 1) + ")"; }
            parts.unshift(p); c = par; if (parts.length >= 6) break;
          }
          return parts.join(" > ") || el.tagName.toLowerCase();
        }
        const base = { route: location.pathname + location.search, url: location.href, origin: location.origin, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 } };
        // No selector → a page-level comment: anchor to <body> so it renders as a
        // real top-of-page pin instead of a useless detached corner pin.
        const el = sel ? document.querySelector(sel) : (document.body || document.documentElement);
        if (!el) return { ok: false, selector: sel || "", ...base };
        const r = el.getBoundingClientRect();
        return { ok: true, selector: sel ? uniq(el) : "body", tagName: el.tagName.toLowerCase(), role: el.getAttribute("role") || el.tagName.toLowerCase(),
          elementText: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90),
          box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }, ...base };
      },
    });
    return result || null;
  } catch { return null; }
}
// Origin of a tab's current URL (for default-scoping list/sessions to the site
// the agent is actually QA-ing, instead of leaking every origin in the profile).
async function tabOrigin(tabId) {
  try { const t = await chrome.tabs.get(tabId); return t && t.url ? new URL(t.url).origin : null; } catch { return null; }
}
// Keep only a well-formed {label,width}; a malformed breakpoint would render
// "undefined" in the panel and never match a device-frame width.
function normBreakpoint(bp) {
  if (!bp || typeof bp !== "object") return null;
  const w = Number(bp.width);
  if (!bp.label || !Number.isFinite(w) || w <= 0) return null;
  return { label: String(bp.label), width: Math.round(w) };
}
async function commentAdd({ selector, ref, text, sessionName, breakpoint, severity } = {}, clientId) {
  const sess = clientId ? sessions.get(clientId) : null;
  if (!sess) throw new Error("no active session");
  const sel = selector || ref || "";
  const meta = await resolveElementMeta(sess.primaryTabId, sel);
  if (!meta) throw new Error("could not resolve the page");
  const store = await mcGet();
  const origin = meta.origin;
  // Resolve the target name up front so repeated calls with NO sessionName land
  // in ONE session (matching on the same resolved default) instead of minting a
  // fresh "QA <date>" every time.
  const wantName = (sessionName && String(sessionName).trim()) || `QA ${new Date().toISOString().slice(0, 10)}`;
  let s = Object.values(store.sessions).find((x) => x.origin === origin && x.name === wantName);
  if (!s) {
    s = { id: mcUid("s"), name: wantName, origin, createdAt: Date.now(), updatedAt: Date.now(), comments: [] };
    store.sessions[s.id] = s;
  }
  const now = Date.now();
  const n = s.comments.reduce((m, c) => Math.max(m, c.n || 0), 0) + 1;
  const comment = {
    id: mcUid("c"), sessionId: s.id, n, text: String(text || ""),
    url: meta.url, route: meta.route, origin,
    selector: meta.selector || sel, tagName: meta.tagName || "", role: meta.role || "", elementText: meta.elementText || "",
    box: meta.box || { x: 0, y: 0, w: 0, h: 0 }, viewport: meta.viewport || { w: 0, h: 0, dpr: 1 },
    breakpoint: normBreakpoint(breakpoint), severity: severity || null, resolved: false, createdAt: now, updatedAt: now,
  };
  s.comments.push(comment); s.updatedAt = now;
  // Select this session for the origin ONLY if the human isn't already viewing a
  // valid session there — never yank their active session out from under them.
  if (!store.activeByOrigin[origin] || !store.sessions[store.activeByOrigin[origin]]) {
    store.activeByOrigin[origin] = s.id;
  }
  await mcSet(store);
  // Close the loop client-side: make sure Comment Mode is actually mounted on
  // the tab so the agent's comment shows up as a live pin without the human
  // having pre-opened Comment Mode. mcSet already persisted, so the freshly
  // injected (or resynced) content script reads it on mount.
  try {
    await commentTabsReady;
    await setCommentActive(true);
    if (sess.primaryTabId != null) {
      commentTabs.add(sess.primaryTabId); persistCommentTabs();
      await injectCommentMode(sess.primaryTabId);
    }
  } catch {}
  return { ok: true, id: comment.id, n, sessionId: s.id, sessionName: s.name, located: !!meta.ok };
}
async function commentList({ sessionId, sessionName, origin, includeResolved = true } = {}, clientId) {
  const store = await mcGet();
  // A bare call (no filter) defaults to THIS tab's origin so an agent never
  // dumps every site's comments from the whole browser profile into its context.
  if (!sessionId && !sessionName && !origin && clientId) {
    const sess = sessions.get(clientId);
    if (sess && sess.primaryTabId != null) origin = await tabOrigin(sess.primaryTabId);
  }
  let list = Object.values(store.sessions);
  if (sessionId) list = list.filter((s) => s.id === sessionId);
  else if (sessionName) list = list.filter((s) => s.name === sessionName);
  if (origin) list = list.filter((s) => s.origin === origin);
  const comments = list.flatMap((s) => s.comments.map((c) => ({ ...c, sessionId: s.id, sessionName: s.name })))
    .filter((c) => includeResolved || !c.resolved)
    .sort((a, b) => (a.route || "").localeCompare(b.route || "") || (a.n - b.n));
  return { ok: true, count: comments.length, comments };
}
async function commentSessions({ origin } = {}, clientId) {
  const store = await mcGet();
  if (!origin && clientId) {
    const sess = sessions.get(clientId);
    if (sess && sess.primaryTabId != null) origin = await tabOrigin(sess.primaryTabId);
  }
  const list = Object.values(store.sessions).filter((s) => !origin || s.origin === origin)
    .map((s) => ({ id: s.id, name: s.name, origin: s.origin, count: s.comments.length, updatedAt: s.updatedAt }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, sessions: list };
}
async function commentResolve({ id, resolved = true } = {}) {
  const store = await mcGet();
  let hit = false;
  for (const s of Object.values(store.sessions)) {
    const c = s.comments.find((x) => x.id === id);
    if (c) { c.resolved = !!resolved; c.updatedAt = Date.now(); s.updatedAt = Date.now(); hit = true; break; }
  }
  if (hit) await mcSet(store);
  return { ok: hit, id, resolved };
}

async function navigate({ url, tabId, bringToFront = false, hardReload = false, disableCache = false } = {}, clientId) {
  if (!url) throw new Error("url is required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  // Cache control: hardReload/disableCache force the browser to refetch assets
  // instead of trusting a possibly-stale cached bundle. This is the antidote to
  // "you're looking at an old JS bundle" confusion — pair it with
  // browser_page_assets to confirm the live hash matches the deployed build.
  let cacheToggled = false;
  if (hardReload || disableCache) {
    try {
      await cdp(t, "Network.setCacheDisabled", { cacheDisabled: true });
      cacheToggled = true;
    } catch {}
  }
  // disableCache is sticky for the session — remember the tab so the cache-off
  // state survives debugger re-attach (see ensureAttached).
  if (disableCache) cacheDisabledTabs.add(t);
  // Always keep the tab `active: true` within its Chrome window — this prevents
  // Chrome from throttling rAF / timers / SPA rendering on the target tab.
  // Only raise the entire window to OS foreground when bringToFront is explicit
  // (default false in 0.4.1 — was true in 0.4.0 and stole user's keyboard focus
  // on every navigate).
  await chrome.tabs.update(t, { url, active: true });
  markNavigation(t);
  if (bringToFront) {
    try { await chrome.windows.update(s.windowId, { focused: true }); } catch {}
  }
  return withVisuals(t, clientId, {
    action: "Navigate",
    text: `▶ ${hardReload ? "Hard-loading" : "Navigating to"} ${shortUrl(url)}`,
  }, async () => {
    await waitForLoad(t);
    // Re-enable the cache after a one-shot hardReload so later requests behave
    // normally. A persistent disableCache:true keeps it off for the session.
    if (cacheToggled && hardReload && !disableCache) {
      try { await cdp(t, "Network.setCacheDisabled", { cacheDisabled: false }); } catch {}
    }
    const finalUrl = await getTabUrl(t) ?? url;
    return { tabId: t, url: finalUrl, hardReload: !!hardReload, cacheDisabled: !!disableCache };
  });
}

function shortUrl(url) {
  try { const u = new URL(url); return u.host + (u.pathname === "/" ? "" : u.pathname); }
  catch { return String(url).slice(0, 80); }
}

async function openTab({ url = "about:blank", active = false, makePrimary = true } = {}, clientId) {
  const s = getSession(clientId);
  const tab = await chrome.tabs.create({ url, windowId: s.windowId, active });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: s.groupId });
  s.tabIds.add(tab.id);
  tabOwner.set(tab.id, clientId);
  if (makePrimary) s.primaryTabId = tab.id;
  schedulePersistSessions();
  if (url && url !== "about:blank") {
    await waitForLoad(tab.id);
    // Attach + stamp the nav epoch so the first sinceNavigation read on this tab
    // is actually scoped (mirrors sessionStart) — otherwise it silently returns
    // the whole buffer.
    ensureAttached(tab.id).catch(() => {});
    markNavigation(tab.id);
  }
  const finalUrl = await getTabUrl(tab.id) ?? url;
  return { tabId: tab.id, url: finalUrl, primary: makePrimary };
}

async function listTabs(clientId) {
  const s = getSession(clientId);
  const out = [];
  for (const id of s.tabIds) {
    try {
      const t = await chrome.tabs.get(id);
      out.push({
        id: t.id, url: t.url, title: t.title,
        // `active` and `foreground` mean the same thing (Chrome's term for
        // "visible tab in its window"); `primary` is the session's
        // default-target tab. Orthogonal: a primary tab can be in the
        // background, which throttles SPAs — see browser_navigate.
        active: t.active,
        foreground: t.active,
        primary: id === s.primaryTabId,
        debuggerAttached: attachedTabs.has(id),
      });
    } catch {}
  }
  return { sessionId: s.id, groupId: s.groupId, primaryTabId: s.primaryTabId, tabs: out };
}

async function closeTab({ tabId } = {}, clientId) {
  const s = getSession(clientId);
  if (!tabId) throw new Error("tabId is required");
  if (!tabIn(s, tabId)) throw new Error("tab not in session group");
  if (tabId === s.primaryTabId) throw new Error("cannot close primary tab; end the session instead");
  await detachIfAttached(tabId);
  await chrome.tabs.remove(tabId);
  s.tabIds.delete(tabId);
  tabOwner.delete(tabId);
  schedulePersistSessions();
  return { closed: tabId };
}

async function goBack({ tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  await chrome.tabs.goBack(t);
  await waitForLoad(t).catch(() => {});
  return { tabId: t, url: await getTabUrl(t) };
}

async function goForward({ tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  await chrome.tabs.goForward(t);
  await waitForLoad(t).catch(() => {});
  return { tabId: t, url: await getTabUrl(t) };
}

async function waitMs({ ms = 1000 } = {}) {
  await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60000, ms))));
  return { waited: ms };
}

async function tabUrl({ tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  return { tabId: t, url: await getTabUrl(t), title: (await chrome.tabs.get(t).catch(() => ({}))).title };
}

// ---------------- snapshot / input / etc. ----------------

async function snapshot({ tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __extractAriaSnapshot,
  });
  return { tabId: t, ...result };
}

async function textExtract({ tabId, query, limit = 80, maxChars = 6000 } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __extractVisibleText,
    args: [query ?? null, limit, maxChars],
  });
  return { tabId: t, ...result };
}

async function linksExtract({ tabId, query, limit = 50 } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __extractVisibleLinks,
    args: [query ?? null, limit],
  });
  return { tabId: t, ...result };
}

async function getElementCenter(tabId, ref) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: __getElementCenter,
    args: [ref],
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function click({ ref, tabId, button = "left", clickCount = 1 } = {}, clientId) {
  if (!ref) throw new Error("ref (CSS selector) is required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  let c;
  try {
    c = await getElementCenter(t, ref);
  } catch (e) {
    // One retry for the just-rendered case: SPA route changes often mount the
    // target a tick after navigation. A single 200ms re-probe turns a class of
    // flaky "element not found" failures into reliable clicks.
    const msg = String(e?.message ?? e);
    if (/element not found/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        c = await getElementCenter(t, ref);
      } catch (e2) {
        await showActionFailureHud(t, clientId, "Click", e2?.message ?? e2);
        throw e2;
      }
    } else {
      await showActionFailureHud(t, clientId, "Click", msg);
      throw e;
    }
  }
  // A disabled control is a no-op in the DOM — dispatching a mouse event would
  // "succeed" while nothing happens. Fail loudly so the agent records a real
  // verdict (DISABLED) instead of a false WORKS.
  if (c?.disabled) {
    await showActionFailureHud(t, clientId, "Click", "element is disabled");
    throw new Error(`element is disabled: ${ref}`);
  }
  return withVisuals(t, clientId, {
    action: "Click",
    text: `▶ Clicking ${quoteLabel(c.name || ref)}`,
    x: c.x, y: c.y,
    rect: { left: c.boxX, top: c.boxY, width: c.width, height: c.height },
  }, async () => {
    await dispatchMouseClick(t, c.x, c.y, button, clickCount);
    return {
      tabId: t, ref, x: c.x, y: c.y,
      url: await getTabUrl(t),
      role: c.role, name: c.name,
      box: { x: c.boxX, y: c.boxY, w: c.width, h: c.height,
             viewport: { w: c.viewportW, h: c.viewportH, dpr: c.devicePixelRatio } },
    };
  });
}

async function clickAt({ x, y, tabId, button = "left", clickCount = 1 } = {}, clientId) {
  if (typeof x !== "number" || typeof y !== "number")
    throw new Error("x and y (CSS pixel coordinates) are required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  return withVisuals(t, clientId, {
    action: "Click",
    text: `▶ Clicking at (${x}, ${y})`,
    x, y,
  }, async () => {
    await dispatchMouseClick(t, x, y, button, clickCount);
    return { tabId: t, x, y, url: await getTabUrl(t) };
  });
}

async function dispatchMouseClick(tabId, x, y, button, clickCount) {
  const buttonsMask = button === "right" ? 2 : button === "middle" ? 4 : 1;
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, clickCount: 0 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: buttonsMask, clickCount });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
}

async function typeText({ ref, text, submit = false, clear = true, tabId } = {}, clientId) {
  if (!ref) throw new Error("ref (CSS selector) is required");
  if (text == null) throw new Error("text is required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);

  let prep;
  try {
    [{ result: prep }] = await chrome.scripting.executeScript({
      target: { tabId: t },
      func: __focusAndClear,
      args: [ref, clear],
    });
    if (prep?.error) throw new Error(prep.error);
  } catch (e) {
    await showActionFailureHud(t, clientId, "Type", e?.message ?? e);
    throw e;
  }

  return withVisuals(t, clientId, {
    action: "Type",
    text: `▶ Typing into ${quoteLabel(prep?.name || ref)}${submit ? " (submit)" : ""}`,
  }, async () => {
    if (text.length > 0) await cdp(t, "Input.insertText", { text });
    if (submit) await dispatchKey(t, "Enter");
    return {
      tabId: t, ref, submitted: !!submit,
      url: await getTabUrl(t), role: prep?.role, name: prep?.name,
    };
  });
}

async function pressKey({ key, tabId } = {}, clientId) {
  if (!key) throw new Error("key is required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  return withVisuals(t, clientId, {
    action: "Press",
    text: `▶ Pressing ${quoteLabel(key)}`,
  }, async () => {
    await dispatchKey(t, key);
    return { tabId: t, key, url: await getTabUrl(t) };
  });
}

async function dispatchKey(tabId, key) {
  const meta = keyMeta(key);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: meta.key, code: meta.code, text: meta.text, unmodifiedText: meta.text,
    windowsVirtualKeyCode: meta.vk, nativeVirtualKeyCode: meta.vk,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: meta.key, code: meta.code,
    windowsVirtualKeyCode: meta.vk, nativeVirtualKeyCode: meta.vk,
  });
}

async function scroll({ x = 0, y = 0, deltaX = 0, deltaY = 0, tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  return withVisuals(t, clientId, { action: "Scroll", text: "▶ Scrolling" }, async () => {
    if (x !== 0 || y !== 0) {
      await chrome.scripting.executeScript({
        target: { tabId: t },
        func: (sx, sy) => window.scrollTo(sx, sy),
        args: [x, y],
      });
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: t },
        func: (dx, dy) => window.scrollBy(dx, dy),
        args: [deltaX, deltaY],
      });
    }
    return { tabId: t, url: await getTabUrl(t) };
  });
}

// ---------------- screenshots ----------------

async function screenshot({ tabId, fullPage = false, elementRef, format = "png" } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);

  if (elementRef) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: t },
      func: __getElementBox,
      args: [elementRef],
    });
    if (result?.error) throw new Error(result.error);
    const { x, y, width, height, devicePixelRatio } = result;
    if (width <= 0 || height <= 0) throw new Error("element has zero size");
    const r = await cdp(t, "Page.captureScreenshot", {
      format,
      clip: { x, y, width, height, scale: 1 },
      captureBeyondViewport: true, fromSurface: true,
    });
    return {
      tabId: t, mode: "element", ref: elementRef,
      width: Math.round(width * devicePixelRatio),
      height: Math.round(height * devicePixelRatio),
      dataUrl: `data:image/${format};base64,${r.data}`,
    };
  }

  if (fullPage) {
    const r = await cdp(t, "Page.captureScreenshot", {
      format, captureBeyondViewport: true, fromSurface: true,
    });
    return { tabId: t, mode: "fullPage", dataUrl: `data:image/${format};base64,${r.data}` };
  }

  // Use CDP against the specific tabId. chrome.tabs.captureVisibleTab takes a
  // windowId and shoots whatever's foreground in that window — wrong whenever
  // the session tab is in the background.
  const r = await cdp(t, "Page.captureScreenshot", {
    format, captureBeyondViewport: false, fromSurface: true,
  });
  const meta = await chrome.tabs.get(t).catch(() => null);
  return {
    tabId: t, mode: "viewport",
    capturedUrl: meta?.url, capturedTitle: meta?.title,
    dataUrl: `data:image/${format};base64,${r.data}`,
  };
}

// ---------------- window resize + device emulation ----------------

async function windowResize({ width, height, left, top, state, windowId } = {}, clientId) {
  const s = getSession(clientId);
  const target = windowId ?? s.windowId;
  if (!target) throw new Error("no window to resize");

  if (state) await chrome.windows.update(target, { state });
  const bounds = {};
  if (typeof width === "number") bounds.width = width;
  if (typeof height === "number") bounds.height = height;
  if (typeof left === "number") bounds.left = left;
  if (typeof top === "number") bounds.top = top;
  if (Object.keys(bounds).length) {
    if (!state) {
      try { await chrome.windows.update(target, { state: "normal" }); } catch {}
    }
    await chrome.windows.update(target, bounds);
  }
  const w = await chrome.windows.get(target);
  return { windowId: target, width: w.width, height: w.height, left: w.left, top: w.top, state: w.state };
}

const DEVICE_PRESETS = {
  "iphone-15-pro":   { width: 393,  height: 852,  deviceScaleFactor: 3,     mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  "iphone-se":       { width: 375,  height: 667,  deviceScaleFactor: 2,     mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  "pixel-7":         { width: 412,  height: 915,  deviceScaleFactor: 2.625, mobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36" },
  "ipad":            { width: 820,  height: 1180, deviceScaleFactor: 2,     mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  "desktop-hd":      { width: 1366, height: 768,  deviceScaleFactor: 1, mobile: false },
  "desktop-fhd":     { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
  "desktop-2k":      { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false },
};

async function emulateViewport({
  preset, tabId, width, height, deviceScaleFactor, mobile, userAgent,
} = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);

  let resolved = {};
  if (preset) {
    const p = DEVICE_PRESETS[preset];
    if (!p) throw new Error(`unknown preset: ${preset} (try: ${Object.keys(DEVICE_PRESETS).join(", ")})`);
    resolved = { ...p };
  }
  if (typeof width === "number") resolved.width = width;
  if (typeof height === "number") resolved.height = height;
  if (typeof deviceScaleFactor === "number") resolved.deviceScaleFactor = deviceScaleFactor;
  if (typeof mobile === "boolean") resolved.mobile = mobile;
  if (typeof userAgent === "string") resolved.userAgent = userAgent;

  if (typeof resolved.width !== "number" || typeof resolved.height !== "number") {
    throw new Error("width and height (or a preset) are required");
  }

  await cdp(t, "Emulation.setDeviceMetricsOverride", {
    width: resolved.width, height: resolved.height,
    deviceScaleFactor: resolved.deviceScaleFactor ?? 1,
    mobile: !!resolved.mobile,
    screenWidth: resolved.width, screenHeight: resolved.height,
  });
  if (resolved.userAgent) await cdp(t, "Emulation.setUserAgentOverride", { userAgent: resolved.userAgent });
  if (resolved.mobile) {
    try { await cdp(t, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }); } catch {}
  }
  return { tabId: t, applied: resolved };
}

async function clearEmulation({ tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  try { await cdp(t, "Emulation.clearDeviceMetricsOverride"); } catch {}
  try { await cdp(t, "Emulation.setUserAgentOverride", { userAgent: "" }); } catch {}
  try { await cdp(t, "Emulation.setTouchEmulationEnabled", { enabled: false }); } catch {}
  return { tabId: t, cleared: true };
}

// ---------------- self-healing + assertions ----------------

async function findByRoleName({ role, name, tabId, exact = false } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __findByRoleName,
    args: [role ?? null, name ?? null, !!exact],
  });
  if (result?.error) throw new Error(result.error);
  result.url = await getTabUrl(t);
  return result;
}

async function resolveBox({ ref, tabId } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __resolveBox,
    args: [ref],
  });
  if (result?.error) return { found: false, error: result.error };
  return { found: true, ...result };
}

// Count selector matches without requiring a unique hit. Used by failure
// diagnostics to report "0 matches", "3 matches", etc.
async function matchCount({ ref, tabId } = {}, clientId) {
  if (!ref) throw new Error("ref (CSS selector) is required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: (sel) => {
      try {
        const list = document.querySelectorAll(sel);
        const samples = [];
        for (let i = 0; i < Math.min(5, list.length); i++) {
          const el = list[i];
          const rr = el.getBoundingClientRect();
          samples.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
                  (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
            visible: rr.width > 0 && rr.height > 0,
            box: { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
          });
        }
        return { count: list.length, samples };
      } catch (e) {
        return { error: `bad selector: ${e.message}` };
      }
    },
    args: [ref],
  });
  return result;
}

// CDP Runtime.evaluate. Returns serializable value by default.
async function evaluate({
  expression, awaitPromise = true, returnByValue = true,
  timeoutMs = 5000, tabId,
} = {}, clientId) {
  if (typeof expression !== "string" || !expression) throw new Error("expression (string) is required");
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const r = await cdp(t, "Runtime.evaluate", {
    expression,
    awaitPromise: !!awaitPromise,
    returnByValue: !!returnByValue,
    timeout: Math.max(0, Math.min(60000, Number(timeoutMs) || 5000)),
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: false,
  });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    return {
      tabId: t, ok: false,
      error: ex.exception?.description ?? ex.text ?? "evaluation threw",
      url: await getTabUrl(t),
    };
  }
  const ro = r.result;
  return {
    tabId: t, ok: true,
    type: ro?.type,
    subtype: ro?.subtype,
    value: returnByValue ? ro?.value : undefined,
    description: ro?.description,
    objectId: returnByValue ? undefined : ro?.objectId,
    url: await getTabUrl(t),
  };
}

async function consoleMessages({ tabId, level, since, sinceNavigation = false, limit = 100, clear = false } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  // Make sure capture is running (no-op if already attached).
  await ensureAttached(t).catch(() => {});
  const buf = tabBuffers.get(t);
  if (!buf) return { tabId: t, messages: [], total: 0, captureActive: false, sinceNavigation: !!sinceNavigation };
  let messages = buf.console;
  if (level) {
    const want = String(level).toLowerCase();
    messages = messages.filter((m) => String(m.level).toLowerCase() === want);
  }
  // sinceNavigation scopes to the live page so a stale pre-navigation buffer
  // can't produce a false "no errors". An explicit `since` still wins if larger.
  let floor = typeof since === "number" ? since : 0;
  if (sinceNavigation) floor = Math.max(floor, buf.lastNavAt || 0);
  if (floor > 0) messages = messages.filter((m) => m.ts >= floor);
  const total = messages.length;
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const sliced = messages.slice(-max);
  if (clear) buf.console = [];
  // If the caller asked to scope by navigation but we have no nav epoch yet, the
  // read is actually the WHOLE buffer — flag it so "no errors" isn't trusted blindly.
  const navScopeUnavailable = !!sinceNavigation && !(buf.lastNavAt > 0);
  return {
    tabId: t, captureActive: true, total, returned: sliced.length,
    sinceNavigation: !!sinceNavigation, navAt: buf.lastNavAt || null,
    ...(navScopeUnavailable ? { navScopeUnavailable: true } : {}),
    messages: sliced,
  };
}

async function networkRequests({
  tabId, urlContains, method, statusGte, statusLt,
  failedOnly = false, sinceNavigation = false, sinceMs, limit = 50,
  includeRequestHeaders = false, includeResponseHeaders = false,
  includeBody = false,
} = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  await ensureAttached(t).catch(() => {});
  const buf = tabBuffers.get(t);
  if (!buf) return { tabId: t, requests: [], total: 0, captureActive: false, sinceNavigation: !!sinceNavigation };

  // Pull entries in arrival order (netOrder is FIFO).
  const all = buf.netOrder.map((id) => buf.network.get(id)).filter(Boolean);
  let filtered = all;
  if (urlContains) filtered = filtered.filter((r) => (r.url || "").includes(urlContains));
  if (method) {
    const m = String(method).toUpperCase();
    filtered = filtered.filter((r) => (r.method || "").toUpperCase() === m);
  }
  if (typeof statusGte === "number") filtered = filtered.filter((r) => (r.status ?? 0) >= statusGte);
  if (typeof statusLt === "number") filtered = filtered.filter((r) => (r.status ?? 0) < statusLt);
  if (failedOnly) filtered = filtered.filter((r) => r.failed || (r.status >= 400));
  // Time scoping: sinceNavigation uses the page's nav epoch; sinceMs is an
  // explicit floor (used by browser_act_and_observe to capture only the
  // requests an action triggered).
  let floor = typeof sinceMs === "number" ? sinceMs : 0;
  if (sinceNavigation) floor = Math.max(floor, buf.lastNavAt || 0);
  if (floor > 0) filtered = filtered.filter((r) => (r.sentMs ?? 0) >= floor);

  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const sliced = filtered.slice(-max).map((r) => {
    const out = {
      id: r.id, method: r.method, url: r.url, type: r.type,
      status: r.status, mimeType: r.mimeType, durationMs: r.durationMs ?? null,
      finished: !!r.finished, failed: !!r.failed,
      errorText: r.errorText ?? undefined, size: r.size ?? null,
      sentMs: r.sentMs ?? null, recvMs: r.recvMs ?? null,
    };
    if (includeRequestHeaders) out.requestHeaders = r.requestHeaders ?? null;
    if (includeResponseHeaders) out.responseHeaders = r.responseHeaders ?? null;
    // Error-response bodies are captured automatically (see loadingFinished).
    // Surface them when asked, or always for failed/>=400 so the agent sees
    // *why* it failed without a second call.
    if ((includeBody || r.failed || (r.status >= 400)) && r.body != null && r.body !== "") {
      out.body = r.body;
      if (r.bodyTruncated) out.bodyTruncated = true;
    }
    return out;
  });
  const navScopeUnavailable = !!sinceNavigation && !(buf.lastNavAt > 0);
  return {
    tabId: t, captureActive: true,
    sinceNavigation: !!sinceNavigation, navAt: buf.lastNavAt || null,
    ...(navScopeUnavailable ? { navScopeUnavailable: true } : {}),
    total: filtered.length, returned: sliced.length,
    requests: sliced,
  };
}

// Enumerate every actionable element on the page. The backbone of exhaustive QA
// coverage: you can't claim "tested every control" without a list of controls.
async function auditInteractives({ tabId, scope = "all", limit = 400, includeHidden = false } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __auditInteractives,
    args: [scope, Math.max(1, Math.min(2000, Number(limit) || 400)), !!includeHidden],
  });
  return { tabId: t, url: await getTabUrl(t), ...result };
}

// glob → RegExp. Supports * (any run) and ? (single char). Everything else is
// matched literally. Used by wait_for_response to match request URLs.
function __globToRegExp(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(esc);
}

// Resolve when a network response matching {urlGlob, method, status range}
// arrives — turning "did the save persist?" from inference into a fact. Checks
// already-captured requests first (handles the act-then-wait race), then waits
// on live CDP events until the deadline.
async function waitForResponse({
  tabId, urlGlob, urlContains, method, statusGte, statusLt, sinceMs, timeoutMs = 15000,
} = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  await ensureAttached(t).catch(() => {});
  const re = urlGlob ? __globToRegExp(urlGlob) : null;
  const wantMethod = method ? String(method).toUpperCase() : null;
  const floor = typeof sinceMs === "number" ? sinceMs : 0;
  const matches = (url, status, mthd) => {
    if (re && !re.test(url || "")) return false;
    if (urlContains && !(url || "").includes(urlContains)) return false;
    if (wantMethod && String(mthd || "").toUpperCase() !== wantMethod) return false;
    if (typeof statusGte === "number" && (status ?? 0) < statusGte) return false;
    if (typeof statusLt === "number" && (status ?? 0) >= statusLt) return false;
    return true;
  };

  // 1) Already captured? (response that arrived between the action and this call)
  const buf = tabBuffers.get(t);
  if (buf) {
    for (const id of buf.netOrder) {
      const r = buf.network.get(id);
      if (!r || (r.sentMs ?? 0) < floor) continue;
      if (typeof r.status === "number" && matches(r.url, r.status, r.method)) {
        return {
          tabId: t, matched: true, source: "buffer",
          request: { method: r.method, url: r.url, status: r.status, failed: !!r.failed, durationMs: r.durationMs ?? null, body: r.body || undefined },
        };
      }
    }
  }

  // 2) Wait on live events.
  const deadline = Date.now() + Math.max(100, Math.min(120000, Number(timeoutMs) || 15000));
  if (!globalThis.__mochiCdpListeners) globalThis.__mochiCdpListeners = new Map();
  const key = "waitresp-" + t + "-" + (++__waitRespSeq);
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      globalThis.__mochiCdpListeners.delete(key);
      clearTimeout(timer);
      resolve(val);
    };
    const listener = (cdpMethod, params) => {
      try {
        if (cdpMethod === "Network.responseReceived") {
          const r = params.response || {};
          if (matches(r.url, r.status, r.requestMethod || r.method)) {
            finish({ tabId: t, matched: true, source: "event", request: { url: r.url, status: r.status, method: r.requestMethod, mimeType: r.mimeType } });
          }
        } else if (cdpMethod === "Network.loadingFailed" && (statusGte == null && statusLt == null)) {
          // A failed request can satisfy a status-agnostic wait (e.g. "wait for
          // /api/save to come back, pass or fail").
          const entry = buf?.network.get(params.requestId);
          if (entry && matches(entry.url, undefined, entry.method)) {
            finish({ tabId: t, matched: true, source: "event", request: { url: entry.url, failed: true, errorText: params.errorText } });
          }
        }
      } catch {}
    };
    globalThis.__mochiCdpListeners.set(key, { tabId: t, listener });
    const timer = setTimeout(() => finish({ tabId: t, matched: false, reason: "timeout", timeoutMs }), deadline - Date.now());
  });
}

// Seed localStorage / sessionStorage / cookies. Enables deterministic auth —
// re-seed a known-good token instead of fighting token expiry mid-run.
async function setStorage({ tabId, localStorage: ls, sessionStorage: ss, cookies, clear = false } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __setStorage,
    args: [ls ?? null, ss ?? null, !!clear],
  });
  let cookieResults = [];
  if (Array.isArray(cookies) && cookies.length) {
    const url = await getTabUrl(t);
    for (const c of cookies) {
      try {
        const params = { name: c.name, value: String(c.value ?? ""), url: c.url || url };
        if (c.domain) params.domain = c.domain;
        if (c.path) params.path = c.path;
        if (typeof c.secure === "boolean") params.secure = c.secure;
        if (typeof c.httpOnly === "boolean") params.httpOnly = c.httpOnly;
        if (c.sameSite) params.sameSite = c.sameSite;
        if (typeof c.expires === "number") params.expires = c.expires;
        const r = await cdp(t, "Network.setCookie", params);
        cookieResults.push({ name: c.name, success: !!r?.success });
      } catch (e) {
        cookieResults.push({ name: c.name, success: false, error: String(e?.message ?? e) });
      }
    }
  }
  return { tabId: t, url: await getTabUrl(t), ...result, cookies: cookieResults };
}

// Enumerate loaded JS/CSS assets and hash each (SHA-256, in-page so same-origin
// credentials/CORS apply). QA confirms the live asset hash == the just-built
// hash before trusting results — catches the stale-bundle class of bug.
async function pageAssets({ tabId, types, limit = 60, hash = true } = {}, clientId) {
  const s = getSession(clientId);
  const t = targetTab(s, tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __pageAssets,
    args: [Array.isArray(types) ? types : null, Math.max(1, Math.min(300, Number(limit) || 60)), !!hash],
  });
  return { tabId: t, url: await getTabUrl(t), ...result };
}

// Self-heal a session: re-attach the debugger to every session tab and
// re-enable the observed domains. Fixes a dropped attachment (the cause of
// "clicks/evals time out") instead of only reporting it.
async function sessionHeal({} = {}, clientId) {
  const s = getSession(clientId);
  const healed = [];
  for (const id of [...s.tabIds]) {
    try {
      // Detach (if we still hold it) then re-attach — this fixes BOTH a
      // chrome-side dropped attachment and a stuck one. Re-attaching a tab
      // we're already attached to would fail, so we always detach first.
      // Buffers (console/network) survive: onDetach only updates attachedTabs;
      // tabBuffers are cleared only on tab removal.
      await detachIfAttached(id, "session_heal");
      await ensureAttached(id);
      healed.push({ tabId: id, attached: attachedTabs.has(id) });
    } catch (e) {
      healed.push({ tabId: id, attached: false, error: String(e?.message ?? e) });
    }
  }
  return { sessionId: s.id, primaryTabId: s.primaryTabId, healedTabs: healed };
}

async function assertCondition({ kind, target, value } = {}, clientId) {
  if (!kind) throw new Error("assert: kind is required");
  const s = getSession(clientId);
  const t = targetTab(s);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t },
    func: __assertCondition,
    args: [kind, target ?? null, value ?? null],
  });
  return { tabId: t, ...result };
}

// ---------------- in-page helpers ----------------

function __extractAriaSnapshot() {
  const MAX_WALK_NODES = 5000;
  let visitedNodes = 0;
  let truncatedByNodeLimit = false;
  const INTERESTING_TAGS = new Set([
    "a","button","input","textarea","select","label",
    "h1","h2","h3","h4","h5","h6",
    "form","nav","main","header","footer","article","aside",
    "summary","details","dialog",
  ]);

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }
  function refOf(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.dataset && el.dataset.testid) return `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    return null;
  }
  function nameOf(el) {
    return el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
  }
  function walk(node, depth = 0) {
    if (!node || depth > 25) return null;
    visitedNodes += 1;
    if (visitedNodes > MAX_WALK_NODES) {
      truncatedByNodeLimit = true;
      return null;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.replace(/\s+/g, " ").trim();
      return t ? { kind: "text", text: t.slice(0, 200) } : null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return null;
    if (!isVisible(el)) return null;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || tag;
    const name = nameOf(el).slice(0, 200);
    const ref = refOf(el);
    const r = el.getBoundingClientRect();
    const box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    const children = [];
    for (const c of el.childNodes) {
      const rr = walk(c, depth + 1);
      if (rr) children.push(rr);
    }
    const interesting =
      INTERESTING_TAGS.has(tag) ||
      el.hasAttribute("role") ||
      el.hasAttribute("aria-label") ||
      el.hasAttribute("contenteditable") ||
      ref;
    if (!interesting && children.length === 0) return null;
    if (!interesting && children.length === 1) return children[0];
    const out = { kind: "element", tag, role, box };
    if (name) out.name = name;
    if (ref) out.ref = ref;
    if (children.length) out.children = children;
    return out;
  }

  const tree = walk(document.body, 0);
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth, height: window.innerHeight,
      scrollX: window.scrollX, scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    },
    nodesVisited: visitedNodes,
    truncatedByNodeLimit,
    tree,
  };
}

function __extractVisibleText(query, limit, maxChars) {
  const maxLines = Math.max(1, Math.min(300, Number(limit) || 80));
  const maxTotal = Math.max(500, Math.min(20000, Number(maxChars) || 6000));
  const needle = typeof query === "string" && query.trim()
    ? query.toLowerCase()
    : null;
  const blocked = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

  function isVisibleElement(el) {
    if (!el || blocked.has(el.tagName)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !isVisibleElement(parent)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent.replace(/\s+/g, " ").trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        if (needle && !text.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const lines = [];
  const seen = new Set();
  let totalLines = 0;
  let chars = 0;
  let scannedNodes = 0;
  let scanCapped = false;
  while (walker.nextNode()) {
    scannedNodes += 1;
    if (scannedNodes > 20000) {
      scanCapped = true;
      break;
    }
    const raw = walker.currentNode.textContent.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const text = raw.slice(0, 500);
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    totalLines += 1;
    if (lines.length >= maxLines || chars + text.length > maxTotal) continue;
    lines.push(text);
    chars += text.length + 1;
  }

  return {
    url: location.href,
    title: document.title,
    query: needle ? query : undefined,
    totalLines,
    returned: lines.length,
    truncated: scanCapped || totalLines > lines.length,
    scanCapped,
    lines,
  };
}

function __extractVisibleLinks(query, limit) {
  const maxLinks = Math.max(1, Math.min(200, Number(limit) || 50));
  const needle = typeof query === "string" && query.trim()
    ? query.toLowerCase()
    : null;

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }
  function refOf(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.dataset && el.dataset.testid) return `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `a[aria-label="${CSS.escape(aria)}"]`;
    const href = el.getAttribute("href");
    if (href && href.length < 200) return `a[href="${CSS.escape(href)}"]`;
    const parent = el.parentElement;
    if (!parent) return "a";
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const idx = same.indexOf(el) + 1;
    return `a:nth-of-type(${idx})`;
  }

  const links = [];
  let totalLinks = 0;
  for (const el of Array.from(document.querySelectorAll("a[href]"))) {
    if (!isVisible(el)) continue;
    const text = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.textContent ||
      ""
    ).replace(/\s+/g, " ").trim();
    const href = el.href;
    const haystack = `${text} ${href}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    totalLinks += 1;
    if (links.length >= maxLinks) continue;
    const rect = el.getBoundingClientRect();
    links.push({
      text: text.slice(0, 180),
      href,
      ref: refOf(el),
      box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    });
  }

  return {
    url: location.href,
    title: document.title,
    query: needle ? query : undefined,
    totalLinks,
    returned: links.length,
    truncated: totalLinks > links.length,
    links,
  };
}

function __getElementCenter(ref) {
  const el = document.querySelector(ref);
  if (!el) return { error: `element not found: ${ref}` };
  el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const name = (
    el.getAttribute("aria-label") || el.getAttribute("alt") ||
    el.getAttribute("title") || el.getAttribute("placeholder") ||
    (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) || ""
  );
  // Disabled detection: native `disabled`, ARIA, or an ancestor <fieldset
  // disabled>. A disabled control is reported so click() can fail loudly
  // instead of silently dispatching a mouse event that does nothing.
  // NB: pointer-events:none is intentionally NOT treated as disabled — it's
  // commonly on decorative wrappers/labels whose click is delegated to a
  // parent, so folding it in produced false DISABLED verdicts.
  const disabled =
    !!el.disabled ||
    el.getAttribute("aria-disabled") === "true" ||
    !!el.closest("fieldset[disabled]");
  const inViewport =
    r.bottom > 0 && r.right > 0 &&
    r.top < window.innerHeight && r.left < window.innerWidth;
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    boxX: Math.round(r.left), boxY: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
    viewportW: window.innerWidth, viewportH: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    disabled, inViewport, visible: r.width > 0 && r.height > 0,
    role, name,
  };
}

function __getElementBox(ref) {
  const el = document.querySelector(ref);
  if (!el) return { error: `element not found: ${ref}` };
  el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return {
    x: r.left + window.scrollX, y: r.top + window.scrollY,
    width: r.width, height: r.height,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function __focusAndClear(ref, clear) {
  const el = document.querySelector(ref);
  if (!el) return { error: `element not found: ${ref}` };
  el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  if (clear) {
    if ((el instanceof HTMLInputElement) || (el instanceof HTMLTextAreaElement)) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContents" }));
    }
  }
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  // Cap to 200 chars — pathological aria-label/placeholder values (e.g. a
  // combobox with a serialized option list) can otherwise balloon the
  // browser_type response into the hundreds of KB.
  const rawName = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "";
  return { ok: true, role, name: rawName.slice(0, 200) };
}

function __resolveBox(ref) {
  let el;
  try { el = document.querySelector(ref); } catch (e) { return { error: `bad selector: ${e.message}` }; }
  if (!el) return { error: "not found" };
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { error: "zero size" };
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const rawName = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") ||
                  el.getAttribute("placeholder") ||
                  (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) || "";
  return {
    role, name: rawName.slice(0, 200),
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
  };
}

// Runs in the page. Lists every actionable element with a stable selector and
// the facts coverage needs: visibility, viewport position, disabled, and a
// best-effort hasClickHandler heuristic.
function __auditInteractives(scope, limit, includeHidden) {
  const SEL = [
    "button", "a[href]", "input:not([type=hidden])", "select", "textarea",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=tab]",
    "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=option]",
    "[onclick]", "[contenteditable=\"true\"]", "summary", "label[for]",
    "[tabindex]:not([tabindex=\"-1\"])",
  ].join(",");

  function isVisible(el) {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function accName(el) {
    const v = el.getAttribute("aria-label") || el.getAttribute("alt") ||
              el.getAttribute("title") || el.getAttribute("placeholder") || "";
    if (v) return v.trim().slice(0, 120);
    return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }
  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.dataset && el.dataset.testid) return "[data-testid=\"" + CSS.escape(el.dataset.testid) + "\"]";
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + "[name=\"" + CSS.escape(name) + "\"]";
    const aria = el.getAttribute("aria-label");
    if (aria) return el.tagName.toLowerCase() + "[aria-label=\"" + CSS.escape(aria) + "\"]";
    // Fall back to a nth-of-type path from the nearest id-bearing ancestor.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sames = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(sames.length > 1 ? tag + ":nth-of-type(" + (sames.indexOf(node) + 1) + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  }
  function hasHandler(el) {
    // Best-effort: content scripts can't read framework-attached listeners, so
    // this is a heuristic, not a guarantee. Native interactivity, inline
    // handlers, href, role, and cursor:pointer all count.
    const tag = el.tagName.toLowerCase();
    if (["button", "a", "input", "select", "textarea", "summary"].includes(tag)) return true;
    if (el.hasAttribute("onclick") || typeof el.onclick === "function") return true;
    if (el.getAttribute("role")) return true;
    if (el.hasAttribute("href")) return true;
    try { if (window.getComputedStyle(el).cursor === "pointer") return true; } catch {}
    return false;
  }
  function isDisabled(el) {
    return !!el.disabled || el.getAttribute("aria-disabled") === "true" || !!el.closest("fieldset[disabled]");
  }

  const all = Array.from(document.querySelectorAll(SEL));
  const seen = new Set();
  const out = [];
  let totalVisible = 0;
  let droppedAmbiguous = 0; // distinct elements that collapsed to a selector we already emitted
  let truncatedByLimit = false;
  for (const el of all) {
    const visible = isVisible(el);
    if (!visible && !includeHidden) continue;
    const r = el.getBoundingClientRect();
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    if (scope === "viewport" && !inViewport) continue;
    if (visible) totalVisible += 1;
    const selector = selectorFor(el);
    // Two distinct controls can generate the same fallback selector. Counting the
    // collision keeps coverage honest — droppedAmbiguous>0 means the 1:1
    // element<->selector assumption broke and the agent should add data-testids.
    if (seen.has(selector)) { droppedAmbiguous += 1; continue; }
    seen.add(selector);
    if (out.length >= limit) { truncatedByLimit = true; continue; }
    out.push({
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      accessibleName: accName(el),
      visible,
      inViewport,
      disabled: isDisabled(el),
      hasClickHandler: hasHandler(el),
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return {
    title: document.title,
    scope,
    totalVisible,
    returned: out.length,
    droppedAmbiguous,
    truncated: truncatedByLimit,
    elements: out,
  };
}

// Runs in the page. Writes localStorage/sessionStorage maps; optionally clears
// first. Returns the resulting key counts.
function __setStorage(ls, ss, clear) {
  const apply = (store, map) => {
    if (clear) { try { store.clear(); } catch {} }
    let n = 0;
    if (map && typeof map === "object") {
      for (const [k, v] of Object.entries(map)) {
        try { store.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); n++; } catch {}
      }
    }
    return n;
  };
  let localSet = 0, sessionSet = 0;
  try { localSet = apply(window.localStorage, ls); } catch {}
  try { sessionSet = apply(window.sessionStorage, ss); } catch {}
  return {
    localStorageKeys: (() => { try { return window.localStorage.length; } catch { return null; } })(),
    sessionStorageKeys: (() => { try { return window.sessionStorage.length; } catch { return null; } })(),
    localSet, sessionSet, cleared: !!clear,
  };
}

// Runs in the page (async). Enumerates loaded script/style/document assets and
// hashes each with SubtleCrypto so the caller can compare against a built hash.
async function __pageAssets(types, limit, doHash) {
  const want = new Set(types && types.length ? types : ["script", "css", "document"]);
  const seen = new Set();
  const list = [];

  const add = (url, kind) => {
    if (!url || seen.has(url)) return;
    if (!/^https?:/i.test(url)) return;
    seen.add(url);
    list.push({ url, type: kind });
  };

  if (want.has("document")) add(location.href, "document");
  if (want.has("script")) {
    for (const sEl of document.querySelectorAll("script[src]")) add(sEl.src, "script");
  }
  if (want.has("css")) {
    for (const l of document.querySelectorAll("link[rel~=stylesheet][href]")) add(l.href, "css");
  }
  // Also pull from the Resource Timing API to catch dynamically-loaded bundles.
  try {
    for (const e of performance.getEntriesByType("resource")) {
      const it = e.initiatorType;
      if (it === "script" && want.has("script")) add(e.name, "script");
      else if ((it === "link" || it === "css") && want.has("css")) add(e.name, "css");
    }
  } catch {}

  const sliced = list.slice(0, limit);
  // Bounded fetch: a single hung asset (stalled CDN, mis-classified long-poll)
  // must not block the whole call. 8s per asset, then record a timeout.
  async function sha256(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
      const buf = await res.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      return { sha256: hex, bytes: buf.byteLength, status: res.status };
    } catch (e) {
      return { sha256: null, error: controller.signal.aborted ? "timeout" : String(e && e.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  let hashedCount = 0, failedCount = 0;
  if (doHash) {
    await Promise.all(sliced.map(async (a) => { Object.assign(a, await sha256(a.url)); }));
    hashedCount = sliced.filter((a) => a.sha256).length;
    failedCount = sliced.length - hashedCount;
  }
  // Page fingerprint: deterministic over the assets that hashed cleanly, keyed by
  // url@sha256 so it ignores asset ORDER and transient fetch failures (a single
  // network blip must not change the fingerprint). partial=true flags that some
  // assets couldn't be hashed, so a hash mismatch isn't over-trusted.
  let pageHash = null;
  if (doHash) {
    const joined = sliced.filter((a) => a.sha256).map((a) => a.url + "@" + a.sha256).sort().join("|");
    try {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
      pageHash = Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    } catch {}
  }
  return { count: list.length, returned: sliced.length, hashedCount, failedCount, partial: failedCount > 0, pageHash, assets: sliced };
}

function __findByRoleName(wantRole, wantName, exact) {
  const interactive = "a,button,input,textarea,select,label,summary,[role],[contenteditable=\"true\"]";
  const candidates = Array.from(document.querySelectorAll(interactive));
  const accName = (el) => {
    const v = el.getAttribute("aria-label") || el.getAttribute("alt") ||
              el.getAttribute("title") || el.getAttribute("placeholder") || "";
    if (v) return v.trim();
    return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
  };
  const accRole = (el) => el.getAttribute("role") || el.tagName.toLowerCase();
  const isVisible = (el) => {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(wantName);

  let best = null, bestScore = -1;
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const role = accRole(el);
    const name = accName(el);
    const nameNorm = norm(name);
    let roleScore = 0;
    if (wantRole) {
      const wr = norm(wantRole);
      if (role === wr) roleScore = 2;
      else if (role.includes(wr) || wr.includes(role)) roleScore = 1;
      else continue;
    } else roleScore = 1;
    let nameScore = 0;
    if (target) {
      if (nameNorm === target) nameScore = 4;
      else if (!exact && nameNorm.includes(target)) nameScore = 2;
      else if (!exact && target.includes(nameNorm) && nameNorm.length >= 3) nameScore = 1;
      else continue;
    }
    const score = roleScore + nameScore;
    if (score > bestScore) { best = el; bestScore = score; }
  }
  if (!best) return { error: `no element matching role=${wantRole ?? "*"} name=${wantName ?? "*"}` };
  const sel = (() => {
    if (best.id) return `#${CSS.escape(best.id)}`;
    if (best.dataset?.testid) return `[data-testid="${CSS.escape(best.dataset.testid)}"]`;
    const nm = best.getAttribute("name");
    if (nm) return `${best.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`;
    const al = best.getAttribute("aria-label");
    if (al) {
      const r = best.getAttribute("role");
      return r ? `[role="${CSS.escape(r)}"][aria-label="${CSS.escape(al)}"]`
               : `${best.tagName.toLowerCase()}[aria-label="${CSS.escape(al)}"]`;
    }
    const parent = best.parentElement;
    if (!parent) return best.tagName.toLowerCase();
    const same = Array.from(parent.children).filter((c) => c.tagName === best.tagName);
    const idx = same.indexOf(best) + 1;
    return `${best.tagName.toLowerCase()}:nth-of-type(${idx})`;
  })();
  best.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  const r = best.getBoundingClientRect();
  return {
    selector: sel,
    role: accRole(best), name: accName(best),
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    score: bestScore,
  };
}

function __assertCondition(kind, target, value) {
  const fail = (got) => ({ ok: false, kind, target, value, got });
  const pass = (got) => ({ ok: true, kind, target, value, got });
  switch (kind) {
    case "url-contains": return location.href.includes(String(value)) ? pass(location.href) : fail(location.href);
    case "url-equals":   return location.href === String(value) ? pass(location.href) : fail(location.href);
    case "title-contains": return document.title.includes(String(value)) ? pass(document.title) : fail(document.title);
    case "element-exists": {
      try { return document.querySelector(target) ? pass("found") : fail("missing"); }
      catch (e) { return fail(`bad selector: ${e.message}`); }
    }
    case "element-missing": {
      try { return document.querySelector(target) ? fail("found") : pass("missing"); }
      catch (e) { return fail(`bad selector: ${e.message}`); }
    }
    case "text-contains":
    case "text-equals": {
      let el;
      try { el = target ? document.querySelector(target) : document.body; }
      catch (e) { return fail(`bad selector: ${e.message}`); }
      if (!el) return fail("element not found");
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const ok = kind === "text-equals" ? text === String(value) : text.includes(String(value));
      return ok ? pass(text.slice(0, 200)) : fail(text.slice(0, 200));
    }
    default: return { ok: false, kind, error: `unknown assert kind: ${kind}` };
  }
}

// Keep the cached session config's `url` in sync with the primary tab's
// current location, so dispatchWithAutoRecover restores users to where they
// actually were — not the about:blank they started from. Skips non-http(s)
// URLs (chrome://, about:, data:, extension pages) which aren't useful to
// replay and would break the new tab's startup.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  if (!/^https?:\/\//i.test(change.url)) return;
  const clientId = tabOwner.get(tabId);
  if (!clientId) return;
  const session = sessions.get(clientId);
  if (!session || tabId !== session.primaryTabId) return;
  const cfg = await getCachedSessionConfig(clientId);
  if (!cfg || cfg.url === change.url) return;
  await cacheSessionConfig(clientId, { ...cfg, url: change.url });
});

// ---------------- key metadata for CDP ----------------

function keyMeta(key) {
  const NAMED = {
    Enter: { code: "Enter", vk: 13 }, Tab: { code: "Tab", vk: 9 },
    Escape: { code: "Escape", vk: 27 }, Backspace: { code: "Backspace", vk: 8 },
    Delete: { code: "Delete", vk: 46 },
    ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
    Home: { code: "Home", vk: 36 }, End: { code: "End", vk: 35 },
    PageUp: { code: "PageUp", vk: 33 }, PageDown: { code: "PageDown", vk: 34 },
    Space: { code: "Space", vk: 32, text: " " }, " ": { code: "Space", vk: 32, text: " " },
  };
  if (NAMED[key]) return { key, code: NAMED[key].code, vk: NAMED[key].vk, text: NAMED[key].text };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    let code = "", vk = 0;
    if (/[A-Z]/.test(upper)) { code = `Key${upper}`; vk = upper.charCodeAt(0); }
    else if (/[0-9]/.test(key)) { code = `Digit${key}`; vk = 48 + Number(key); }
    return { key, code, vk, text: key };
  }
  return { key, code: "", vk: 0 };
}

// ---------------- boundary enforcement ----------------

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
  const ownerClientId = tabOwner.get(tab.openerTabId);
  if (!ownerClientId) return;
  const session = sessions.get(ownerClientId);
  if (!session) return;
  try {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: session.groupId });
    session.tabIds.add(tab.id);
    tabOwner.set(tab.id, ownerClientId);
    schedulePersistSessions();
  } catch {}
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.groupId === undefined) return;
  const ownerClientId = tabOwner.get(tabId);
  if (!ownerClientId) return;
  const session = sessions.get(ownerClientId);
  if (!session) return;
  if (change.groupId !== session.groupId) {
    // Tab got dragged out — release it from the session.
    session.tabIds.delete(tabId);
    tabOwner.delete(tabId);
    detachIfAttached(tabId);
    if (tabId === session.primaryTabId) {
      const next = session.tabIds.values().next().value;
      session.primaryTabId = next ?? null;
    }
    schedulePersistSessions();
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") overlayInjected.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabBuffers.delete(tabId);
  overlayInjected.delete(tabId);
  cacheDisabledTabs.delete(tabId);
  const ownerClientId = tabOwner.get(tabId);
  if (!ownerClientId) return;
  tabOwner.delete(tabId);
  const session = sessions.get(ownerClientId);
  if (!session) return;
  session.tabIds.delete(tabId);
  if (tabId === session.primaryTabId) {
    const next = session.tabIds.values().next().value;
    session.primaryTabId = next ?? null;
  }
  if (session.tabIds.size === 0) {
    sessions.delete(ownerClientId);
  }
  schedulePersistSessions();
});

chrome.tabGroups.onRemoved.addListener((group) => {
  // Find which session owned this group.
  for (const [clientId, session] of sessions) {
    if (session.groupId === group.id) {
      detachSessionTabs(session);
      dropSession(clientId);
      break;
    }
  }
});

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`navigation timeout for tab ${tabId}`));
    }, NAV_TIMEOUT_MS);
    const listener = (id, change) => {
      if (id !== tabId) return;
      if (change.status === "complete") {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete" && !done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

// ---------------- popup messages ----------------

// Snapshot of the currently-focused tab the user is looking at. Used by the
// popup when "include current URL" / "include recent console errors" toggles
// are on. Each toggle is independent — opts let callers request only the
// subset they want.
async function gatherBrowserContext({ url: wantUrl = true, errors: wantErrors = true } = {}) {
  let tab = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = t || null;
  } catch {}
  if (!tab) return null;
  const ctx = {};
  if (wantUrl) {
    ctx.url = tab.url || null;
    ctx.title = tab.title || null;
    ctx.tabId = tab.id ?? null;
    ctx.viewport = (tab.width && tab.height) ? `${tab.width}x${tab.height}` : null;
  }
  if (wantErrors) {
    const buf = tabBuffers.get(tab.id);
    if (buf && Array.isArray(buf.console)) {
      const errors = [];
      for (let i = buf.console.length - 1; i >= 0 && errors.length < 5; i--) {
        const c = buf.console[i];
        if (c.level === "error" || c.level === "warning" || c.source === "exception") {
          const loc = c.url ? ` @ ${c.url}${c.line ? `:${c.line}` : ""}` : "";
          errors.push(`[${c.level}] ${c.text}${loc}`);
        }
      }
      if (errors.length) ctx.recentErrors = errors.reverse();
    }
  }
  return Object.keys(ctx).length ? ctx : null;
}

// Capture the visible viewport of `tabId` as a PNG data URI. If `rect` is
// provided (CSS pixels relative to viewport), crop to it via OffscreenCanvas.
// The capture is at device-pixel resolution, so we scale rect by dpr before
// drawing. Returns null on any failure.
async function captureCroppedScreenshot({ tabId, rect, dpr }) {
  let dataUri;
  try {
    // captureVisibleTab does not actually require a tabId — it grabs whatever
    // window-level tab is visible. We use the windowId derived from the tab.
    const tab = await chrome.tabs.get(tabId);
    dataUri = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    console.warn("[mochi] captureVisibleTab failed:", e?.message ?? e);
    return null;
  }
  if (!rect) return dataUri;
  try {
    const resp = await fetch(dataUri);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    // captureVisibleTab returns at device-pixel resolution. Our rect is in
    // CSS pixels, so scale by dpr to find the source crop region. We rely on
    // the modal's gatherViewport() to provide dpr — service worker has no
    // `window` object to fall back to.
    const ratio = dpr || 1;
    const sx = Math.max(0, Math.round(rect.x * ratio));
    const sy = Math.max(0, Math.round(rect.y * ratio));
    const sw = Math.max(1, Math.min(bitmap.width  - sx, Math.round(rect.width  * ratio)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * ratio)));
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    // Encode blob → data URI.
    const reader = new FileReader();
    return await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(outBlob);
    });
  } catch (e) {
    console.warn("[mochi] screenshot crop failed:", e?.message ?? e);
    return dataUri; // fall back to full visible capture if cropping breaks
  }
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      if (req?.type === "popup_status") {
        const sessionList = [...sessions.values()].map((s) => ({
          id: s.id, clientId: s.clientId,
          tabCount: s.tabIds.size,
          attachedCount: [...s.tabIds].filter((id) => attachedTabs.has(id)).length,
        }));
        sendResponse({
          status: ws?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
          role: extensionRole,
          standbyReason,
          sessions: sessionList,
          sessionCount: sessions.size,
          connectionEnabled,
        });
      } else if (req?.type === "popup_take_over") {
        requestTakeover();
        sendResponse({ ok: true });
      } else if (req?.type === "popup_toggle") {
        connectionEnabled = !connectionEnabled;
        await chrome.storage.local.set({ connectionEnabled });
        if (connectionEnabled) { reconnectAttempts = 0; connect(); }
        else { try { ws?.close(); } catch {} }
        sendResponse({ connectionEnabled });
      } else if (req?.type === "popup_end_all_sessions") {
        // End every session; useful to reset state if something got stuck.
        const ids = [...sessions.keys()];
        for (const cid of ids) {
          try { await sessionEnd({ closeTabs: false }, cid); } catch {}
        }
        sendResponse({ ended: ids.length });
      } else if (req?.type === "popup_get_claude_sessions") {
        sendResponse({ sessions: claudeSessionsCache });
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
        // The test toast has served its purpose — clear it so it doesn't linger.
        try { await chrome.notifications.clear("mochi:global:test"); } catch {}
        notifTargets.delete("mochi:global:test");
        sendResponse({ verified: notifPrefs.verified });
      } else if (req?.type === "popup_send_test_notification") {
        let ok = false;
        try {
          // Re-creating with the same id only UPDATES an existing toast and may
          // not re-pop a visible banner — clear first so the retry always shows.
          try { await chrome.notifications.clear("mochi:global:test"); } catch {}
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
          const origin = WS_URL.replace(/^ws/, "http");
          const r = await fetch(`${origin}/os/open-notification-settings`, { method: "POST" });
          const body = await r.json().catch(() => ({}));
          ok = r.ok && body.ok !== false;
        } catch {}
        sendResponse({ ok });
      } else if (req?.type === "popup_comment_status") {
        await commentTabsReady;
        let count = 0, active = false;
        try {
          let tab; try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}
          active = !!(tab && tab.id != null && commentTabs.has(tab.id));   // status for THIS tab
          // Count from the live `mochiComments` store (the legacy
          // mochiCommentSession.comments array is always empty post-0.8.0) so the
          // badge reflects agent- and human-added comments for THIS site.
          let origin = null; try { origin = tab && tab.url ? new URL(tab.url).origin : null; } catch {}
          const mc = await mcGet();
          const sid = origin && mc.activeByOrigin ? mc.activeByOrigin[origin] : null;
          const cs = sid && mc.sessions && mc.sessions[sid] ? mc.sessions[sid] : null;
          count = (cs && Array.isArray(cs.comments)) ? cs.comments.length : 0;
        } catch {}
        sendResponse({ active, count });
      } else if (req?.type === "popup_start_comment_session") {
        let tab;
        try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}
        if (!tab || !tab.id) { sendResponse({ ok: false, error: "no active tab" }); return; }
        if (tab.url && /^(chrome|edge|brave|chrome-extension|devtools|about|view-source):/i.test(tab.url)) {
          sendResponse({ ok: false, error: "Can't run on this page (browser-internal). Open a normal website or your localhost app." });
          return;
        }
        const ok = await startCommentSession(tab.id);
        sendResponse({ ok });
      } else if (req?.type === "popup_stop_comment_session") {
        // Stop the focused tab's session (per-tab).
        let tab; try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}
        if (tab && tab.id != null) await stopCommentSession(tab.id);
        else await stopCommentSession();
        sendResponse({ ok: true });
      } else if (req?.type === "comment_register_tab") {
        await commentTabsReady;
        if (sender?.tab?.id != null) { commentTabs.add(sender.tab.id); persistCommentTabs(); }
        sendResponse({ ok: true });
      } else if (req?.type === "comment_unregister_tab") {
        if (sender?.tab?.id != null) await unregisterCommentTab(sender.tab.id);
        sendResponse({ ok: true });
      } else if (req?.type === "popup_send_claude_message") {
        const sessionId = req.sessionId;
        const message = String(req.message ?? "").trim();
        // Backward-compat: old popup.js sent `includeContext` as a single bool.
        // New popup/modal send `includeUrl` + `includeConsoleErrors` separately.
        const legacy = req.includeContext === true;
        const wantUrl    = req.includeUrl !== undefined ? !!req.includeUrl    : legacy;
        const wantErrors = req.includeConsoleErrors !== undefined ? !!req.includeConsoleErrors : legacy;
        const domContext = (req.domContext && typeof req.domContext === "object") ? req.domContext : null;
        const pickedElements = Array.isArray(req.pickedElements) ? req.pickedElements : null;
        const viewport   = (req.viewport && typeof req.viewport === "object") ? req.viewport : null;
        const shotIntent = (req.screenshotIntent && typeof req.screenshotIntent === "object") ? req.screenshotIntent : null;
        if (!sessionId || !message) {
          sendResponse({ ok: false, error: "sessionId and message required" });
          return;
        }
        let context = null;
        if (wantUrl || wantErrors || domContext || pickedElements || viewport || shotIntent) {
          context = {};
          if (wantUrl || wantErrors) {
            try {
              const pulled = await gatherBrowserContext({ url: wantUrl, errors: wantErrors });
              if (pulled) Object.assign(context, pulled);
            } catch {}
          }
          // New: inline-reference array. Hook formatter renders these next to
          // their [#N] markers in the message text.
          if (pickedElements && pickedElements.length) context.pickedElements = pickedElements;
          // Legacy: single pickedElement (still supported for popup form).
          if (domContext && !pickedElements) context.pickedElement = domContext;
          if (viewport) context.viewport = viewport;
          if (shotIntent) {
            try {
              const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              if (tab && tab.id) {
                const dataUri = await captureCroppedScreenshot({
                  tabId: tab.id,
                  rect: shotIntent.rect,
                  dpr: viewport?.devicePixelRatio,
                });
                if (dataUri) {
                  context.screenshot = {
                    dataUri,
                    scope: shotIntent.scope,
                    rect: shotIntent.rect,
                    format: "png",
                  };
                }
              }
            } catch (e) {
              console.warn("[mochi] screenshot intent failed:", e?.message ?? e);
            }
          }
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          sendResponse({ ok: false, error: "broker not connected" });
          return;
        }
        // Send via WS; broker enqueues into the claudeInbox for this session.
        // We don't await an ack — broker responds asynchronously and the popup
        // re-polls sessions to confirm the queuedCount bumped.
        try {
          ws.send(JSON.stringify({
            id: `popup-${Date.now()}`,
            type: "send_claude_message",
            sessionId, message, context,
          }));
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message ?? e) });
        }
      } else {
        sendResponse({ error: "unknown popup message" });
      }
    } catch (e) {
      sendResponse({ error: String(e?.message ?? e) });
    }
  })();
  return true;
});

// ---------- Keyboard-shortcut: open in-page send-hint modal ----------------
// Triggered by chrome.commands (Cmd+Shift+M / Ctrl+Shift+M by default).
// Injects mochi-modal.js into the active tab via chrome.scripting; the
// modal lives in a shadow-DOM container so it doesn't inherit page styles.
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "open-send-hint-modal" && cmd !== "toggle-comment-mode") return;
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}
  if (!tab || !tab.id) return;
  // chrome:// and similar are restricted — don't try to inject.
  if (tab.url && /^(chrome|edge|brave|chrome-extension|devtools|about|view-source):/i.test(tab.url)) {
    try { chrome.action.setBadgeText({ text: "!", tabId: tab.id }); } catch {}
    setTimeout(() => { try { chrome.action.setBadgeText({ text: "", tabId: tab.id }); } catch {} }, 1500);
    return;
  }
  if (cmd === "toggle-comment-mode") {
    // Toggle THIS tab only (await hydration so a cold-boot set isn't empty).
    await commentTabsReady;
    if (commentTabs.has(tab.id)) { await stopCommentSession(tab.id); }
    else { await startCommentSession(tab.id); }
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["mochi-modal.js"],
    });
  } catch (e) {
    // Most common: page is in an isolated extension context we can't reach.
    // Silent failure — user can still use the popup.
    try { console.warn("[mochi] modal inject failed:", e?.message); } catch {}
  }
});

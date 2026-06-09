# Design-QA Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Let an agent run a design-QA pass that drops Comment-Mode comments on issues (visible client-side), then read the session back and fix in bulk — via 4 new browser-MCP bridge tools + a `/mochi:design-qa` command, with session selection + meaningful names in the browser.

**Architecture:** New tools route through the existing bridge to the extension background, which read-modify-writes the shared `chrome.storage.local["mochiComments"]` store (same shape Comment Mode v2 uses), so agent comments appear as live pins. Comment Mode gains severity/resolved rendering and a session switcher. The `/mochi:design-qa` skill orchestrates the browser MCP.

**Tech Stack:** Node ESM MCP server (esbuild), Chrome MV3 extension, chrome.storage, chrome.scripting.

---

## Task 1: Bridge tool schemas (server)
**Files:** Modify `server/src/tools.js`

- [ ] Add 4 tool defs to the `tools` array (after `browser_request_attention`):
```js
{
  name: "browser_comment_add",
  description: "Drop a Comment-Mode comment on a page element (visible to the human in the Mochi extension as a pin). Use during design QA: one call per issue. Resolves the element on the live session tab and stores it in a named session for this site.",
  inputSchema: { type: "object", properties: {
    selector: { type: "string", description: "CSS selector for the element (use refs from browser_snapshot)." },
    ref:      { type: "string", description: "Alias for selector." },
    text:     { type: "string", description: "The comment / instruction to fix." },
    sessionName: { type: "string", description: "Session to add to (find-or-create for this origin). Use a meaningful, project-wise name." },
    breakpoint:  { type: "object", description: "Optional {label,width} when commenting at a responsive width." },
    severity: { type: "string", enum: ["low","medium","high"], description: "Optional severity (tints the pin)." },
  }, required: ["text"] },
},
{ name: "browser_comment_list", description: "List Comment-Mode comments (for bulk-fixing a QA session). Returns n, route, url, selector, element, text, severity, resolved.",
  inputSchema: { type: "object", properties: {
    sessionId: { type: "string" }, sessionName: { type: "string" }, origin: { type: "string" },
    includeResolved: { type: "boolean", default: true },
  } } },
{ name: "browser_comment_sessions", description: "List Comment-Mode sessions (id, name, origin, comment count, updatedAt).",
  inputSchema: { type: "object", properties: { origin: { type: "string" } } } },
{ name: "browser_comment_resolve", description: "Mark a Comment-Mode comment resolved (or unresolved) after fixing it; the pin shows a checkmark.",
  inputSchema: { type: "object", properties: { id: { type: "string" }, resolved: { type: "boolean", default: true } }, required: ["id"] } },
```
- [ ] Add to `TOOL_TO_WS_TYPE`:
```js
  browser_comment_add: "comment_add",
  browser_comment_list: "comment_list",
  browser_comment_sessions: "comment_sessions",
  browser_comment_resolve: "comment_resolve",
```

## Task 2: Background handlers (extension)
**Files:** Modify `extension/background.js` — add dispatch cases + handlers.

- [ ] In `dispatch` switch add:
```js
    case "comment_add":        return commentAdd(p, clientId);
    case "comment_list":       return commentList(p, clientId);
    case "comment_sessions":   return commentSessions(p, clientId);
    case "comment_resolve":    return commentResolve(p, clientId);
```
- [ ] Add the implementation (storage shape MUST match comment-mode.js):
```js
const MC_KEY = "mochiComments";
function mcGet() { return new Promise((r) => { try { chrome.storage.local.get([MC_KEY], (o) => r((o && o[MC_KEY]) || { v: 2, taughtScroll: false, activeByOrigin: {}, pending: null, sessions: {} })); } catch { r({ v:2, activeByOrigin:{}, sessions:{} }); } }); }
function mcSet(store) { return new Promise((r) => { try { chrome.storage.local.set({ [MC_KEY]: store }, r); } catch { r(); } }); }
const mcUid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

// resolve element metadata in the session's primary tab
async function resolveElementMeta(tabId, selector) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId }, args: [selector],
    func: (sel) => {
      function uniq(el){ if(!el||el.nodeType!==1) return ""; if(el.id&&/^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return "#"+el.id; const parts=[]; let c=el; while(c&&c.nodeType===1&&c!==document.documentElement){ let p=c.tagName.toLowerCase(); if(c.id&&/^[A-Za-z][A-Za-z0-9_-]*$/.test(c.id)){parts.unshift("#"+c.id);break;} if(c.classList&&c.classList.length){const cl=[...c.classList].slice(0,2).map(x=>x.replace(/[^A-Za-z0-9_-]/g,"")).filter(Boolean).join(".");if(cl)p+="."+cl;} const par=c.parentElement; if(par){const sib=[...par.children].filter(x=>x.tagName===c.tagName); if(sib.length>1)p+=":nth-of-type("+(sib.indexOf(c)+1)+")";} parts.unshift(p); c=par; if(parts.length>=6)break;} return parts.join(" > ")||el.tagName.toLowerCase(); }
      const el = sel ? document.querySelector(sel) : null;
      const base = { route: location.pathname + location.search, url: location.href, origin: location.origin,
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 } };
      if (!el) return { ok: false, ...base, selector: sel || "" };
      const r = el.getBoundingClientRect(); const role = el.getAttribute("role") || el.tagName.toLowerCase();
      return { ok: true, ...base, selector: uniq(el), tagName: el.tagName.toLowerCase(), role,
        elementText: (el.innerText || el.textContent || "").trim().replace(/\s+/g," ").slice(0,90),
        box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } };
    },
  });
  return result || null;
}
async function commentAdd({ selector, ref, text, sessionName, breakpoint, severity } = {}, clientId) {
  const sess = sessions.get(clientId); if (!sess) throw new Error("no active session");
  const sel = selector || ref || "";
  const meta = await resolveElementMeta(sess.primaryTabId, sel);
  if (!meta) throw new Error("could not resolve page");
  const store = await mcGet();
  const origin = meta.origin;
  let s = Object.values(store.sessions).find((x) => x.origin === origin && x.name === sessionName);
  if (!s) { s = { id: mcUid("s"), name: sessionName || `QA ${new Date().toISOString().slice(0,10)}`, origin, createdAt: Date.now(), updatedAt: Date.now(), comments: [] }; store.sessions[s.id] = s; }
  const n = s.comments.reduce((m, c) => Math.max(m, c.n || 0), 0) + 1;
  const comment = { id: mcUid("c"), sessionId: s.id, n, text: String(text || ""), url: meta.url, route: meta.route, origin,
    selector: meta.selector || sel, tagName: meta.tagName || "", role: meta.role || "", elementText: meta.elementText || "",
    box: meta.box || { x: 0, y: 0, w: 0, h: 0 }, viewport: meta.viewport || { w: 0, h: 0, dpr: 1 },
    breakpoint: breakpoint || null, severity: severity || null, resolved: false, createdAt: Date.now() };
  s.comments.push(comment); s.updatedAt = Date.now();
  store.activeByOrigin[origin] = s.id;   // make active so the human sees its pins
  await mcSet(store);
  return { ok: true, id: comment.id, n, sessionId: s.id, sessionName: s.name, located: !!meta.ok };
}
async function commentList({ sessionId, sessionName, origin, includeResolved = true } = {}) {
  const store = await mcGet();
  let list = Object.values(store.sessions);
  if (sessionId) list = list.filter((s) => s.id === sessionId);
  else if (sessionName) list = list.filter((s) => s.name === sessionName);
  if (origin) list = list.filter((s) => s.origin === origin);
  const comments = list.flatMap((s) => s.comments.map((c) => ({ ...c, sessionId: s.id, sessionName: s.name })))
    .filter((c) => includeResolved || !c.resolved).sort((a, b) => (a.route || "").localeCompare(b.route || "") || a.n - b.n);
  return { ok: true, count: comments.length, comments };
}
async function commentSessions({ origin } = {}) {
  const store = await mcGet();
  const list = Object.values(store.sessions).filter((s) => !origin || s.origin === origin)
    .map((s) => ({ id: s.id, name: s.name, origin: s.origin, count: s.comments.length, updatedAt: s.updatedAt }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, sessions: list };
}
async function commentResolve({ id, resolved = true } = {}) {
  const store = await mcGet();
  let hit = false;
  for (const s of Object.values(store.sessions)) { const c = s.comments.find((x) => x.id === id); if (c) { c.resolved = !!resolved; s.updatedAt = Date.now(); hit = true; break; } }
  if (hit) await mcSet(store);
  return { ok: hit, id, resolved };
}
```
(These are pure storage ops — they don't need comment mode to be "on". Reads `mochiComments` directly.)

## Task 3: Comment Mode — severity, resolved, session switcher, meaningful default name
**Files:** Modify `extension/comment-mode.js`

- [ ] **Meaningful default name** in `newSessionObj`: default name = `document.title?.trim()` (sliced 40) `|| host`, e.g. `` `${(document.title||'').trim().slice(0,40) || location.host} · ${count}` ``.
- [ ] **Severity tint** on pins: in `renderPins`/`positionDevPins` pin creation, add `el.classList.add('sev-'+c.severity)` when set. CSS: `.pin.sev-high{background:#dc2626}.pin.sev-medium{background:#f59e0b}.pin.sev-low{background:#9ca3af}`. List row: show a severity chip.
- [ ] **Resolved render:** if `c.resolved`, pin gets `.pin.done` (checkmark via `el.textContent='✓'` + dimmed); list row dimmed + struck. Add a "Hide resolved" toggle in the comments view header (a chip that filters).
- [ ] **Session switcher pill:** add a small `.sesspill` element (in `layer`, above the FAB) showing the active session name; click → opens a compact switcher (list this-origin sessions + active check + ＋ New). Reuse `sessionsForOrigin/switchSession/newSession`. Also add it to the navigator header. Update it in `updateCounts()`/`renderPins()`.
- [ ] Re-render on `comment_add` writes (already covered by `onStorageChanged` adopting `mochiComments`).

## Task 4: `/mochi:design-qa` command
**Files:** Create `plugins/qa/commands/design-qa.md`; register in `.claude-plugin/plugin.json` commands array.

- [ ] Command instructs the agent: derive a meaningful session name `<repo-basename> · <branch> — QA <date>` (run `git rev-parse --abbrev-ref HEAD`); ensure a browser session (`browser_session_start`); for each route (given or discovered) and optional breakpoints (`browser_emulate_viewport`): `browser_screenshot` + `browser_audit_interactives` + `browser_assert_no_errors`; judge design/UX (default heuristics + the optional `$ARGUMENTS` focus); `browser_comment_add` per issue with severity; finish by reporting the session name + count and telling the user to open Comment Mode. Document **fix mode**: `browser_comment_list` → fix in code → `browser_comment_resolve`.

## Task 5: Tests + counts + docs + bundle
**Files:** `server/_smoke.mjs`, `server/_integration.mjs`, `README.md`, `CHANGELOG.md`, rebuild bundle.

- [ ] `_smoke.mjs`: add the 4 names to `want`.
- [ ] `_integration.mjs`: bump count `61 → 65`; add a `comment_add`/`comment_list` round-trip via the fake extension (fake returns `{ok:true,id,n,...}` / `{ok:true,comments:[]}`), assert ok.
- [ ] `README.md`: `61 → 65 tools`; add a Design-QA row/paragraph.
- [ ] `CHANGELOG.md`: `0.9.0` entry.
- [ ] `cd server && npm run build`; `npm test` green (65 tools).

## Task 6: Version + ship
- [ ] Bump `.claude-plugin/plugin.json` + `server/package.json` + lockfile to `0.9.0`.
- [ ] Commit, PR → Master, merge, re-sync plugin, re-point `~/mochi-extension`.

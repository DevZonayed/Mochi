// Mochi Comment Mode — standalone in-page visual annotation.
//
// Injected on demand from the popup's "Comment mode" button (or an optional
// keyboard shortcut the user assigns at chrome://extensions/shortcuts).
// Needs NO Claude session.
// The user drops numbered comments on elements across pages + breakpoints, then
// "Copy brief" exports an agent-ready markdown blob to paste into any coding
// agent. Lives in a closed shadow DOM so the host page can't style or see it.
//
// State lives in chrome.storage.local (`mochiCommentSession`); background
// re-injects this script on navigation so the FAB + pins survive page changes.

(() => {
  // Top frame only — never mount inside iframes (incl. our own responsive
  // preview frame, or any subframe we get injected into).
  try { if (window.top !== window.self) return; } catch { return; }

  const HOST_ID = "mochi-comment-host-7f3a";
  const SKEY = "mochiCommentSession";

  // Re-entrancy: if already mounted, just resync and bail.
  if (document.getElementById(HOST_ID)) {
    try { window.__mochiCommentResync && window.__mochiCommentResync(); } catch {}
    return;
  }

  // ---------------------------------------------------------------- state ----
  // Sessions live in `mochiComments` (content-owned). `mochiCommentSession`
  // (background-owned, key SKEY) carries only the comment-mode on/off flag.
  const DKEY = "mochiComments";
  // Deterministic id-based merge (comment-merge.js, injected just before us).
  // Lets us union the background bridge's writes with our own instead of
  // last-write-wins clobbering them.
  const Merge = (typeof globalThis !== "undefined" && globalThis.MochiCommentMerge) || null;
  let store = { v: 2, taughtScroll: false, activeByOrigin: {}, pending: null, sessions: {} };
  let modeActive = true;   // comment mode on/off (mirrors mochiCommentSession.active)

  // Sticky pick mode: once armed it stays on so you can drop many comments
  // without re-arming. `listening` = hover/click handlers currently attached
  // (paused while a comment popover is open).
  let pickMode = false, pickTarget = null, listening = false;
  let rafPending = false;
  let saveTimer = null;
  let lastWriteJson = null;

  const routeOf = (loc = location) => (loc.pathname || "/") + (loc.search || "");
  const originOf = (loc = location) => loc.origin;
  const uid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

  function applyStore(s) {
    if (s && typeof s === "object") {
      store = {
        v: 2,
        taughtScroll: !!s.taughtScroll,
        activeByOrigin: (s.activeByOrigin && typeof s.activeByOrigin === "object") ? { ...s.activeByOrigin } : {},
        pending: s.pending || null,
        sessions: (s.sessions && typeof s.sessions === "object") ? s.sessions : {},
      };
    }
  }
  function applySession(s) { applyStore(s); }   // legacy name (cross-tab listener)

  // ----- sessions -----
  function sessionsForOrigin(o) {
    return Object.values(store.sessions).filter((s) => s.origin === o)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function allSessions() {
    return Object.values(store.sessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function newSessionObj(origin, name) {
    const count = Object.values(store.sessions).filter((x) => x.origin === origin).length + 1;
    // Meaningful default: the app/page name (document.title) or host, + index.
    const base = (document.title || "").trim().replace(/\s+/g, " ").slice(0, 40) || location.host || "Session";
    return { id: uid("s"), name: name || `${base}${count > 1 ? " · " + count : ""}`, origin, createdAt: Date.now(), updatedAt: Date.now(), comments: [] };
  }
  function activeSession(create = true) {
    const o = originOf();
    let s = store.sessions[store.activeByOrigin[o]];
    if (!s && create) {
      s = sessionsForOrigin(o)[0] || newSessionObj(o);
      store.sessions[s.id] = s;
      store.activeByOrigin[o] = s.id;
    }
    return s || null;
  }
  function activeSessionId() { const s = activeSession(false); return s ? s.id : null; }
  function newSession() {
    const o = originOf();
    const s = newSessionObj(o);
    store.sessions[s.id] = s;
    store.activeByOrigin[o] = s.id;
    saveStore();
    return s;
  }
  function switchSession(id) {
    const s = store.sessions[id];
    if (!s) return;
    store.activeByOrigin[s.origin] = id;
    saveStore();
  }
  function renameSession(id, name) {
    const s = store.sessions[id];
    if (!s) return;
    s.name = (name || "").trim() || s.name;
    s.updatedAt = Date.now();
    saveStore();
  }
  function deleteSession(id) {
    const s = store.sessions[id];
    if (!s) return;
    delete store.sessions[id];
    if (store.activeByOrigin[s.origin] === id) {
      const next = sessionsForOrigin(s.origin)[0];
      if (next) store.activeByOrigin[s.origin] = next.id; else delete store.activeByOrigin[s.origin];
    }
    saveStore();
  }
  function findCommentSession(commentId) {
    return Object.values(store.sessions).find((s) => s.comments.some((c) => c.id === commentId)) || null;
  }

  // The active session = the comments for the current site. Each session
  // numbers its comments from #1.
  function currentComments() { const s = activeSession(false); return s ? s.comments : []; }
  function commentsForRoute(route) { return currentComments().filter((c) => c.route === route); }
  function maxN() { return currentComments().reduce((m, c) => Math.max(m, c.n || 0), 0); }

  function loadSession() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([DKEY, SKEY], (o) => {
          if (o && o[DKEY]) applyStore(o[DKEY]);
          else migrateLegacy(o && o[SKEY]);   // first run after upgrade
          modeActive = !(o && o[SKEY] && o[SKEY].active === false);
          resolve();
        });
      } catch { resolve(); }
    });
  }
  function migrateLegacy(legacy) {
    if (!legacy || !Array.isArray(legacy.comments) || !legacy.comments.length) return;
    const byOrigin = {};
    for (const c of legacy.comments) { const o = c.origin || originOf(); (byOrigin[o] = byOrigin[o] || []).push(c); }
    for (const o of Object.keys(byOrigin)) {
      const s = newSessionObj(o, "Session 1");
      s.comments = byOrigin[o].map((c) => ({ ...c, sessionId: s.id }));
      store.sessions[s.id] = s;
      if (!store.activeByOrigin[o]) store.activeByOrigin[o] = s.id;
    }
    if (legacy.taughtScroll) store.taughtScroll = true;
    saveStore();
  }
  function flushStore() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { lastWriteJson = JSON.stringify(store); chrome.storage.local.set({ [DKEY]: store }); } catch {}
  }
  function saveStore() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushStore, 120);
  }
  function saveSession() { saveStore(); }   // legacy name

  // --------------------------------------------------------- selector gen ----
  function uniqueSelector(el, doc) {
    if (!el || el.nodeType !== 1) return "";
    const root = (doc || document).documentElement;
    if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== root) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(cur.id)) { parts.unshift(`#${cur.id}`); break; }
      if (cur.classList && cur.classList.length) {
        const cls = [...cur.classList].slice(0, 2)
          .map((c) => c.replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join(".");
        if (cls) part += "." + cls;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length >= 6) break;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }
  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    const map = { a: "link", button: "button", input: "textbox", select: "combobox", img: "image", nav: "navigation", h1: "heading", h2: "heading", h3: "heading" };
    return map[t] || t;
  }
  function describe(el) {
    const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
    return txt;
  }

  // -------------------------------------------------------------- styles ----
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483600;pointer-events:none;";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
      :host {
        --bg:#fff; --bg2:rgba(0,0,0,0.04); --bd:rgba(0,0,0,0.10); --bd2:rgba(0,0,0,0.16);
        --tx:#0a0a0a; --mut:#6e6e76; --soft:#8e8e94; --pri:#2563eb; --pri2:#1d4fd1; --prifg:#fff;
        --ok:#16a34a; --dng:#dc2626; --pin:#2563eb;
        --sh:0 1px 2px rgba(0,0,0,.05),0 12px 28px -8px rgba(0,0,0,.22),0 4px 12px -2px rgba(0,0,0,.10);
      }
      @media (prefers-color-scheme: dark) {
        :host { --bg:#1c1c1f; --bg2:rgba(255,255,255,.06); --bd:rgba(255,255,255,.12); --bd2:rgba(255,255,255,.20);
          --tx:#f5f5f7; --mut:#a1a1a6; --soft:#6e6e76; --pri:#3b82f6; --pri2:#4d8ffb; --pin:#3b82f6;
          --sh:0 1px 2px rgba(0,0,0,.4),0 16px 32px -8px rgba(0,0,0,.55),0 6px 16px -2px rgba(0,0,0,.35); }
      }
      .pe { pointer-events: auto; }

      /* ---- FAB ---- */
      .fab-wrap { position: fixed; right: 18px; bottom: 18px; display:flex; flex-direction:column; align-items:flex-end; gap:10px; pointer-events:none; }
      .fab { position:relative; width:54px; height:54px; border-radius:50%; background:var(--pri); color:var(--prifg);
        border:none; cursor:pointer; box-shadow:var(--sh); display:flex; align-items:center; justify-content:center;
        pointer-events:auto; transition:transform 120ms cubic-bezier(.16,1,.3,1), background 120ms; }
      .fab:hover { transform: scale(1.06); background:var(--pri2); }
      .fab:active { transform: scale(.96); }
      .fab.armed { background:var(--ok); box-shadow:0 0 0 4px rgba(22,163,74,.25), var(--sh); }
      .fab .count { position:absolute; top:-4px; right:-4px; min-width:20px; height:20px; padding:0 5px; border-radius:10px;
        background:#0a0a0a; color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center;
        border:2px solid var(--bg); }
      /* ---- dock (macOS-style hover reveal) ---- */
      .dockzone { pointer-events:auto; display:flex; flex-direction:column; align-items:center; gap:10px; }
      .dock { display:none; flex-direction:column; align-items:center; gap:10px; margin-bottom:2px; }
      .dico { position:relative; width:44px; height:44px; border-radius:50%; background:var(--bg); color:var(--tx);
        border:1px solid var(--bd); box-shadow:var(--sh); cursor:pointer; display:flex; align-items:center; justify-content:center;
        opacity:0; transform:translateY(16px) scale(.5); transition:opacity .18s ease, transform .34s cubic-bezier(.34,1.56,.64,1); }
      .dico:hover { background:var(--bg2); transform:scale(1.12) !important; }
      .dico.danger { color:var(--dng); }
      .dock.open .dico { opacity:1; transform:none; }
      .dock.open .dico:nth-child(1){ transition-delay:.00s; }
      .dock.open .dico:nth-child(2){ transition-delay:.045s; }
      .dock.open .dico:nth-child(3){ transition-delay:.09s; }
      .dock.open .dico:nth-child(4){ transition-delay:.135s; }
      .dico::after { content:attr(data-tip); position:absolute; right:54px; top:50%; transform:translateY(-50%) scale(.9);
        white-space:nowrap; background:rgba(20,20,22,.96); color:#fff; font-size:11.5px; font-weight:600; padding:5px 9px;
        border-radius:8px; opacity:0; pointer-events:none; transition:opacity .12s, transform .12s; box-shadow:0 6px 18px rgba(0,0,0,.32); }
      .dico:hover::after { opacity:1; transform:translateY(-50%) scale(1); }

      /* ---- current-session pill + switcher ---- */
      .sesspill { pointer-events:auto; display:inline-flex; align-items:center; gap:6px; max-width:220px; align-self:flex-end;
        background:var(--bg); color:var(--tx); border:1px solid var(--bd); border-radius:16px; box-shadow:var(--sh);
        padding:5px 11px; cursor:pointer; font-size:11.5px; font-weight:600; transition:background 100ms; }
      .sesspill:hover { background:var(--bg2); }
      .sesspill-dot { width:7px; height:7px; border-radius:50%; background:var(--pri); flex-shrink:0; }
      .sesspill-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sessmenu { display:none; flex-direction:column; align-self:flex-end; width:230px; background:var(--bg); color:var(--tx);
        border:1px solid var(--bd); border-radius:12px; box-shadow:var(--sh); overflow:hidden; padding:4px; }
      .sessmenu.open { display:flex; }
      .sessrow { display:flex; align-items:center; gap:8px; padding:7px 9px; border:none; background:transparent; color:var(--tx);
        cursor:pointer; font-size:12.5px; font-family:inherit; border-radius:8px; text-align:left; }
      .sessrow:hover { background:var(--bg2); }
      .sessrow.on { font-weight:700; }
      .sessrow .ck { width:12px; flex-shrink:0; color:var(--pri); }
      .sessrow .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sessrow .ct { font-size:10.5px; color:var(--soft); }
      .sessrow.newrow { color:var(--pri); font-weight:600; border-top:1px solid var(--bd); border-radius:0; margin-top:2px; }
      .mbtn { pointer-events:auto; display:inline-flex; align-items:center; gap:8px; height:38px; padding:0 13px 0 12px;
        background:var(--bg); color:var(--tx); border:1px solid var(--bd); border-radius:19px; box-shadow:var(--sh);
        cursor:pointer; font-size:12.5px; font-weight:600; transition:background 100ms, transform 80ms; white-space:nowrap; }
      .mbtn:hover { background:var(--bg2); }
      .mbtn:active { transform:scale(.97); }
      .mbtn svg { color:var(--mut); flex-shrink:0; }
      .mbtn .pill { background:var(--pri); color:#fff; border-radius:9px; font-size:11px; padding:1px 6px; font-weight:700; }
      .mbtn.danger { color:var(--dng); }
      .mbtn.on { background:var(--ok); color:#fff; border-color:var(--ok); }
      .mbtn.on svg { color:#fff; }

      /* ---- pins ---- */
      .pin { position:fixed; width:24px; height:24px; border-radius:50% 50% 50% 2px; background:var(--pin); color:#fff;
        font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; cursor:pointer;
        box-shadow:0 2px 6px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.8); pointer-events:auto;
        transform:translate(-50%,-100%); transition:transform 90ms; z-index:6; }
      .pin:hover { transform:translate(-50%,-100%) scale(1.15); }
      .pin.detached { opacity:.5; filter:grayscale(.5); }
      .pin.sev-high { background:#dc2626; } .pin.sev-medium { background:#f59e0b; } .pin.sev-low { background:#9ca3af; }
      .pin.done { background:#16a34a; opacity:.7; }
      .pin.flash { animation:flash .8s ease-out 2; }
      @keyframes flash { 0%,100%{ box-shadow:0 2px 6px rgba(0,0,0,.35),0 0 0 2px rgba(255,255,255,.8);} 50%{ box-shadow:0 0 0 8px rgba(37,99,235,.45),0 0 0 2px #fff;} }

      .hl { position:fixed; pointer-events:none; border:2px solid var(--pri); background:rgba(37,99,235,.10);
        border-radius:3px; z-index:8; box-shadow:0 0 0 1px rgba(255,255,255,.6); transition:all 50ms ease-out; }

      .topbar { position:fixed; top:14px; left:50%; transform:translateX(-50%); background:rgba(20,20,22,.95);
        color:#fff; padding:8px 14px; border-radius:10px; font-size:12.5px; font-weight:500; z-index:9; pointer-events:none;
        box-shadow:0 8px 24px rgba(0,0,0,.3); display:inline-flex; align-items:center; gap:8px; backdrop-filter:blur(20px); }
      .topbar kbd { background:rgba(255,255,255,.16); border-radius:4px; padding:1px 6px; font-family:ui-monospace,Menlo,monospace; font-size:11px; }

      /* ---- popover ---- */
      .pop { position:fixed; width:300px; background:var(--bg); border:1px solid var(--bd); border-radius:12px;
        box-shadow:var(--sh); z-index:8; pointer-events:auto; overflow:hidden; color:var(--tx); }
      .pop .ph { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--bd); font-size:12px; }
      .pop .ph .dot { width:20px; height:20px; border-radius:50%; background:var(--pin); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
      .pop .ph .sel { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--mut); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
      .pop textarea { width:100%; border:none; resize:vertical; min-height:74px; padding:11px 12px; font-size:13px; line-height:1.5; background:var(--bg); color:var(--tx); outline:none; font-family:inherit; }
      .pop textarea::placeholder { color:var(--soft); }
      .pop .pf { display:flex; gap:8px; justify-content:flex-end; padding:9px 12px; border-top:1px solid var(--bd); }
      .pop .bp { font-size:10.5px; color:var(--mut); margin-right:auto; align-self:center; }
      .btn { appearance:none; border:1px solid var(--bd2); background:var(--bg); color:var(--tx); padding:6px 12px; border-radius:8px;
        cursor:pointer; font-size:12px; font-weight:600; font-family:inherit; transition:background 100ms,transform 80ms; }
      .btn:hover { background:var(--bg2); } .btn:active { transform:scale(.97); }
      .btn.primary { background:var(--pri); color:#fff; border-color:var(--pri); }
      .btn.primary:hover { background:var(--pri2); }
      .btn.danger { color:var(--dng); border-color:var(--bd2); }
      .btn.danger:hover { background:rgba(220,38,38,.08); }

      /* ---- list panel ---- */
      /* ---- floating navigator ---- */
      .nav { position:fixed; right:84px; bottom:18px; width:min(330px, calc(100vw - 96px)); max-height:min(70vh,560px); background:var(--bg); color:var(--tx);
        border:1px solid var(--bd); border-radius:16px; box-shadow:var(--sh); z-index:8; pointer-events:auto;
        display:flex; flex-direction:column; overflow:hidden;
        opacity:0; transform:translateY(12px) scale(.96); transform-origin:bottom right;
        transition:opacity .2s ease, transform .26s cubic-bezier(.16,1,.3,1); }
      .nav.open { opacity:1; transform:none; }
      .nav-hd { display:flex; align-items:center; gap:8px; padding:11px 12px; border-bottom:1px solid var(--bd); cursor:grab; user-select:none; }
      .nav-hd:active { cursor:grabbing; }
      .nav-title { flex:1; font-size:14px; font-weight:700; letter-spacing:-.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ico { appearance:none; border:none; background:transparent; color:var(--mut); width:30px; height:30px; border-radius:8px;
        display:inline-flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; transition:background 100ms,color 100ms; }
      .ico:hover { background:var(--bg2); color:var(--tx); }
      .ico.danger { color:var(--dng); }
      .ico.mini { width:26px; height:26px; }
      .nav-tools { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--bd); }
      .chips { display:flex; gap:4px; background:var(--bg2); border-radius:9px; padding:3px; flex:1; }
      .chip { appearance:none; border:none; background:transparent; color:var(--mut); font-size:11.5px; font-weight:600; padding:4px 9px; border-radius:7px; cursor:pointer; font-family:inherit; }
      .chip.on { background:var(--bg); color:var(--tx); box-shadow:0 1px 2px rgba(0,0,0,.12); }
      .cmeta { flex:1; font-size:11.5px; color:var(--mut); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .nav-body { flex:1; overflow-y:auto; padding:6px 0; }
      .nav-ft { padding:10px 12px; border-top:1px solid var(--bd); display:flex; }
      .nav-ft:empty { display:none; }
      .navbtn { flex:1; appearance:none; border:1px solid var(--bd2); background:var(--bg); color:var(--tx); border-radius:9px; padding:8px;
        display:inline-flex; align-items:center; justify-content:center; gap:7px; cursor:pointer; font-size:12.5px; font-weight:600; font-family:inherit; }
      .navbtn:hover { background:var(--bg2); }
      .srow { display:flex; align-items:center; gap:8px; padding:10px 12px; cursor:pointer; transition:background 100ms; }
      .srow:hover { background:var(--bg2); }
      .srow.active { background:rgba(37,99,235,.08); }
      .srow .si { flex:1; min-width:0; }
      .srow .sname { font-size:13px; font-weight:600; display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .srow .badge { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:#fff; background:var(--pri); border-radius:6px; padding:1px 5px; }
      .srow .smeta { font-size:11px; color:var(--soft); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .srow .ico.mini { opacity:0; }
      .srow:hover .ico.mini { opacity:.85; }
      .srow .ico.mini.armed { opacity:1; background:var(--dng); color:#fff; }
      .rename-input { width:100%; font-family:inherit; font-size:13px; font-weight:600; color:var(--tx); background:var(--bg);
        border:1px solid var(--pri); border-radius:6px; padding:2px 6px; outline:none; }
      .grp-h { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); padding:11px 12px 5px; }
      .row { display:flex; gap:10px; padding:9px 12px; cursor:pointer; align-items:flex-start; transition:background 100ms; }
      .row:hover { background:var(--bg2); }
      .row .n { width:22px; height:22px; flex-shrink:0; border-radius:50%; background:var(--pin); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
      .row .c { flex:1; min-width:0; }
      .row .c .tx { font-size:13px; line-height:1.4; color:var(--tx); }
      .row .c .meta { font-size:11px; color:var(--soft); margin-top:3px; display:flex; gap:6px; flex-wrap:wrap; }
      .row .c .bp { background:var(--bg2); border-radius:8px; padding:0 6px; }
      .row .del { opacity:0; appearance:none; border:none; background:transparent; color:var(--dng); cursor:pointer; padding:2px; align-self:center; }
      .row:hover .del { opacity:.8; }
      .row.resolved { opacity:.55; }
      .row.resolved .tx { text-decoration:line-through; }
      .row .n.sev-high { background:#dc2626; } .row .n.sev-medium { background:#f59e0b; } .row .n.sev-low { background:#9ca3af; }
      .sev { text-transform:uppercase; font-weight:700; font-size:9.5px; letter-spacing:.03em; border-radius:6px; padding:0 5px; color:#fff; }
      .sev.sev-high { background:#dc2626; } .sev.sev-medium { background:#f59e0b; } .sev.sev-low { background:#9ca3af; }
      .empty { text-align:center; color:var(--soft); font-size:12.5px; padding:36px 22px; line-height:1.6; }

      /* ---- responsive device frame ---- */
      .dev { position:fixed; inset:0; background:rgba(10,10,12,.62); backdrop-filter:blur(6px); z-index:7; pointer-events:auto; display:flex; flex-direction:column; }
      .dev .dtop { display:flex; align-items:center; gap:8px; padding:12px 16px; color:#fff; flex-wrap:wrap; }
      .dev .dtop .seg { display:flex; gap:4px; background:rgba(255,255,255,.10); border-radius:10px; padding:4px; }
      .dev .dtop .seg button { appearance:none; border:none; background:transparent; color:#fff; opacity:.7; cursor:pointer; font-size:12px; font-weight:600; padding:5px 10px; border-radius:7px; }
      .dev .dtop .seg button.on { background:#fff; color:#0a0a0a; opacity:1; }
      .dev .dtop .grow { flex:1; }
      .dev .dwid { color:#fff; font-size:12px; opacity:.85; font-variant-numeric:tabular-nums; }
      .dev .dstage { flex:1; display:flex; align-items:center; justify-content:center; overflow:auto; padding:0 16px 20px; }
      .dev .framewrap { position:relative; background:#fff; border-radius:18px; box-shadow:0 24px 60px -12px rgba(0,0,0,.6); overflow:hidden; flex-shrink:0; }
      .dev .frameinner { position:absolute; top:0; left:0; transform-origin:0 0; }
      .dev iframe { border:none; display:block; background:#fff; width:100%; height:100%; }
      .dev .dnote { color:#fff; opacity:.85; font-size:12.5px; max-width:420px; text-align:center; line-height:1.6; background:rgba(0,0,0,.3); padding:14px 18px; border-radius:12px; }
      .dev .doverlay { position:absolute; inset:0; pointer-events:none; }
      .dev .dnum { width:64px; background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.22); color:#fff; border-radius:7px; padding:4px 7px; font-size:12px; font-family:inherit; }
      .dev .dnum:focus { outline:none; border-color:#fff; }
      .dev .dcustom { display:none; align-items:center; gap:6px; color:#fff; font-size:12px; }
      .dev .dcustom.on { display:inline-flex; }

      /* ---- scroll-teach ---- */
      .teach { position:fixed; left:50%; bottom:96px; transform:translateX(-50%); background:rgba(20,20,22,.95); color:#fff;
        padding:12px 16px; border-radius:12px; z-index:9; pointer-events:none; box-shadow:0 12px 32px rgba(0,0,0,.4);
        display:flex; align-items:center; gap:11px; font-size:13px; opacity:0; transition:opacity .4s; }
      .teach.show { opacity:1; }
      .teach .mouse { width:22px; height:34px; border:2px solid #fff; border-radius:12px; position:relative; flex-shrink:0; }
      .teach .mouse::after { content:""; position:absolute; left:50%; top:6px; width:3px; height:6px; border-radius:2px; background:#fff; transform:translateX(-50%); animation:wheel 1.3s ease-in-out infinite; }
      @keyframes wheel { 0%{opacity:0; transform:translate(-50%,0);} 30%{opacity:1;} 70%{opacity:1; transform:translate(-50%,8px);} 100%{opacity:0; transform:translate(-50%,10px);} }

      /* ---- toast ---- */
      .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(8px); background:#0a0a0a; color:#fff;
        padding:10px 16px; border-radius:10px; font-size:12.5px; font-weight:600; z-index:10; pointer-events:none; opacity:0;
        transition:opacity .2s, transform .2s; box-shadow:0 10px 30px rgba(0,0,0,.4); }
      .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    </style>
    <div class="layer"></div>
  `;
  const layer = root.querySelector(".layer");

  // --------------------------------------------------------------- toast ----
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; layer.appendChild(toastEl); }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add("show"));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  // ----------------------------------------------------------------- FAB ----
  // A single bubble. Hovering reveals a macOS-dock-style column of icon actions.
  const fabWrap = document.createElement("div");
  fabWrap.className = "fab-wrap";
  fabWrap.innerHTML = `
    <div class="sessmenu"></div>
    <button class="sesspill" title="Current comment session — click to switch"><span class="sesspill-dot"></span><span class="sesspill-name">…</span></button>
    <div class="dockzone">
      <div class="dock">
        <button class="dico" data-act="nav" data-tip="Navigator"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg></button>
        <button class="dico" data-act="responsive" data-tip="Responsive"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="12" rx="1"/><rect x="17" y="7" width="5" height="13" rx="1"/></svg></button>
        <button class="dico" data-act="copy" data-tip="Copy brief"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="dico danger" data-act="end" data-tip="End session"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <button class="fab" title="Comment — click to start · hover for more">
        <svg class="ico-comment" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="count" data-count>0</span>
      </button>
    </div>`;
  layer.appendChild(fabWrap);
  const fab = fabWrap.querySelector(".fab");
  const dock = fabWrap.querySelector(".dock");
  const dockzone = fabWrap.querySelector(".dockzone");

  const sesspill = fabWrap.querySelector(".sesspill");
  const sesspillName = fabWrap.querySelector(".sesspill-name");
  const sessmenu = fabWrap.querySelector(".sessmenu");
  function updateCounts() {
    const n = currentComments().length;   // active session (this site)
    root.querySelectorAll("[data-count]").forEach((e) => { e.textContent = String(n); e.style.display = n ? "" : "none"; });
    const s = activeSession(false);
    if (sesspillName) sesspillName.textContent = s ? s.name : "Start a session";
    if (sessmenu.classList.contains("open")) renderSessMenu();
  }
  // Quick current-session switcher (so you can comment into the agent's session).
  function renderSessMenu() {
    const list = sessionsForOrigin(originOf());
    const activeId = activeSessionId();
    sessmenu.innerHTML =
      list.map((s) => `<button class="sessrow${s.id === activeId ? " on" : ""}" data-sw="${s.id}"><span class="ck">${s.id === activeId ? "✓" : ""}</span><span class="nm">${escapeHtml(s.name)}</span><span class="ct">${s.comments.length}</span></button>`).join("")
      + `<button class="sessrow newrow" data-sw="__new">＋ New session</button>`;
  }
  sesspill.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = sessmenu.classList.toggle("open");
    if (open) renderSessMenu();
  });
  sessmenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sw]"); if (!b) return;
    e.stopPropagation();
    if (b.dataset.sw === "__new") { newSession(); } else { switchSession(b.dataset.sw); }
    sessmenu.classList.remove("open");
    updateCounts(); renderPins(); if (devState.open) renderDevPins(); if (panelEl) renderPanel();
  });
  // Outside-the-overlay clicks: the closed shadow retargets in-shadow clicks to
  // `host`, so this only fires (closes) for genuine page clicks.
  function onDocClickCloseSessMenu(e) {
    if (sessmenu.classList.contains("open") && !(e.target === host || host.contains(e.target))) sessmenu.classList.remove("open");
  }
  document.addEventListener("click", onDocClickCloseSessMenu, true);
  // Inside-the-shadow clicks: a document listener can't see these (retargeting),
  // so listen on the shadow root, where e.target is the real internal node.
  // Close the menu on any in-shadow click that isn't the pill or the menu itself
  // (clicking the FAB/dock used to leave the dropdown lingering).
  function onShadowClickCloseSessMenu(e) {
    if (!sessmenu.classList.contains("open")) return;
    if (sesspill.contains(e.target) || sessmenu.contains(e.target)) return;
    sessmenu.classList.remove("open");
  }
  root.addEventListener("click", onShadowClickCloseSessMenu, true);

  let dockTimer = null;
  function openDock() {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    dock.style.display = "flex"; void dock.offsetWidth; dock.classList.add("open");
  }
  function closeDock(now) {
    if (dockTimer) clearTimeout(dockTimer);
    dock.classList.remove("open");
    dockTimer = setTimeout(() => { dock.style.display = "none"; dockTimer = null; }, now ? 0 : 320);
  }
  dockzone.addEventListener("mouseenter", openDock);
  dockzone.addEventListener("mouseleave", () => closeDock());

  fab.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pickMode) { stopPick(); return; }   // armed → click finishes
    startPick(topPickTarget());             // one click → start commenting (stays on)
  });
  dock.addEventListener("click", (e) => {
    const b = e.target.closest(".dico"); if (!b) return;
    e.stopPropagation();
    closeDock(true);
    const act = b.dataset.act;
    if (act === "nav") openPanel();
    else if (act === "responsive") openDevice();
    else if (act === "copy") copyBrief();
    else if (act === "end") endSession();
  });

  // ------------------------------------------------------------- picker ----
  // A pick target abstracts top document vs an iframe (responsive mode).
  function topPickTarget() {
    return { doc: document, win: window, offset: () => ({ x: 0, y: 0 }), breakpoint: null };
  }

  let hlEl = null, topbarEl = null;
  // Enter sticky pick mode (stays armed across comments until Esc / 💬 / Done).
  function startPick(target) {
    if (pickMode) stopPick();
    pickMode = true; pickTarget = target;
    fab.classList.add("armed");
    closeDock(true);
    closePop();
    topbarEl = document.createElement("div"); topbarEl.className = "topbar";
    topbarEl.innerHTML = `<span>Click elements to comment — keep going.</span><kbd>Esc</kbd><span>or tap 💬 to finish</span>`;
    layer.appendChild(topbarEl);
    attachPickListeners();
  }
  // Attach the live hover/click handlers (paused while a popover is open).
  function attachPickListeners() {
    if (listening || !pickMode || !pickTarget) return;
    listening = true;
    hlEl = document.createElement("div"); hlEl.className = "hl"; layer.appendChild(hlEl);
    const doc = pickTarget.doc;
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onPick, true);
    // Bind Esc on BOTH the top document and the target doc — keydown inside an
    // iframe doesn't cross the frame boundary to the parent.
    document.addEventListener("keydown", onPickKey, true);
    if (doc !== document) { try { doc.addEventListener("keydown", onPickKey, true); } catch {} }
  }
  function detachPickListeners() {
    if (!listening) return;
    listening = false;
    const doc = pickTarget && pickTarget.doc;
    try { doc && doc.removeEventListener("mousemove", onMove, true); } catch {}
    try { doc && doc.removeEventListener("click", onPick, true); } catch {}
    document.removeEventListener("keydown", onPickKey, true);
    try { doc && doc !== document && doc.removeEventListener("keydown", onPickKey, true); } catch {}
    try { hlEl?.remove(); } catch {} hlEl = null;
  }
  function resumePickIfActive() { if (pickMode) attachPickListeners(); }
  // Fully exit pick mode.
  function stopPick() {
    detachPickListeners();
    pickMode = false; pickTarget = null;
    fab.classList.remove("armed");
    try { topbarEl?.remove(); } catch {} topbarEl = null;
    closePop();
  }
  function onPickKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopPick(); } }
  function hostHit(el) { return el === host || host.contains(el); }

  function onMove(ev) {
    if (!listening || !hlEl || !pickTarget) return;
    const el = pickTarget.doc.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || hostHit(el)) { hlEl.style.opacity = "0"; return; }
    const off = pickTarget.offset();
    const s = pickTarget.scale ? pickTarget.scale() : 1;
    const r = el.getBoundingClientRect();
    hlEl.style.opacity = "1";
    hlEl.style.left = `${off.x + r.left * s}px`;
    hlEl.style.top = `${off.y + r.top * s}px`;
    hlEl.style.width = `${r.width * s}px`;
    hlEl.style.height = `${r.height * s}px`;
  }
  function onPick(ev) {
    if (!listening || !pickTarget) return;
    const el = pickTarget.doc.elementFromPoint(ev.clientX, ev.clientY);
    // Let clicks on our own UI (FAB, ⋯ menu, popover) through so they still work
    // while armed — only intercept clicks on actual page elements.
    if (!el || hostHit(el)) return;
    ev.preventDefault(); ev.stopPropagation();
    const target = pickTarget;
    detachPickListeners();   // pause hovering while the popover is open (stay armed)
    openPop(el, target);
  }

  // ------------------------------------------------------------ popover ----
  let popEl = null, popOutside = null;
  function closePop() {
    if (popOutside) { try { document.removeEventListener("click", popOutside, true); } catch {} popOutside = null; }
    try { popEl?.remove(); } catch {} popEl = null;
  }
  function openPop(el, target, existing) {
    closePop();
    detachPickListeners();   // pause hovering while editing (stays armed if sticky)
    const off = target.offset();
    const r = el.getBoundingClientRect();
    const sx = target.win.scrollX || 0, sy = target.win.scrollY || 0;
    const sel = uniqueSelector(el, target.doc);
    const n = existing ? existing.n : maxN() + 1;
    popEl = document.createElement("div");
    popEl.className = "pop";
    popEl.innerHTML = `
      <div class="ph"><span class="dot">${n}</span><span class="sel">${escapeHtml(sel)}</span></div>
      <textarea placeholder="What should change here?  ·  Enter to save, Esc to cancel"></textarea>
      <div class="pf">
        <span class="bp">${target.breakpoint ? "@ " + target.breakpoint.label : ""}</span>
        ${existing ? '<button class="btn danger" data-x="del">Delete</button>' : ''}
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn primary" data-x="save">Save</button>
      </div>`;
    layer.appendChild(popEl);
    // position near element, clamped to viewport (scale-aware for the device frame)
    const ps = target.scale ? target.scale() : 1;
    const pw = 300, ph = 180;
    let left = off.x + r.left * ps, top = off.y + r.bottom * ps + 8;
    if (top + ph > window.innerHeight) top = Math.max(8, off.y + r.top * ps - ph - 8);
    left = Math.min(Math.max(8, left), window.innerWidth - pw - 8);
    popEl.style.left = `${left}px`; popEl.style.top = `${top}px`;
    const ta = popEl.querySelector("textarea");
    if (existing) ta.value = existing.text || "";
    ta.focus();

    function finishClose() { closePop(); resumePickIfActive(); }
    function doSave() {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (existing) { existing.text = text; existing.updatedAt = Date.now(); const es = findCommentSession(existing.id); if (es) es.updatedAt = Date.now(); }
      else {
        const s = activeSession();
        s.comments.push({
          id: uid("c"), sessionId: s.id,
          n, text,
          url: location.href, route: routeOf(), origin: originOf(),
          selector: sel, tagName: el.tagName.toLowerCase(), role: roleOf(el), elementText: describe(el),
          box: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
          viewport: { w: target.win.innerWidth, h: target.win.innerHeight, dpr: target.win.devicePixelRatio || 1 },
          breakpoint: target.breakpoint || null,
          createdAt: Date.now(), updatedAt: Date.now(),
        });
        s.updatedAt = Date.now();
      }
      saveSession(); updateCounts(); renderPins();
      toast(existing ? "Comment updated" : `Comment #${n} added`);
      if (devState.open) renderDevPins();
      finishClose();
    }
    popEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-x]"); if (!b) return;
      if (b.dataset.x === "cancel") finishClose();
      else if (b.dataset.x === "del") { deleteComment(existing.id); finishClose(); }
      else if (b.dataset.x === "save") doSave();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishClose(); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSave(); }   // Enter saves · Shift+Enter = newline
    });
    // Click anywhere outside the popover cancels it. All our UI lives in the
    // closed shadow host, so a page click never targets the popover itself.
    popOutside = (e) => { if (e.target === host || host.contains(e.target)) return; finishClose(); };
    document.addEventListener("click", popOutside, true);
  }

  function deleteComment(id) {
    const s = findCommentSession(id);
    if (s) { s.comments = s.comments.filter((c) => c.id !== id); s.updatedAt = Date.now(); }
    saveSession(); updateCounts(); renderPins(); renderPanel();
    if (devState.open) renderDevPins();
  }

  // -------------------------------------------------------------- pins ----
  const pinEls = new Map(); // id -> el
  function renderPins() {
    const route = routeOf();
    // Breakpoint-scoped comments live in the device frame WHILE it's open; when
    // it's closed, still surface them as normal page pins so an agent's
    // breakpoint comments are never invisible (they'd otherwise only show at an
    // exact device-frame width match).
    const want = commentsForRoute(route).filter((c) => devState.open ? !c.breakpoint : true);
    const wantIds = new Set(want.map((c) => c.id));
    for (const [id, el] of [...pinEls]) if (!wantIds.has(id)) { try { el.remove(); } catch {} pinEls.delete(id); }
    for (const c of want) {
      let el = pinEls.get(c.id);
      if (!el) {
        el = document.createElement("div"); el.dataset.id = c.id;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const cur = findCommentById(el.dataset.id) || c;
          let node = null; try { node = document.querySelector(cur.selector); } catch {}
          if (node) openPop(node, topPickTarget(), cur);
          else toast("Element not found on this page");
        });
        layer.appendChild(el); pinEls.set(c.id, el);
      }
      el.className = "pin" + (c.severity ? " sev-" + c.severity : "") + (c.resolved ? " done" : "") + (c.breakpoint ? " bp" : "");
      el.textContent = c.resolved ? "✓" : c.n;
      el.title = (c.severity ? "[" + c.severity + "] " : "") + (c.breakpoint && c.breakpoint.label ? "@" + c.breakpoint.label + " " : "") + c.text;
    }
    positionPins();
  }
  function positionPins() {
    const route = routeOf();
    for (const c of commentsForRoute(route)) {
      const el = pinEls.get(c.id); if (!el) continue;
      let node = null; try { node = document.querySelector(c.selector); } catch {}
      if (node) {
        const r = node.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { el.classList.add("detached"); el.style.left = "16px"; el.style.top = `${16 + c.n * 28}px`; continue; }
        el.classList.remove("detached");
        el.style.left = `${r.left + Math.min(r.width, 14)}px`;
        el.style.top = `${r.top + 2}px`;
      } else { el.classList.add("detached"); el.style.left = "16px"; el.style.top = `${56 + c.n * 28}px`; }
    }
  }
  function scheduleReposition() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionPins(); if (devState.open) { layoutDeviceFrame(); positionDevPins(); } });
  }
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition, true);

  function flashPin(c) {
    const el = pinEls.get(c.id);
    if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  }
  function findCommentById(id) { const s = findCommentSession(id); return s ? s.comments.find((c) => c.id === id) : null; }
  // Scroll to a comment's element on the CURRENT page. Returns false if absent.
  function scrollToComment(c) {
    // Only scroll in place when the comment belongs to THIS page — otherwise a
    // selector that also happens to exist here would steal the click and skip
    // navigation to the comment's real page.
    if (c.origin !== originOf() || c.route !== routeOf()) return false;
    let node = null; try { node = document.querySelector(c.selector); } catch {}
    if (!node) return false;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => { positionPins(); flashPin(c); }, 380);
    return true;
  }
  // Click a comment in the navigator → locate it: scroll here if present, else
  // navigate to its page/route and scroll after load.
  function navigateToComment(c) {
    if (scrollToComment(c)) return;
    store.pending = { commentId: c.id, ts: Date.now() };
    if (c.sessionId && store.sessions[c.sessionId]) store.activeByOrigin[c.origin] = c.sessionId;
    try {
      lastWriteJson = JSON.stringify(store);
      chrome.storage.local.set({ [DKEY]: store }, () => { location.href = c.url; });
    } catch { location.href = c.url; }
  }
  // After a navigation, poll briefly for the pending element and scroll to it.
  let pendingTimer = null;
  function clearPending() { store.pending = null; saveStore(); if (pendingTimer) { cancelAnimationFrame(pendingTimer); pendingTimer = null; } }
  function maybeRunPending() {
    const p = store.pending; if (!p) return;
    const c = findCommentById(p.commentId);
    // Wait until we're on the comment's exact page (origin + route); a route
    // change will call this again. Don't clear until then.
    if (!c || c.origin !== originOf() || c.route !== routeOf()) return;
    let tries = 0;
    if (pendingTimer) cancelAnimationFrame(pendingTimer);
    const tick = () => {
      let node = null; try { node = document.querySelector(c.selector); } catch {}
      if (node) { clearPending(); node.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => { positionPins(); flashPin(c); }, 420); return; }
      if (++tries > 150) { clearPending(); return; }   // ~2.5s @ 60fps
      pendingTimer = requestAnimationFrame(tick);
    };
    pendingTimer = requestAnimationFrame(tick);
  }

  // ------------------------------------------------- navigator (floating) ----
  let panelEl = null, panelView = "sessions", panelFilter = "site", viewSessionId = null;
  const ICO = {
    back: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
    x: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
    plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    pencil: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  };
  function shortOrigin(o) { return String(o || "").replace(/^https?:\/\//, ""); }
  function openPanel() { if (!panelEl) buildPanel(); panelView = "sessions"; renderPanel(); requestAnimationFrame(() => panelEl.classList.add("open")); }
  function closePanel() { panelEl && panelEl.classList.remove("open"); }
  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.className = "nav";
    panelEl.innerHTML = `
      <div class="nav-hd">
        <button class="ico" data-x="back" title="Back" style="display:none">${ICO.back}</button>
        <div class="nav-title">Sessions</div>
        <button class="ico" data-x="close" title="Close">${ICO.x}</button>
      </div>
      <div class="nav-tools"></div>
      <div class="nav-body"></div>
      <div class="nav-ft"></div>`;
    layer.appendChild(panelEl);
    makeDraggable(panelEl, panelEl.querySelector(".nav-hd"));
    panelEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-x]"); if (!b) return;
      const x = b.dataset.x;
      if (x === "close") closePanel();
      else if (x === "back") { panelView = "sessions"; renderPanel(); }
      else if (x === "filter-site") { panelFilter = "site"; renderPanel(); }
      else if (x === "filter-all") { panelFilter = "all"; renderPanel(); }
      else if (x === "new") { const s = newSession(); viewSessionId = s.id; panelView = "comments"; updateCounts(); renderPins(); renderPanel(); toast("New session started"); }
      else if (x === "copy") copyBrief(panelView === "comments" && viewSessionId ? store.sessions[viewSessionId] : undefined);
    });
  }
  function renderPanel() {
    if (!panelEl) return;
    const back = panelEl.querySelector('[data-x="back"]');
    const title = panelEl.querySelector(".nav-title");
    const tools = panelEl.querySelector(".nav-tools");
    const body = panelEl.querySelector(".nav-body");
    const ft = panelEl.querySelector(".nav-ft");
    if (panelView === "comments" && viewSessionId && store.sessions[viewSessionId]) {
      back.style.display = "";
      renderCommentsView(store.sessions[viewSessionId], title, tools, body, ft);
    } else {
      panelView = "sessions"; back.style.display = "none";
      renderSessionsView(title, tools, body, ft);
    }
  }
  function renderSessionsView(title, tools, body, ft) {
    title.textContent = "Sessions";
    ft.innerHTML = "";
    tools.innerHTML = `
      <div class="chips">
        <button class="chip ${panelFilter === "site" ? "on" : ""}" data-x="filter-site">This site</button>
        <button class="chip ${panelFilter === "all" ? "on" : ""}" data-x="filter-all">All sites</button>
      </div>
      <button class="ico add" data-x="new" title="New session">${ICO.plus}</button>`;
    const list = panelFilter === "all" ? allSessions() : sessionsForOrigin(originOf());
    const activeId = activeSessionId();
    if (!list.length) { body.innerHTML = `<div class="empty">No sessions${panelFilter === "site" ? " on this site" : ""} yet.<br/>Comment on the page, or tap ＋ to start one.</div>`; return; }
    body.innerHTML = "";
    for (const s of list) {
      const isActive = s.id === activeId && s.origin === originOf();
      const row = document.createElement("div");
      row.className = "srow" + (isActive ? " active" : "");
      row.innerHTML = `
        <div class="si">
          <div class="sname">${escapeHtml(s.name)}${isActive ? '<span class="badge">active</span>' : ""}</div>
          <div class="smeta">${escapeHtml(shortOrigin(s.origin))} · ${s.comments.length} comment${s.comments.length === 1 ? "" : "s"}</div>
        </div>
        <button class="ico mini" data-act="rename" title="Rename">${ICO.pencil}</button>
        <button class="ico mini danger" data-act="del" title="Delete">${ICO.trash}</button>`;
      row.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]");
        if (act) {
          e.stopPropagation();
          if (act.dataset.act === "rename") startRename(row, s);
          else if (act.dataset.act === "del") armDelete(row, s);
          return;
        }
        // Open the session's comments. On the current site, also make it active
        // so new comments + pins follow the session you're looking at.
        viewSessionId = s.id; panelView = "comments";
        if (s.origin === originOf()) { switchSession(s.id); updateCounts(); renderPins(); if (devState.open) renderDevPins(); }
        renderPanel();
      });
      body.appendChild(row);
    }
  }
  // Inline rename (stays in the closed shadow — host page can't suppress it).
  function startRename(row, s) {
    const nameEl = row.querySelector(".sname");
    if (!nameEl || nameEl.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "rename-input"; input.value = s.name;
    nameEl.innerHTML = ""; nameEl.appendChild(input);
    input.focus(); input.select();
    let done = false;
    const commit = (save) => { if (done) return; done = true; if (save) renameSession(s.id, input.value); renderPanel(); };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
  }
  // Two-tap delete confirm (in-shadow; no native confirm()).
  let delArmedId = null, delArmTimer = null;
  function armDelete(row, s) {
    if (delArmedId === s.id) {
      delArmedId = null; if (delArmTimer) { clearTimeout(delArmTimer); delArmTimer = null; }
      deleteSession(s.id); updateCounts(); renderPins(); if (devState.open) renderDevPins(); renderPanel();
      toast("Session deleted");
      return;
    }
    delArmedId = s.id;
    const btn = row.querySelector('[data-act="del"]');
    if (btn) btn.classList.add("armed");
    toast(`Delete "${s.name}"? Tap the trash again to confirm`);
    if (delArmTimer) clearTimeout(delArmTimer);
    delArmTimer = setTimeout(() => { delArmedId = null; const b = row.querySelector('[data-act="del"]'); if (b) b.classList.remove("armed"); }, 2600);
  }
  function renderCommentsView(s, title, tools, body, ft) {
    title.textContent = s.name;
    const isActive = activeSessionId() === s.id && s.origin === originOf();
    tools.innerHTML = `
      <div class="cmeta">${escapeHtml(shortOrigin(s.origin))} · ${s.comments.length} comment${s.comments.length === 1 ? "" : "s"}</div>
      ${isActive ? '<span class="chip on">active</span>' : (s.origin === originOf() ? '<span class="chip" style="opacity:.6">other session</span>' : '<span class="chip" style="opacity:.6">other site</span>')}`;
    ft.innerHTML = s.comments.length ? `<button class="navbtn" data-x="copy">${ICO.copy}<span>Copy brief</span></button>` : "";
    if (!s.comments.length) { body.innerHTML = `<div class="empty">No comments in this session yet.</div>`; return; }
    const groups = {};
    for (const c of [...s.comments].sort((a, b) => a.n - b.n)) (groups[c.route] = groups[c.route] || []).push(c);
    body.innerHTML = "";
    for (const route of Object.keys(groups)) {
      const h = document.createElement("div"); h.className = "grp-h"; h.textContent = route; body.appendChild(h);
      for (const c of groups[route]) {
        const row = document.createElement("div"); row.className = "row" + (c.resolved ? " resolved" : "");
        row.innerHTML = `<span class="n${c.severity ? " sev-" + c.severity : ""}">${c.resolved ? "✓" : c.n}</span>
          <div class="c"><div class="tx">${escapeHtml(c.text)}</div>
            <div class="meta">${c.severity ? `<span class="sev sev-${c.severity}">${c.severity}</span>` : ""}<span>${escapeHtml(c.tagName)}</span>${c.breakpoint && c.breakpoint.label ? `<span class="bp">${escapeHtml(c.breakpoint.label)}</span>` : ""}<span>${escapeHtml((c.elementText || "").slice(0, 40))}</span></div></div>
          <button class="del" data-del title="Delete">✕</button>`;
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-del]")) { deleteComment(c.id); renderPanel(); return; }
          closePanel(); navigateToComment(c);
        });
        body.appendChild(row);
      }
    }
  }
  // Drag the navigator by its header (ignore clicks on controls).
  function makeDraggable(el, handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button,[data-x],[data-act],input")) return;
      const r = el.getBoundingClientRect();
      const ox = r.left, oy = r.top, sx = e.clientX, sy = e.clientY;
      el.style.right = "auto"; el.style.bottom = "auto"; el.style.left = ox + "px"; el.style.top = oy + "px";
      e.preventDefault();
      const mm = (ev) => { el.style.left = Math.max(6, Math.min(window.innerWidth - 80, ox + ev.clientX - sx)) + "px"; el.style.top = Math.max(6, Math.min(window.innerHeight - 60, oy + ev.clientY - sy)) + "px"; };
      const mu = () => { document.removeEventListener("mousemove", mm, true); document.removeEventListener("mouseup", mu, true); };
      document.addEventListener("mousemove", mm, true);
      document.addEventListener("mouseup", mu, true);
    });
  }

  // --------------------------------------------------- responsive frame ----
  const DEVICES = [
    { label: "iPhone SE", width: 375, height: 667 },
    { label: "iPhone", width: 390, height: 844 },
    { label: "iPad", width: 768, height: 1024 },
    { label: "Laptop", width: 1024, height: 720 },
    { label: "Desktop", width: 1280, height: 800 },
    { label: "Wide", width: 1440, height: 900 },
  ];
  // idx into DEVICES, or "custom" with cw/ch. scale = visual fit factor (≤1).
  const devState = { open: false, idx: 1, custom: false, cw: 1440, ch: 900, scale: 1, el: null, iframe: null, inner: null, overlay: null };
  function currentDevice() {
    return devState.custom
      ? { label: "Custom", width: Math.max(200, devState.cw | 0), height: Math.max(200, devState.ch | 0) }
      : DEVICES[devState.idx];
  }

  function openDevice() {
    if (devState.open) return;
    devState.open = true;
    const d = document.createElement("div");
    d.className = "dev";
    d.innerHTML = `
      <div class="dtop">
        <div class="seg">${DEVICES.map((dv, i) => `<button data-dev="${i}">${escapeHtml(dv.label)}</button>`).join("")}<button data-dev="custom">Custom</button></div>
        <span class="dcustom"><input class="dnum" id="d-cw" type="number" min="200" step="10" /> × <input class="dnum" id="d-ch" type="number" min="200" step="10" /></span>
        <span class="dwid"></span>
        <span class="grow"></span>
        <button class="mbtn" data-x="pick" style="pointer-events:auto;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>Comment here</button>
        <button class="mbtn" data-x="close" style="pointer-events:auto;">Done</button>
      </div>
      <div class="dstage">
        <div class="framewrap"><div class="frameinner"><iframe title="Mochi responsive preview" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe></div><div class="doverlay"></div></div>
      </div>`;
    layer.appendChild(d);
    devState.el = d;
    devState.iframe = d.querySelector("iframe");
    devState.inner = d.querySelector(".frameinner");
    devState.overlay = d.querySelector(".doverlay");
    const cwEl = d.querySelector("#d-cw"), chEl = d.querySelector("#d-ch");
    const onCustomInput = () => {
      devState.cw = Math.max(200, parseInt(cwEl.value, 10) || 0);
      devState.ch = Math.max(200, parseInt(chEl.value, 10) || 0);
      applyDevice();
    };
    cwEl.addEventListener("input", onCustomInput);
    chEl.addEventListener("input", onCustomInput);
    // Don't let typing in the inputs bubble to the dev-frame click/scroll logic.
    [cwEl, chEl].forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));
    d.addEventListener("click", (e) => {
      const seg = e.target.closest("[data-dev]");
      if (seg) {
        if (seg.dataset.dev === "custom") {
          devState.custom = true;
          const cur = DEVICES[devState.idx];
          if (!devState.cw) devState.cw = cur.width;
          if (!devState.ch) devState.ch = cur.height;
        } else { devState.custom = false; devState.idx = +seg.dataset.dev; }
        applyDevice();
        return;
      }
      const x = e.target.closest("[data-x]"); if (!x) return;
      if (x.dataset.x === "close") closeDevice();
      else if (x.dataset.x === "pick") { if (pickMode) stopPick(); else startDevPick(); updateDevPickBtn(); }
    });
    devState.iframe.addEventListener("load", () => {
      try {
        // touch contentDocument to verify same-origin access
        void devState.iframe.contentDocument.body;
        devState.iframe.contentWindow.addEventListener("scroll", scheduleReposition, true);
        renderDevPins();
        startDevPick();          // auto-arm so you can comment immediately
        updateDevPickBtn();
      } catch {
        showDevNote("This page can't be annotated inside the responsive frame (it blocks embedding). The preview still reflows — comments here aren't available for this site.");
      }
    });
    applyDevice();
  }
  function updateDevPickBtn() {
    if (!devState.el) return;
    const b = devState.el.querySelector('[data-x="pick"]');
    if (!b) return;
    b.classList.toggle("on", pickMode);
    b.lastChild && (b.lastChild.textContent = pickMode ? " Commenting — click elements" : " Comment here");
  }
  function applyDevice() {
    const dv = currentDevice();
    // segmented + custom active states
    devState.el.querySelectorAll("[data-dev]").forEach((b) => {
      const on = b.dataset.dev === "custom" ? devState.custom : (!devState.custom && +b.dataset.dev === devState.idx);
      b.classList.toggle("on", on);
    });
    const customRow = devState.el.querySelector(".dcustom");
    customRow.classList.toggle("on", devState.custom);
    if (devState.custom) {
      const cwEl = devState.el.querySelector("#d-cw"), chEl = devState.el.querySelector("#d-ch");
      if (document.activeElement !== cwEl) cwEl.value = dv.width;
      if (document.activeElement !== chEl) chEl.value = dv.height;
    }
    layoutDeviceFrame();
    if (devState.iframe.src !== location.href) devState.iframe.src = location.href;
    else { renderDevPins(); if (pickMode) { startDevPick(); updateDevPickBtn(); } }
  }
  // Render the iframe at the TRUE device size (so media queries are accurate),
  // then visually scale the whole frame to fit the window — handles a custom
  // size larger than the viewport gracefully. Safe to call on every resize.
  function layoutDeviceFrame() {
    if (!devState.open || !devState.inner) return;
    const dv = currentDevice();
    const stage = devState.el.querySelector(".dstage");
    const availW = Math.max(120, stage.clientWidth - 32);
    const availH = Math.max(120, stage.clientHeight - 32);
    const scale = Math.min(1, availW / dv.width, availH / dv.height);
    devState.scale = scale;
    devState.inner.style.width = dv.width + "px";
    devState.inner.style.height = dv.height + "px";
    devState.inner.style.transform = `scale(${scale})`;
    const fw = devState.el.querySelector(".framewrap");
    fw.style.width = Math.round(dv.width * scale) + "px";
    fw.style.height = Math.round(dv.height * scale) + "px";
    devState.el.querySelector(".dwid").textContent =
      `${dv.width} × ${dv.height}${scale < 0.999 ? ` · ${Math.round(scale * 100)}%` : ""}`;
  }
  function showDevNote(msg) {
    const stage = devState.el.querySelector(".dstage");
    stage.innerHTML = `<div class="dnote">${escapeHtml(msg)}</div>`;
  }
  function closeDevice() {
    if (!devState.open) return;
    stopPick();
    try { devState.el.remove(); } catch {}
    devState.open = false; devState.el = devState.iframe = devState.inner = devState.overlay = null;
  }
  function devTarget() {
    const ifr = devState.iframe;
    const dv = currentDevice();
    return {
      doc: ifr.contentDocument, win: ifr.contentWindow,
      offset: () => { const r = ifr.getBoundingClientRect(); return { x: r.left, y: r.top }; },
      scale: () => devState.scale,
      breakpoint: { label: dv.label, width: dv.width },
    };
  }
  function startDevPick() {
    let ok = false; try { ok = !!devState.iframe.contentDocument.body; } catch {}
    if (!ok) { toast("Can't annotate inside this frame"); return; }
    startPick(devTarget());
  }
  function renderDevPins() {
    if (!devState.open || !devState.overlay) return;
    devState.overlay.innerHTML = "";
    positionDevPins();
  }
  function positionDevPins() {
    if (!devState.open || !devState.overlay) return;
    let doc = null; try { doc = devState.iframe.contentDocument; } catch {}
    if (!doc) return;
    const ifr = devState.iframe;
    const ir = ifr.getBoundingClientRect();
    const fr = devState.overlay.getBoundingClientRect();
    const s = devState.scale || 1;
    const dv = currentDevice();
    // Tolerance, not exact equality: the agent's emulate widths (e.g. 393, 412,
    // 820) rarely match the human's chosen frame width exactly, so a ±60px band
    // keeps near-width breakpoint pins visible in the frame.
    const want = currentComments().filter((c) => c.route === routeOf() && c.breakpoint && Math.abs((c.breakpoint.width || 0) - dv.width) <= 60);
    const existing = new Map([...devState.overlay.children].map((el) => [el.dataset.id, el]));
    for (const c of want) {
      let node = null; try { node = doc.querySelector(c.selector); } catch {}
      let el = existing.get(c.id);
      if (!el) {
        el = document.createElement("div"); el.dataset.id = c.id; el.style.pointerEvents = "auto";
        // Re-resolve the node at click time (the one captured at creation may be
        // null if async content hadn't rendered yet).
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          let n = null; try { n = devState.iframe.contentDocument.querySelector(c.selector); } catch {}
          if (n) openPop(n, devTarget(), c); else toast("Element not found in frame");
        });
        devState.overlay.appendChild(el);
      }
      el.className = "pin" + (c.severity ? " sev-" + c.severity : "") + (c.resolved ? " done" : "");
      el.textContent = c.resolved ? "✓" : c.n;
      el.title = c.text;
      if (node) {
        const r = node.getBoundingClientRect();
        // overlay sits over the (scaled) iframe; element rects are in device px,
        // so multiply by the visual scale to map into overlay coordinates.
        el.style.left = `${(ir.left - fr.left) + r.left * s + Math.min(r.width * s, 14)}px`;
        el.style.top = `${(ir.top - fr.top) + r.top * s + 2}px`;
        el.style.display = (r.bottom < 0 || r.top > ifr.clientHeight) ? "none" : "flex";
      } else { el.style.display = "none"; }
    }
  }

  // --------------------------------------------------------- scroll-teach ----
  function maybeTeachScroll() {
    if (store.taughtScroll) return;
    store.taughtScroll = true; saveSession();
    const t = document.createElement("div");
    t.className = "teach";
    t.innerHTML = `<div class="mouse"></div><div>Scroll freely — you can comment anywhere on the page.</div>`;
    layer.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => { try { t.remove(); } catch {} }, 500); }, 4200);
  }

  // -------------------------------------------------------------- export ----
  function buildBrief(sess) {
    const s = sess || activeSession(false);
    const cs = (s ? [...s.comments] : []).sort((a, b) => a.n - b.n);
    const origin = s ? s.origin : originOf();
    const lines = [];
    lines.push(`# Mochi review — ${s ? s.name + " — " : ""}${origin} — ${cs.length} comment${cs.length === 1 ? "" : "s"}`);
    lines.push(`Generated ${new Date().toISOString()}. Each item has a CSS selector + route so you can locate the exact element. Fix each comment.`);
    lines.push("");
    for (const c of cs) {
      const bp = (c.breakpoint && c.breakpoint.label) ? ` · [${c.breakpoint.label} ${c.breakpoint.width}px]` : "";
      lines.push(`## ${c.n} · ${c.route}${bp}`);
      lines.push(`- selector: \`${c.selector}\``);
      lines.push(`- element: <${c.tagName}>${c.elementText ? ` "${c.elementText}"` : ""}${c.role ? ` (role=${c.role})` : ""}`);
      lines.push(`- box: ${c.box.x},${c.box.y} ${c.box.w}×${c.box.h} @ ${c.viewport.w}×${c.viewport.h}`);
      lines.push(`- comment: ${c.text}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  async function copyBrief(sess) {
    const s = sess || activeSession(false);
    const count = s ? s.comments.length : 0;
    if (!count) { toast("No comments to copy yet"); return; }
    const text = buildBrief(s);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove();
      } catch {}
    }
    toast(ok ? `Copied ${count} comment${count === 1 ? "" : "s"} — paste into your coding agent` : "Copy failed — clipboard blocked");
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ------------------------------------------------------------- lifecycle ----
  // SPA route detection: history is patched + popstate/hashchange listened so
  // pins re-render when a client-side router changes the URL (no full reload).
  let lastRoute = routeOf();
  let histPatched = false, origPush = null, origReplace = null;
  function handleRouteChange() {
    const r = routeOf();
    if (r === lastRoute) return;
    lastRoute = r;
    closePop();
    renderPins();
    if (devState.open) renderDevPins();
    if (panelEl) renderPanel();
    maybeRunPending();
  }
  function onPopState() { handleRouteChange(); }
  function patchHistory() {
    if (histPatched) return; histPatched = true;
    try {
      origPush = history.pushState; origReplace = history.replaceState;
      history.pushState = function (...a) { const r = origPush.apply(this, a); try { handleRouteChange(); } catch {} return r; };
      history.replaceState = function (...a) { const r = origReplace.apply(this, a); try { handleRouteChange(); } catch {} return r; };
    } catch {}
    window.addEventListener("popstate", onPopState, true);
    window.addEventListener("hashchange", onPopState, true);
  }
  function unpatchHistory() {
    if (!histPatched) return; histPatched = false;
    try { if (origPush) history.pushState = origPush; if (origReplace) history.replaceState = origReplace; } catch {}
    window.removeEventListener("popstate", onPopState, true);
    window.removeEventListener("hashchange", onPopState, true);
  }

  // Background tells us to tear down (popup/keyboard "Stop").
  function onRuntimeMessage(req) { if (req && req.type === "comment_teardown") teardown(); }
  // Cross-tab sync: adopt another context's writes (sessions data + on/off).
  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes[SKEY] && changes[SKEY].newValue && changes[SKEY].newValue.active === false) { teardown(); return; }
    if (!changes[DKEY]) return;
    const nv = changes[DKEY].newValue;
    if (!nv) return;
    if (JSON.stringify(nv) === lastWriteJson) return;   // our own write — ignore
    // UNION the incoming write into our in-memory store instead of discarding or
    // wholesale-replacing it. The background bridge and the human's content
    // script are independent writers of `mochiComments`; whole-document
    // last-write-wins silently dropped one side's comments. If our local store
    // held anything the incoming write lacks (e.g. a comment we added/edited
    // that the bridge's snapshot predated, or one the bridge clobbered), push
    // the union back so it isn't lost. Deterministic canonStore() comparison
    // means a converged union re-saves nothing (no cross-tab ping-pong).
    if (Merge) {
      const merged = Merge.mergeStores(store, nv);
      store = merged;
      if (Merge.canonStore(merged) !== Merge.canonStore(nv)) saveStore();
    } else {
      if (saveTimer) { flushStore(); return; }
      applyStore(nv);
    }
    updateCounts(); renderPins(); if (devState.open) renderDevPins(); if (panelEl) renderPanel();
  }

  // End only THIS tab. Background flips the global active flag when the last
  // commenting tab unregisters, so other tabs keep their overlay.
  async function endSession() {
    try { chrome.runtime.sendMessage({ type: "comment_unregister_tab" }); } catch {}
    teardown();
  }
  function teardown() {
    try { stopPick(); } catch {} try { closeDevice(); } catch {}
    window.removeEventListener("scroll", scheduleReposition, true);
    window.removeEventListener("resize", scheduleReposition, true);
    try { document.removeEventListener("click", onDocClickCloseSessMenu, true); } catch {}
    try { root.removeEventListener("click", onShadowClickCloseSessMenu, true); } catch {}
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
    unpatchHistory();
    try { window.__mochiCommentResync = null; } catch {}
    try { host.remove(); } catch {}
  }

  // Resync hook for the re-injection guard (host already present).
  window.__mochiCommentResync = () => {
    loadSession().then(() => {
      if (!modeActive) { teardown(); return; }
      lastRoute = routeOf();
      updateCounts(); renderPins(); if (devState.open) renderDevPins();
      maybeRunPending();
    });
  };

  // ------------------------------------------------------------- bootstrap ----
  (async () => {
    await loadSession();
    if (!modeActive) { teardown(); return; }
    try { chrome.runtime.sendMessage({ type: "comment_register_tab" }); } catch {}
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch {}
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch {}
    lastRoute = routeOf();
    patchHistory();
    updateCounts();
    renderPins();
    maybeRunPending();
    maybeTeachScroll();
    // Safety net: covers async layout shifts AND client-side route changes that
    // slipped past the history patch.
    let tick = 0;
    const loop = () => {
      if (!document.getElementById(HOST_ID)) return;
      if (++tick % 20 === 0) { handleRouteChange(); positionPins(); if (devState.open) positionDevPins(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })();
})();

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
  let session = { active: true, startedAt: Date.now(), taughtScroll: false, comments: [] };
  // Sticky pick mode: once armed it stays on so you can drop many comments
  // without re-arming. `listening` = hover/click handlers currently attached
  // (paused while a comment popover is open).
  let pickMode = false, pickTarget = null, listening = false;
  let rafPending = false;
  let saveTimer = null;

  const routeOf = (loc = location) => (loc.pathname || "/") + (loc.search || "");
  const originOf = (loc = location) => loc.origin;

  let lastWriteJson = null;
  function applySession(s) {
    if (s && typeof s === "object") {
      session = {
        active: s.active !== false,
        startedAt: s.startedAt || Date.now(),
        taughtScroll: !!s.taughtScroll,
        comments: Array.isArray(s.comments) ? s.comments : [],
      };
    }
  }
  function loadSession() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([SKEY], (o) => { applySession(o && o[SKEY]); resolve(session); });
      } catch { resolve(session); }
    });
  }
  function serializeSession() {
    return { active: session.active, startedAt: session.startedAt, taughtScroll: session.taughtScroll, comments: session.comments };
  }
  function saveSession() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const out = serializeSession();
        lastWriteJson = JSON.stringify(out);
        chrome.storage.local.set({ [SKEY]: out });
      } catch {}
    }, 120);
  }
  // Numbering is per-site so each site's comments start at #1.
  function maxN() { return currentComments().reduce((m, c) => Math.max(m, c.n || 0), 0); }
  // All comments belong to the current SITE (origin). Pins/list/count/export are
  // scoped to this so a session on another site never shows/copies another
  // site's comments. (Storage keeps every site's comments, isolated by origin.)
  function currentComments() { return session.comments.filter((c) => c.origin === originOf()); }
  function commentsForRoute(route) {
    return currentComments().filter((c) => c.route === route);
  }

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
      .menu-toggle { pointer-events:auto; width:36px; height:36px; border-radius:50%; background:var(--bg); color:var(--mut);
        border:1px solid var(--bd); box-shadow:var(--sh); cursor:pointer; display:flex; align-items:center; justify-content:center;
        align-self:center; transition:background 100ms, transform 80ms; }
      .menu-toggle:hover { background:var(--bg2); color:var(--tx); }
      .menu-toggle:active { transform:scale(.94); }
      .menu-toggle.on { background:var(--tx); color:var(--bg); }
      .menu { display:flex; flex-direction:column; gap:8px; align-items:flex-end; }
      .menu.hidden { display:none; }
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
      .panel { position:fixed; top:0; right:0; width:min(380px,92vw); height:100%; background:var(--bg); color:var(--tx);
        box-shadow:-8px 0 32px -8px rgba(0,0,0,.35); z-index:8; pointer-events:auto; transform:translateX(100%);
        transition:transform 280ms cubic-bezier(.16,1,.3,1); display:flex; flex-direction:column; border-left:1px solid var(--bd); }
      .panel.open { transform:translateX(0); }
      .panel .hd { display:flex; align-items:center; justify-content:space-between; padding:16px 16px 12px; border-bottom:1px solid var(--bd); }
      .panel .hd .t { font-size:15px; font-weight:700; letter-spacing:-.01em; }
      .panel .hd .s { font-size:11.5px; color:var(--mut); margin-top:2px; }
      .panel .body { flex:1; overflow-y:auto; padding:8px 0; }
      .grp-h { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); padding:12px 16px 6px; }
      .row { display:flex; gap:10px; padding:10px 16px; cursor:pointer; align-items:flex-start; transition:background 100ms; }
      .row:hover { background:var(--bg2); }
      .row .n { width:22px; height:22px; flex-shrink:0; border-radius:50%; background:var(--pin); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
      .row .c { flex:1; min-width:0; }
      .row .c .tx { font-size:13px; line-height:1.4; color:var(--tx); }
      .row .c .meta { font-size:11px; color:var(--soft); margin-top:3px; display:flex; gap:6px; flex-wrap:wrap; }
      .row .c .bp { background:var(--bg2); border-radius:8px; padding:0 6px; }
      .row .del { opacity:0; appearance:none; border:none; background:transparent; color:var(--dng); cursor:pointer; padding:2px; align-self:center; }
      .row:hover .del { opacity:.8; }
      .empty { text-align:center; color:var(--soft); font-size:12.5px; padding:40px 24px; line-height:1.6; }
      .panel .ft { padding:12px 16px; border-top:1px solid var(--bd); display:flex; gap:8px; }
      .panel .ft .btn { flex:1; justify-content:center; }

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
      .dev iframe { border:none; display:block; background:#fff; }
      .dev .dnote { color:#fff; opacity:.85; font-size:12.5px; max-width:420px; text-align:center; line-height:1.6; background:rgba(0,0,0,.3); padding:14px 18px; border-radius:12px; }
      .dev .doverlay { position:absolute; inset:0; pointer-events:none; }

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
  const fabWrap = document.createElement("div");
  fabWrap.className = "fab-wrap";
  fabWrap.innerHTML = `
    <div class="menu hidden">
      <button class="mbtn" data-act="list"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Comments <span class="pill" data-count>0</span></button>
      <button class="mbtn" data-act="responsive"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="12" rx="1"/><rect x="17" y="7" width="5" height="13" rx="1"/></svg>Responsive</button>
      <button class="mbtn" data-act="copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy brief</button>
      <button class="mbtn danger" data-act="end"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>End session</button>
    </div>
    <button class="menu-toggle" title="Menu — comments, responsive, copy">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
    </button>
    <button class="fab" title="Mochi comment — click to add a comment">
      <svg class="ico-comment" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="count" data-count>0</span>
    </button>`;
  layer.appendChild(fabWrap);
  const fab = fabWrap.querySelector(".fab");
  const menu = fabWrap.querySelector(".menu");
  const menuToggle = fabWrap.querySelector(".menu-toggle");

  function updateCounts() {
    const n = currentComments().length;   // count for THIS site only
    root.querySelectorAll("[data-count]").forEach((e) => { e.textContent = String(n); e.style.display = n ? "" : "none"; });
  }

  let menuOpen = false;
  function toggleMenu(force) {
    menuOpen = force == null ? !menuOpen : force;
    menu.classList.toggle("hidden", !menuOpen);
    menuToggle.classList.toggle("on", menuOpen);
  }

  fab.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(false);
    if (pickMode) { stopPick(); return; }   // armed → click finishes
    startPick(topPickTarget());             // one click → start commenting (stays on)
  });
  menuToggle.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  // Click anywhere outside the FAB closes the menu. (Named so teardown can detach it.)
  function onDocClickCloseMenu(e) {
    if (!menuOpen) return;
    if (e.target === host || host.contains(e.target)) return;
    toggleMenu(false);
  }
  document.addEventListener("click", onDocClickCloseMenu, true);

  menu.addEventListener("click", (e) => {
    const b = e.target.closest(".mbtn"); if (!b) return;
    const act = b.dataset.act;
    toggleMenu(false);
    if (act === "list") openPanel();
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
    toggleMenu(false);
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
    const r = el.getBoundingClientRect();
    hlEl.style.opacity = "1";
    hlEl.style.left = `${off.x + r.left}px`;
    hlEl.style.top = `${off.y + r.top}px`;
    hlEl.style.width = `${r.width}px`;
    hlEl.style.height = `${r.height}px`;
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
    // position near element, clamped to viewport
    const pw = 300, ph = 180;
    let left = off.x + r.left, top = off.y + r.bottom + 8;
    if (top + ph > window.innerHeight) top = Math.max(8, off.y + r.top - ph - 8);
    left = Math.min(Math.max(8, left), window.innerWidth - pw - 8);
    popEl.style.left = `${left}px`; popEl.style.top = `${top}px`;
    const ta = popEl.querySelector("textarea");
    if (existing) ta.value = existing.text || "";
    ta.focus();

    function finishClose() { closePop(); resumePickIfActive(); }
    function doSave() {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (existing) { existing.text = text; }
      else {
        session.comments.push({
          id: "c" + Date.now() + Math.floor(Math.random() * 1e4),
          n, text,
          url: location.href, route: routeOf(), origin: originOf(),
          selector: sel, tagName: el.tagName.toLowerCase(), role: roleOf(el), elementText: describe(el),
          box: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
          viewport: { w: target.win.innerWidth, h: target.win.innerHeight, dpr: target.win.devicePixelRatio || 1 },
          breakpoint: target.breakpoint || null,
          createdAt: Date.now(),
        });
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
    session.comments = session.comments.filter((c) => c.id !== id);
    saveSession(); updateCounts(); renderPins(); renderPanel();
    if (devState.open) renderDevPins();
  }

  // -------------------------------------------------------------- pins ----
  const pinEls = new Map(); // id -> el
  function renderPins() {
    const route = routeOf();
    const want = commentsForRoute(route).filter((c) => !c.breakpoint);
    const wantIds = new Set(want.map((c) => c.id));
    for (const [id, el] of [...pinEls]) if (!wantIds.has(id)) { try { el.remove(); } catch {} pinEls.delete(id); }
    for (const c of want) {
      let el = pinEls.get(c.id);
      if (!el) {
        el = document.createElement("div"); el.className = "pin"; el.textContent = c.n;
        el.title = c.text;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          let node = null; try { node = document.querySelector(c.selector); } catch {}
          if (node) openPop(node, topPickTarget(), c);
          else toast("Element not found on this page");
        });
        layer.appendChild(el); pinEls.set(c.id, el);
      }
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
    requestAnimationFrame(() => { rafPending = false; positionPins(); if (devState.open) positionDevPins(); });
  }
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition, true);

  function flashComment(c) {
    if (c.route !== routeOf()) { toast(`That comment is on ${c.route}`); return; }
    let node = null; try { node = document.querySelector(c.selector); } catch {}
    if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      positionPins();
      const el = pinEls.get(c.id);
      if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    }, 360);
  }

  // ------------------------------------------------------------- panel ----
  let panelEl = null;
  function openPanel() { if (!panelEl) buildPanel(); renderPanel(); requestAnimationFrame(() => panelEl.classList.add("open")); }
  function closePanel() { panelEl && panelEl.classList.remove("open"); }
  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.className = "panel";
    panelEl.innerHTML = `
      <div class="hd"><div><div class="t">Comments</div><div class="s"></div></div>
        <button class="btn" data-x="close">Close</button></div>
      <div class="body"></div>
      <div class="ft"><button class="btn primary" data-x="copy">Copy brief</button><button class="btn danger" data-x="clear">Clear (this site)</button></div>`;
    layer.appendChild(panelEl);
    panelEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-x]"); if (!b) return;
      if (b.dataset.x === "close") closePanel();
      else if (b.dataset.x === "copy") copyBrief();
      else if (b.dataset.x === "clear") {
        if (confirmClear()) {
          // Remove only THIS site's comments; other sites stay intact.
          session.comments = session.comments.filter((c) => c.origin !== originOf());
          saveSession(); updateCounts(); renderPins(); renderPanel();
          if (devState.open) renderDevPins();
          toast("Cleared this site's comments");
        }
      }
    });
  }
  let clearArmed = false;
  function confirmClear() {
    if (clearArmed) { clearArmed = false; return true; }
    clearArmed = true; toast("Tap again to confirm clearing this site");
    setTimeout(() => { clearArmed = false; }, 2500);
    return false;
  }
  function renderPanel() {
    if (!panelEl) return;
    const body = panelEl.querySelector(".body");
    const mine = currentComments();
    panelEl.querySelector(".s").textContent = `${mine.length} on ${originOf()} · across ${new Set(mine.map((c) => c.route)).size} page(s)`;
    if (!mine.length) { body.innerHTML = `<div class="empty">No comments on this site yet.<br/>Tap the bubble, then click any element to leave one.</div>`; return; }
    const groups = {};
    for (const c of mine) (groups[c.route] = groups[c.route] || []).push(c);
    let html = "";
    for (const route of Object.keys(groups)) {
      html += `<div class="grp-h">${escapeHtml(route)}</div>`;
      for (const c of groups[route].sort((a, b) => a.n - b.n)) {
        html += `<div class="row" data-id="${c.id}">
          <span class="n">${c.n}</span>
          <div class="c"><div class="tx">${escapeHtml(c.text)}</div>
            <div class="meta"><span>${escapeHtml(c.tagName)}</span>${c.breakpoint ? `<span class="bp">${escapeHtml(c.breakpoint.label)}</span>` : ""}<span>${escapeHtml((c.elementText || "").slice(0, 40))}</span></div></div>
          <button class="del" data-del="${c.id}" title="Delete">✕</button></div>`;
      }
    }
    body.innerHTML = html;
    body.querySelectorAll(".row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) { deleteComment(e.target.closest("[data-del]").dataset.del); return; }
        const c = session.comments.find((x) => x.id === row.dataset.id);
        if (c) { closePanel(); flashComment(c); }
      });
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
  const devState = { open: false, idx: 1, el: null, iframe: null, overlay: null };

  function openDevice() {
    if (devState.open) return;
    devState.open = true;
    const d = document.createElement("div");
    d.className = "dev";
    d.innerHTML = `
      <div class="dtop">
        <div class="seg">${DEVICES.map((dv, i) => `<button data-dev="${i}">${escapeHtml(dv.label)}</button>`).join("")}</div>
        <span class="dwid"></span>
        <span class="grow"></span>
        <button class="mbtn" data-x="pick" style="pointer-events:auto;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>Comment here</button>
        <button class="mbtn" data-x="close" style="pointer-events:auto;">Done</button>
      </div>
      <div class="dstage">
        <div class="framewrap"><iframe title="Mochi responsive preview" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe><div class="doverlay"></div></div>
      </div>`;
    layer.appendChild(d);
    devState.el = d;
    devState.iframe = d.querySelector("iframe");
    devState.overlay = d.querySelector(".doverlay");
    d.addEventListener("click", (e) => {
      const seg = e.target.closest("[data-dev]");
      if (seg) { devState.idx = +seg.dataset.dev; applyDevice(); return; }
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
    const dv = DEVICES[devState.idx];
    devState.el.querySelectorAll("[data-dev]").forEach((b, i) => b.classList.toggle("on", i === devState.idx));
    devState.el.querySelector(".dwid").textContent = `${dv.width} × ${dv.height}`;
    const fw = devState.el.querySelector(".framewrap");
    // fit height to stage
    const stage = devState.el.querySelector(".dstage");
    const maxH = stage.clientHeight - 24;
    const h = Math.min(dv.height, maxH > 200 ? maxH : dv.height);
    fw.style.width = dv.width + "px"; fw.style.height = h + "px";
    devState.iframe.style.width = dv.width + "px"; devState.iframe.style.height = h + "px";
    if (devState.iframe.src !== location.href) devState.iframe.src = location.href;
    else { renderDevPins(); if (pickMode) { startDevPick(); updateDevPickBtn(); } }
  }
  function showDevNote(msg) {
    const stage = devState.el.querySelector(".dstage");
    stage.innerHTML = `<div class="dnote">${escapeHtml(msg)}</div>`;
  }
  function closeDevice() {
    if (!devState.open) return;
    stopPick();
    try { devState.el.remove(); } catch {}
    devState.open = false; devState.el = devState.iframe = devState.overlay = null;
  }
  function devTarget() {
    const ifr = devState.iframe;
    return {
      doc: ifr.contentDocument, win: ifr.contentWindow,
      offset: () => { const r = ifr.getBoundingClientRect(); return { x: r.left, y: r.top }; },
      breakpoint: { label: DEVICES[devState.idx].label, width: DEVICES[devState.idx].width },
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
    const dv = DEVICES[devState.idx];
    const want = session.comments.filter((c) => c.route === routeOf() && c.origin === originOf() && c.breakpoint && c.breakpoint.width === dv.width);
    const existing = new Map([...devState.overlay.children].map((el) => [el.dataset.id, el]));
    for (const c of want) {
      let node = null; try { node = doc.querySelector(c.selector); } catch {}
      let el = existing.get(c.id);
      if (!el) {
        el = document.createElement("div"); el.className = "pin"; el.dataset.id = c.id; el.textContent = c.n; el.style.pointerEvents = "auto";
        el.title = c.text;
        // Re-resolve the node at click time (the one captured at creation may be
        // null if async content hadn't rendered yet).
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          let n = null; try { n = devState.iframe.contentDocument.querySelector(c.selector); } catch {}
          if (n) openPop(n, devTarget(), c); else toast("Element not found in frame");
        });
        devState.overlay.appendChild(el);
      }
      if (node) {
        const r = node.getBoundingClientRect();
        // overlay is positioned over the iframe; map iframe-viewport coords to overlay coords
        el.style.left = `${(ir.left - fr.left) + r.left + Math.min(r.width, 14)}px`;
        el.style.top = `${(ir.top - fr.top) + r.top + 2}px`;
        el.style.display = (r.bottom < 0 || r.top > ifr.clientHeight) ? "none" : "flex";
      } else { el.style.display = "none"; }
    }
  }

  // --------------------------------------------------------- scroll-teach ----
  function maybeTeachScroll() {
    if (session.taughtScroll) return;
    session.taughtScroll = true; saveSession();
    const t = document.createElement("div");
    t.className = "teach";
    t.innerHTML = `<div class="mouse"></div><div>Scroll freely — you can comment anywhere on the page.</div>`;
    layer.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => { try { t.remove(); } catch {} }, 500); }, 4200);
  }

  // -------------------------------------------------------------- export ----
  function buildBrief() {
    const cs = currentComments().sort((a, b) => a.n - b.n);   // this site only
    const origin = originOf();
    const lines = [];
    lines.push(`# Mochi review — ${origin} — ${cs.length} comment${cs.length === 1 ? "" : "s"}`);
    lines.push(`Generated ${new Date().toISOString()}. Each item has a CSS selector + route so you can locate the exact element. Fix each comment.`);
    lines.push("");
    for (const c of cs) {
      const bp = c.breakpoint ? ` · [${c.breakpoint.label} ${c.breakpoint.width}px]` : "";
      lines.push(`## ${c.n} · ${c.route}${bp}`);
      lines.push(`- selector: \`${c.selector}\``);
      lines.push(`- element: <${c.tagName}>${c.elementText ? ` "${c.elementText}"` : ""}${c.role ? ` (role=${c.role})` : ""}`);
      lines.push(`- box: ${c.box.x},${c.box.y} ${c.box.w}×${c.box.h} @ ${c.viewport.w}×${c.viewport.h}`);
      lines.push(`- comment: ${c.text}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  async function copyBrief() {
    const count = currentComments().length;
    if (!count) { toast("No comments on this site to copy yet"); return; }
    const text = buildBrief();
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
  // Cross-tab sync: adopt another context's write to the shared session.
  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[SKEY]) return;
    const nv = changes[SKEY].newValue;
    if (!nv) { teardown(); return; }
    const j = JSON.stringify({ active: nv.active, startedAt: nv.startedAt, taughtScroll: nv.taughtScroll, comments: nv.comments });
    if (j === lastWriteJson) return;   // our own write — ignore
    applySession(nv);
    if (!session.active) { teardown(); return; }
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
    try { document.removeEventListener("click", onDocClickCloseMenu, true); } catch {}
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
    unpatchHistory();
    try { window.__mochiCommentResync = null; } catch {}
    try { host.remove(); } catch {}
  }

  // Resync hook for the re-injection guard (host already present).
  window.__mochiCommentResync = () => {
    loadSession().then(() => {
      if (!session.active) { teardown(); return; }
      lastRoute = routeOf();
      updateCounts(); renderPins(); if (devState.open) renderDevPins();
    });
  };

  // ------------------------------------------------------------- bootstrap ----
  (async () => {
    await loadSession();
    if (!session.active) { teardown(); return; }
    try { chrome.runtime.sendMessage({ type: "comment_register_tab" }); } catch {}
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch {}
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch {}
    lastRoute = routeOf();
    patchHistory();
    updateCounts();
    renderPins();
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

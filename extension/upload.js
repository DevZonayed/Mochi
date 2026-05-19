// extension/upload.js — strategy chain for browser_upload_file.
//
// Receives wire params { filePaths, fileBytes?, target, strategies, frames,
// dispatchEvents, waitFor } and runs the strategy chain via chrome.debugger
// CDP calls.
//
// This module is statically imported by background.js (MV3 SW with
// "type": "module"). It does NOT import background.js — that would create a
// circular dependency. Instead, background.js exposes the helpers it needs on
// `globalThis` (cdp, ensureAttached, getSession, targetTab). Those are read
// lazily inside request-handling functions, after background.js has finished
// initial evaluation.

export async function handleUploadFile(params, clientId) {
  const {
    filePaths = [],
    fileBytes,
    target,
    strategies = ["direct"],
    frames = "all",
    dispatchEvents = ["change", "input"],
    waitFor,
  } = params || {};

  if (!filePaths.length) {
    return { ok: false, error: { code: "source-missing", message: "filePaths empty" } };
  }
  // Defense-in-depth path allowlist (Task 21). Server already re-stages all
  // sources into .continuum/uploads/, but we double-check here.
  for (const p of filePaths) {
    if (!isPathAllowed(p)) {
      return { ok: false, error: { code: "permission", message: "path not in allowlist", details: { path: p } } };
    }
  }
  if (!target) {
    return { ok: false, error: { code: "source-missing", message: "target missing" } };
  }

  const tabId = await resolveTabIdForClient(params, clientId);
  await globalThis.ensureAttached(tabId);

  const ctx = {
    tabId,
    filePaths,
    fileBytes,
    target,
    frames,
    dispatchEvents,
    waitFor,
    attempts: [],
  };

  for (const strategy of strategies) {
    const t0 = Date.now();
    try {
      const r = await runStrategy(strategy, ctx);
      if (r.ok) {
        ctx.attempts.push({ strategy, ok: true, durationMs: Date.now() - t0 });
        const waited = await smartWait(ctx);
        return {
          ok: true,
          strategy,
          attempts: ctx.attempts,
          target: r.target,
          files: filePaths.map((p, i) => ({
            name: fileBytes?.[i]?.name ?? p.split("/").pop(),
            mime: fileBytes?.[i]?.mime,
            sizeBytes: undefined,
          })),
          waitedFor: waited,
          totalMs: Date.now() - t0,
        };
      }
      ctx.attempts.push({ strategy, ok: false, reason: r.reason, durationMs: Date.now() - t0 });
    } catch (e) {
      ctx.attempts.push({ strategy, ok: false, reason: String(e?.message ?? e), durationMs: Date.now() - t0 });
    }
  }
  return {
    ok: false,
    error: {
      code: "all-strategies-failed",
      message: "no strategy succeeded",
      details: { attempts: ctx.attempts },
    },
  };
}

async function runStrategy(name, ctx) {
  if (name === "direct")    return strategyDirect(ctx);
  if (name === "intercept") return strategyIntercept(ctx);
  if (name === "drop")      return strategyDrop(ctx);
  if (name === "paste")     return strategyPaste(ctx);
  return { ok: false, reason: `unknown strategy "${name}"` };
}

async function strategyDirect(ctx) {
  let resolved;
  try { resolved = await resolveTargetNode(ctx, ctx.target); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (resolved.isTrigger) {
    return { ok: false, reason: "target is a trigger element, not an <input type=file>" };
  }

  // Verify the resolved node is <input type="file"> before handing paths to
  // DOM.setFileInputFiles — Chrome rejects the call on any other element, and
  // we'd rather return a clear reason than a CDP error.
  const desc = await cdp(ctx.tabId, "DOM.describeNode", { nodeId: resolved.nodeId });
  const node = desc.node || {};
  const tag = (node.localName || node.nodeName || "").toLowerCase();
  const attrs = node.attributes || [];
  let type = "";
  for (let i = 0; i < attrs.length; i += 2) {
    if ((attrs[i] || "").toLowerCase() === "type") { type = (attrs[i + 1] || "").toLowerCase(); break; }
  }
  if (tag !== "input" || type !== "file") {
    return { ok: false, reason: `target is <${tag} type="${type}">, not <input type="file">` };
  }

  await cdp(ctx.tabId, "DOM.setFileInputFiles", { nodeId: resolved.nodeId, files: ctx.filePaths });
  await dispatchPostEvents(ctx, resolved);
  return {
    ok: true,
    target: { resolved: `<${tag} type="${type}">`, frameId: resolved.frameId, nodeId: resolved.nodeId },
  };
}

async function dispatchPostEvents(ctx, resolved) {
  if (!ctx.dispatchEvents || !ctx.dispatchEvents.length) return;
  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: resolved.nodeId });
  const objectId = objectIdResp.object.objectId;
  for (const ev of ctx.dispatchEvents) {
    // ev is interpolated into a function source; keep the allow-list tight to
    // avoid injection via crafted dispatchEvents values.
    const safe = String(ev).replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) continue;
    await cdp(ctx.tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(){ this.dispatchEvent(new Event('${safe}', { bubbles: true })); }`,
    });
  }
}

async function smartWait(ctx) {
  const wf = ctx.waitFor || { mode: "smart", timeoutMs: 15000 };
  if (wf.mode === "none") return null;
  const timeoutMs = wf.timeoutMs == null ? 15000 : wf.timeoutMs;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  // Network 2xx listener — fires whenever an upload-ish URL responds 2xx.
  const networkPattern = wf.networkPattern
    ? new RegExp(wf.networkPattern, "i")
    : /upload|media|attach|photo/i;
  let netHit = null;
  const onEvent = (method, params) => {
    if (method !== "Network.responseReceived") return;
    const resp = params && params.response;
    if (!resp) return;
    const url = resp.url || "";
    const status = resp.status || 0;
    if (status >= 200 && status < 300 && networkPattern.test(url)) {
      netHit = { signal: "network-2xx", url, status };
    }
  };
  if (!globalThis.__mochiCdpListeners) globalThis.__mochiCdpListeners = new Map();
  const key = "smartwait-" + ctx.tabId + "-" + Math.random().toString(36).slice(2);
  globalThis.__mochiCdpListeners.set(key, { tabId: ctx.tabId, listener: onEvent });

  // DOM MutationObserver installed in-page — looks for preview elements
  // (blob:/data: image+video sources by default, or wf.previewSelector).
  const observerId = await installPreviewObserver(ctx.tabId, wf.previewSelector);

  let mutationSampled = 0;
  try {
    while (Date.now() < deadline) {
      if (netHit) return { ...netHit, durationMs: Date.now() - startedAt };
      const dom = await pollPreviewObserver(ctx.tabId, observerId);
      mutationSampled = dom.mutations;
      if (dom.match) {
        return { signal: "preview-img", selector: dom.selector, durationMs: Date.now() - startedAt };
      }
      if (wf.successSelector) {
        try {
          const doc = await getDocumentNodeId(ctx.tabId);
          const r = await cdp(ctx.tabId, "DOM.querySelector", { nodeId: doc, selector: wf.successSelector });
          if (r.nodeId) {
            const box = await getNodeBox(ctx.tabId, r.nodeId);
            if (box && box.width > 0 && box.height > 0) {
              return { signal: "successSelector", selector: wf.successSelector, durationMs: Date.now() - startedAt };
            }
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { signal: null, reason: "timeout", evidence: { mutationSampled } };
  } finally {
    globalThis.__mochiCdpListeners.delete(key);
    await uninstallPreviewObserver(ctx.tabId, observerId).catch(() => {});
  }
}

// observerId -> { tabId } — kept so we can clean up across multiple parallel
// smart-waits if needed.
const PREVIEW_OBSERVERS = new Map();

async function installPreviewObserver(tabId, customSelector) {
  const selector = customSelector || 'img[src^="blob:"],img[src^="data:"],video[src^="blob:"]';
  const observerId = "mochi_obs_" + Math.random().toString(36).slice(2);
  const expr = `
    (function(){
      const sel = ${JSON.stringify(selector)};
      window.__mochiObservers = window.__mochiObservers || {};
      const state = window.__mochiObservers[${JSON.stringify(observerId)}] = { matched: false, mutations: 0, selector: sel };
      const obs = new MutationObserver((records) => {
        state.mutations += records.length;
        if (!state.matched && document.querySelector(sel)) state.matched = true;
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      state.disconnect = () => obs.disconnect();
    })();
  `;
  await cdp(tabId, "Runtime.evaluate", { expression: expr });
  PREVIEW_OBSERVERS.set(observerId, { tabId });
  return observerId;
}

async function pollPreviewObserver(tabId, observerId) {
  const r = await cdp(tabId, "Runtime.evaluate", {
    expression: `JSON.stringify({ match: (window.__mochiObservers && window.__mochiObservers[${JSON.stringify(observerId)}] && window.__mochiObservers[${JSON.stringify(observerId)}].matched) || false, mutations: (window.__mochiObservers && window.__mochiObservers[${JSON.stringify(observerId)}] && window.__mochiObservers[${JSON.stringify(observerId)}].mutations) || 0, selector: (window.__mochiObservers && window.__mochiObservers[${JSON.stringify(observerId)}] && window.__mochiObservers[${JSON.stringify(observerId)}].selector) || '' })`,
    returnByValue: true,
  });
  try { return JSON.parse((r.result && r.result.value) || "{}"); }
  catch { return { match: false, mutations: 0, selector: "" }; }
}

async function uninstallPreviewObserver(tabId, observerId) {
  PREVIEW_OBSERVERS.delete(observerId);
  await cdp(tabId, "Runtime.evaluate", {
    expression: `(function(){ const s = window.__mochiObservers && window.__mochiObservers[${JSON.stringify(observerId)}]; if (s && s.disconnect) s.disconnect(); if (window.__mochiObservers) delete window.__mochiObservers[${JSON.stringify(observerId)}]; })();`,
  });
}

async function resolveTabIdForClient(params, clientId) {
  if (params && params.tabId) return params.tabId;
  // Use the same pattern as the rest of background.js: getSession + targetTab.
  const getSession = globalThis.getSession;
  const targetTab = globalThis.targetTab;
  if (typeof getSession !== "function" || typeof targetTab !== "function") {
    throw new Error("upload: session helpers not available on globalThis");
  }
  const s = getSession(clientId);
  return targetTab(s, undefined);
}

function isPathAllowed(p) {
  if (typeof p !== "string" || !p.length) return false;
  // Reject obvious path-traversal attempts even if the prefix matches. The
  // server normalises paths before sending, so any `..` reaching us is
  // suspicious enough to refuse outright.
  if (p.includes("/../") || p.includes("\\..\\") || p.endsWith("/..") || p.endsWith("\\..")) return false;
  // .continuum/uploads/ relative segment must be in the path. Match both
  // posix-style and win32-style separators so the check is portable.
  if (p.includes("/.continuum/uploads/") || p.includes("\\.continuum\\uploads\\")) return true;
  // Optional extra-prefix allowlist for callers running custom upload roots.
  // Set globalThis.SUPER_TESTER_UPLOAD_ALLOW_PATHS to a colon-delimited list
  // (the server can populate this via the wire payload if it wants to expand
  // the allowlist for a specific request).
  const extras = (globalThis.SUPER_TESTER_UPLOAD_ALLOW_PATHS || "").split(":").filter(Boolean);
  return extras.some((prefix) => p.startsWith(prefix));
}

globalThis.__mochiHandleUploadFile = handleUploadFile;

// ---------------- target resolution + CDP helpers ----------------

async function cdp(tabId, method, params) {
  // background.js mirrors its cdp() helper onto globalThis at module init.
  // We read it lazily so module-eval order is irrelevant.
  if (typeof globalThis.cdp !== "function") {
    throw new Error("upload: globalThis.cdp not available (background.js wiring missing)");
  }
  return globalThis.cdp(tabId, method, params);
}

async function getDocumentNodeId(tabId, frameId) {
  if (frameId && frameId !== "top") {
    // Resolve the frame's content document via its owning iframe element.
    const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId });
    const node = await cdp(tabId, "DOM.describeNode", {
      backendNodeId: owner.backendNodeId,
      depth: 0,
      pierce: false,
    });
    if (!node.node || !node.node.contentDocument) {
      throw new Error(`frame ${frameId} has no contentDocument (cross-origin?)`);
    }
    return node.node.contentDocument.nodeId;
  }
  const root = await cdp(tabId, "DOM.getDocument", { depth: 0, pierce: false });
  return root.root.nodeId;
}

function findFrame(node, frameId) {
  if (node && node.frame && node.frame.id === frameId) return node;
  for (const child of (node && node.childFrames) || []) {
    const r = findFrame(child, frameId);
    if (r) return r;
  }
  return null;
}

async function resolveTargetNode(ctx, target) {
  // Returns { nodeId, frameId, isTrigger? } or throws target-not-found.
  // NOTE: In this codebase, target.ref is also a CSS selector (mochi snapshots
  // emit selectors as the "ref" field). There is no separate ref->nodeId
  // table to consult, so we treat ref identically to selector.
  const frames = await listFrames(ctx);
  for (const frameId of frames) {
    try {
      if (target.selector || target.ref) {
        const selector = target.selector || target.ref;
        const doc = await getDocumentNodeId(ctx.tabId, frameId);
        const r = await cdp(ctx.tabId, "DOM.querySelector", { nodeId: doc, selector });
        if (r.nodeId) return { nodeId: r.nodeId, frameId };
      } else if (target.trigger) {
        return resolveTargetNode(ctx, target.trigger); // recurse with selector/ref
      } else if (target.auto) {
        const anchor = await resolveAnchor(ctx, target.auto.near, frameId);
        if (anchor) return await autoDetectFromAnchor(ctx, anchor, frameId);
      }
    } catch (e) {
      // try next frame
    }
  }
  throw new Error("target-not-found");
}

async function listFrames(ctx) {
  if (ctx.frames === "top") return ["top"];
  if (ctx.frames && ctx.frames !== "all") return [ctx.frames];
  const tree = await cdp(ctx.tabId, "Page.getFrameTree", {});
  const all = ["top"];
  collectFrameIds(tree.frameTree, all);
  return all;
}

function collectFrameIds(node, out) {
  for (const child of (node && node.childFrames) || []) {
    if (child.frame && child.frame.id) out.push(child.frame.id);
    collectFrameIds(child, out);
  }
}

async function resolveAnchor(ctx, near, frameId) {
  // No separate ref table in this codebase — `near` is always a CSS selector.
  const doc = await getDocumentNodeId(ctx.tabId, frameId);
  const r = await cdp(ctx.tabId, "DOM.querySelector", { nodeId: doc, selector: near });
  return r.nodeId ? { nodeId: r.nodeId } : null;
}

async function autoDetectFromAnchor(ctx, anchor, frameId) {
  // Use Runtime.callFunctionOn against the anchor's JS object to walk the DOM
  // and locate a nearby <input type="file">.
  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: anchor.nodeId });
  const objectId = objectIdResp.object.objectId;
  const r = await cdp(ctx.tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: autoDetectFn.toString(),
  });
  if (!r.result || !r.result.objectId) {
    // No <input type=file> found nearby — caller should treat anchor as a
    // trigger element (e.g. for the intercept strategy).
    return { nodeId: anchor.nodeId, frameId, isTrigger: true };
  }
  const nodeMeta = await cdp(ctx.tabId, "DOM.requestNode", { objectId: r.result.objectId });
  return { nodeId: nodeMeta.nodeId, frameId, isTrigger: false };
}

async function strategyIntercept(ctx) {
  // For target.trigger, click the trigger spec; otherwise click the resolved
  // target itself (works when the user passes a button selector directly).
  const triggerSpec = ctx.target.trigger || ctx.target;
  let resolved;
  try { resolved = await resolveTargetNode(ctx, triggerSpec); }
  catch (e) { return { ok: false, reason: e.message }; }

  await cdp(ctx.tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

  // Register a transient CDP-event listener via the shared map background.js
  // fans events into. When Page.fileChooserOpened fires for this tab we
  // accept it with our file paths.
  let chooserFired = false;
  let chooserBackendNodeId = null;
  const listener = (method, params) => {
    if (method === "Page.fileChooserOpened") {
      chooserFired = true;
      chooserBackendNodeId = params && params.backendNodeId;
      cdp(ctx.tabId, "Page.handleFileChooser", { action: "accept", files: ctx.filePaths }).catch(() => {});
    }
  };
  if (!globalThis.__mochiCdpListeners) globalThis.__mochiCdpListeners = new Map();
  const listenerKey = "upload-" + ctx.tabId + "-" + Math.random().toString(36).slice(2);
  globalThis.__mochiCdpListeners.set(listenerKey, { tabId: ctx.tabId, listener });

  try {
    // Click via Input.dispatchMouseEvent at the node's center. We use raw CDP
    // input dispatch (not chrome.scripting el.click()) because user-initiated
    // clicks are what trigger file chooser dialogs cross-platform.
    const box = await getNodeBox(ctx.tabId, resolved.nodeId);
    if (!box) return { ok: false, reason: "trigger node has no box (display:none?)" };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp(ctx.tabId, "Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1 });
    await cdp(ctx.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    // Wait up to 3s for the chooser event to fire.
    const deadline = Date.now() + 3000;
    while (!chooserFired && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return chooserFired
      ? { ok: true, target: { resolved: "trigger+chooser", frameId: resolved.frameId, backendNodeId: chooserBackendNodeId } }
      : { ok: false, reason: "chooser-timeout" };
  } finally {
    globalThis.__mochiCdpListeners.delete(listenerKey);
    try { await cdp(ctx.tabId, "Page.setInterceptFileChooserDialog", { enabled: false }); } catch {}
  }
}

async function strategyDrop(ctx) {
  if (!ctx.fileBytes || !ctx.fileBytes.length) {
    return { ok: false, reason: "drop requires fileBytes (server should have sent them)" };
  }
  let resolved;
  try { resolved = await resolveTargetNode(ctx, ctx.target); }
  catch (e) { return { ok: false, reason: e.message }; }

  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: resolved.nodeId });
  const objectId = objectIdResp.object.objectId;

  // Build the in-page function by inlining dropFn into a thin wrapper. We pass
  // fileBytes as an argument value so they show up as `files` inside the page.
  const r = await cdp(ctx.tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(files){ return (${dropFn.toString()}).call(this, files); }`,
    arguments: [{ value: ctx.fileBytes }],
    returnByValue: true,
    awaitPromise: true,
  });
  const value = r.result && r.result.value;
  const ok = value === true || (value && value.dropped === true);
  if (!ok) return { ok: false, reason: "drop event did not produce a mutation within 500ms" };
  return { ok: true, target: { resolved: "drop", frameId: resolved.frameId, nodeId: resolved.nodeId } };
}

// Executed in the page via Runtime.callFunctionOn. `this` is the drop target.
// Synthesizes File objects from base64 bytes, builds a DataTransfer, fires
// dragenter -> dragover -> drop, then waits 500ms for a MutationObserver to
// observe at least one mutation (proof the page reacted).
const dropFn = async function (files) {
  const fileObjs = files.map((f) => {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || "file", { type: f.mime || "application/octet-stream" });
  });
  const dt = new DataTransfer();
  for (const f of fileObjs) dt.items.add(f);

  const fired = { count: 0 };
  const obs = new MutationObserver((records) => { fired.count += records.length; });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });

  const dispatch = (type) => this.dispatchEvent(new DragEvent(type, {
    dataTransfer: dt,
    bubbles: true,
    cancelable: true,
  }));
  dispatch("dragenter");
  dispatch("dragover");
  dispatch("drop");

  await new Promise((r) => setTimeout(r, 500));
  obs.disconnect();
  return { dropped: fired.count > 0 };
};

async function strategyPaste(ctx) {
  if (!ctx.fileBytes || !ctx.fileBytes.length) {
    return { ok: false, reason: "paste requires fileBytes" };
  }
  let resolved;
  try { resolved = await resolveTargetNode(ctx, ctx.target); }
  catch (e) { return { ok: false, reason: e.message }; }

  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: resolved.nodeId });
  const objectId = objectIdResp.object.objectId;

  const r = await cdp(ctx.tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(files){ return (${pasteFn.toString()}).call(this, files); }`,
    arguments: [{ value: ctx.fileBytes }],
    returnByValue: true,
    awaitPromise: true,
  });
  const value = r.result && r.result.value;
  const ok = value && value.pasted === true;
  if (!ok) return { ok: false, reason: "paste event did not produce a mutation within 500ms" };
  return { ok: true, target: { resolved: "paste", frameId: resolved.frameId, nodeId: resolved.nodeId } };
}

// Executed in the page via Runtime.callFunctionOn. `this` is the paste target.
// Builds Files from base64, focuses the target if focusable, then dispatches
// a ClipboardEvent('paste') carrying a DataTransfer. Waits 500ms for a
// MutationObserver to confirm the page reacted.
const pasteFn = async function (files) {
  const fileObjs = files.map((f) => {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || "file", { type: f.mime || "application/octet-stream" });
  });
  const dt = new DataTransfer();
  for (const f of fileObjs) dt.items.add(f);

  if (typeof this.focus === "function") this.focus();
  const target = this.isContentEditable || this.tagName === "TEXTAREA" || this.tagName === "INPUT"
    ? this
    : (document.activeElement || this);

  const fired = { count: 0 };
  const obs = new MutationObserver((records) => { fired.count += records.length; });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });

  target.dispatchEvent(new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  }));

  await new Promise((r) => setTimeout(r, 500));
  obs.disconnect();
  return { pasted: fired.count > 0 };
};

async function getNodeBox(tabId, nodeId) {
  const r = await cdp(tabId, "DOM.getBoxModel", { nodeId });
  if (!r.model || !r.model.border) return null;
  const b = r.model.border;
  const x1 = b[0], y1 = b[1], x2 = b[2], y2 = b[5];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: r.model.width, height: r.model.height };
}

// Executed inside the page via Runtime.callFunctionOn — `this` is the anchor
// element. Returns the first <input type=file> found among descendants,
// following siblings (<=5 hops), or ancestors' descendants (<=3 levels up).
const autoDetectFn = function () {
  const isFileInput = (n) => n && n.tagName === "INPUT" && n.type === "file";
  if (this.querySelector) {
    const desc = this.querySelector('input[type="file"]');
    if (desc) return desc;
  }
  let cur = this, hops = 0;
  while (cur && hops < 5) {
    cur = cur.nextElementSibling;
    if (isFileInput(cur)) return cur;
    if (cur && cur.querySelector) {
      const x = cur.querySelector('input[type="file"]');
      if (x) return x;
    }
    hops++;
  }
  let anc = this.parentElement, depth = 0;
  while (anc && depth < 3) {
    const x = anc.querySelector('input[type="file"]');
    if (x) return x;
    anc = anc.parentElement;
    depth++;
  }
  return null;
};

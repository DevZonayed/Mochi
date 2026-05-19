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

async function smartWait(_ctx) {
  // Stub — implemented in Task 18.
  return null;
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
  // .continuum/uploads/ relative segment must be in the path. Match both
  // posix-style and win32-style separators so the check is portable.
  if (p.includes("/.continuum/uploads/") || p.includes("\\.continuum\\uploads\\")) return true;
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

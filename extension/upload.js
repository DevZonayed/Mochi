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
  // Stubs — implemented in Tasks 14-17.
  return { ok: false, reason: `strategy "${name}" not implemented yet` };
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

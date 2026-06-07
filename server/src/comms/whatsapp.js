// WhatsAppProvider (Baileys). v1: capture-only, no send.
// IMPORTANT: baileys/qrcode are imported LAZILY inside connect() so unit tests
// (logger, lockfile, lifecycle with a MOCK socket) never load native-free-but-
// heavy deps and never touch the network. The pinned dep is 6.7.23 (build phase).

import fs from "node:fs/promises";
import path from "node:path";

// ---- pino-free console logger shim (§9: do NOT add pino) -------------------
// baileys expects a pino-shaped logger: {level, child(), trace/debug/info/warn/
// error/fatal}. We forward to stderr (stdout is the MCP JSON-RPC channel).
export function consoleLogger({ level = "warn", write } = {}) {
  const out = write || ((s) => process.stderr.write(s + "\n"));
  const fmt = (lvl, args) => {
    const parts = args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    return `[wa:${lvl}] ${parts.join(" ")}`;
  };
  const mk = (lvl) => (...args) => { out(fmt(lvl, args)); };
  const logger = {
    level,
    trace: mk("trace"),
    debug: mk("debug"),
    info: mk("info"),
    warn: mk("warn"),
    error: mk("error"),
    fatal: mk("fatal"),
    child() { return consoleLogger({ level, write: out }); },
  };
  return logger;
}

// ---- single-writer lockfile (§7) ------------------------------------------
function lockPath(authDir) { return path.join(authDir, ".lock"); }

function pidAlive(pid) {
  if (!pid || pid === process.pid) {
    // Our own pid counts as alive only if it's actually us.
    if (pid === process.pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
    return false;
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export async function readLock(authDir) {
  try {
    const raw = await fs.readFile(lockPath(authDir), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

export async function acquireLock(authDir) {
  await fs.mkdir(authDir, { recursive: true });
  const existing = await readLock(authDir);
  if (existing && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { acquired: false, reason: "held", holder: existing };
  }
  if (existing && existing.pid === process.pid) {
    // We already hold it.
    return { acquired: false, reason: "held", holder: existing };
  }
  // No holder, or stale (dead pid) -> reclaim.
  const rec = { pid: process.pid, startedAt: Date.now() };
  await fs.writeFile(lockPath(authDir), JSON.stringify(rec));
  return { acquired: true, holder: rec };
}

export async function releaseLock(authDir) {
  const lk = await readLock(authDir);
  if (lk && lk.pid === process.pid) {
    try { await fs.rm(lockPath(authDir), { force: true }); } catch {}
  }
}

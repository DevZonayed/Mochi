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

// ---- WhatsAppProvider -------------------------------------------------------
import { CommsProvider } from "./provider.js";
import { normalize } from "./normalize.js";
import { appendMessage } from "../../../plugins/continuum/lib/comms_store.js";
import { fingerprint } from "../../../plugins/continuum/lib/comms_dedupe.js";
import { isAllowed, normalizeJid } from "../../../plugins/continuum/lib/comms_allowlist.js";
import { readConfig } from "../../../plugins/continuum/lib/comms_config.js";
import { commsAuthDir } from "../../../plugins/continuum/lib/paths.js";

// LID normalization (§5.2): map @lid <-> phone-JID. baileys' jidNormalizedUser
// is loaded lazily; we ship a safe fallback so tests need no baileys.
let _jidNormalizedUser = (jid) => jid;
async function ensureJidNormalizer() {
  if (_jidNormalizedUser !== undefined && _jidNormalizedUser.__loaded) return;
  try {
    const baileys = await import("@whiskeysockets/baileys");
    if (baileys.jidNormalizedUser) { _jidNormalizedUser = baileys.jidNormalizedUser; _jidNormalizedUser.__loaded = true; }
  } catch { /* test path / not installed yet */ }
}

export class WhatsAppProvider extends CommsProvider {
  // reconnectBaseMs: injectable so tests can use 0 to skip real delays.
  // qrTimeoutMs: injectable so tests can use a small value (e.g. 20) instead of
  //   the 30-second production default, driving the real link() timeout path.
  constructor({ projectDirFor, reconnectBaseMs, qrTimeoutMs } = {}) {
    super("whatsapp");
    this.projectDirFor = projectDirFor || (() => process.cwd());
    this.sockets = new Map();           // accountId -> socket
    this.statuses = new Map();          // accountId -> 'connected'|'needs_login'|'logged_out'
    this._reconnects = new Map();       // accountId -> consecutive reconnect attempt counter
    this.listeners = [];                // global onMessage callbacks
    this.logger = consoleLogger({ level: "warn" });
    // Allow tests to pass reconnectBaseMs:0 to disable backoff delays.
    this._reconnectBaseMs = reconnectBaseMs !== undefined ? reconnectBaseMs : WhatsAppProvider._RECONNECT_BASE_MS;
    // Allow tests to pass qrTimeoutMs to control link() QR wait (default 30 s).
    this._qrTimeoutMs = qrTimeoutMs !== undefined ? qrTimeoutMs : WhatsAppProvider._QR_TIMEOUT_MS;
  }

  getSessionDir(accountId) {
    return commsAuthDir(this.projectDirFor(accountId), "whatsapp", accountId);
  }

  status(accountId) { return this.statuses.get(accountId) || "logged_out"; }

  onMessage(cb) { this.listeners.push(cb); }

  // connect: opens a socket and wires capture. `makeSocket` is injectable so
  // tests pass a MOCK socket (no network). Real path lazily builds a baileys
  // socket inside _realMakeSocket (Task 17 wires QR/pairing/reconnect).
  async connect(accountId, { makeSocket } = {}) {
    await ensureJidNormalizer();
    const projectDir = this.projectDirFor(accountId);
    const authDir = commsAuthDir(projectDir, "whatsapp", accountId);
    const factory = makeSocket || ((deps) => this._realMakeSocket(accountId, authDir, deps));
    const sock = await factory({ authDir, accountId });
    this.sockets.set(accountId, sock);
    this.statuses.set(accountId, "connected");
    this._wireCapture(accountId, sock, projectDir);
    this._wireHistory(accountId, sock, projectDir);
    this._wireConnection(accountId, sock, projectDir, factory);
    return sock;
  }

  _capture(accountId, projectDir, raw, source) {
    if (!projectDir) return; // §3.1: never write to an unresolved project dir
    const acc = { provider: "whatsapp", accountId };
    let msg;
    try { msg = normalize("whatsapp", acc, raw, source); } catch (e) { this.logger.warn("normalize failed", String(e)); return; }
    if (!msg.chatId) return;
    // LID-normalize chat + sender BEFORE allowlist + fingerprint (§5.2).
    msg.chatId = normalizeJid(_jidNormalizedUser(msg.chatId));
    msg.senderId = normalizeJid(_jidNormalizedUser(msg.senderId));
    const cfg = readConfig(projectDir);
    if (!isAllowed(cfg, "whatsapp", accountId, msg.chatId)) return; // drop before write
    msg.fingerprint = fingerprint(msg);
    let r;
    try { r = appendMessage(projectDir, msg); } catch (e) { this.logger.warn("append failed", String(e)); return; }
    if (r.appended) {
      for (const cb of this.listeners) { try { cb(msg); } catch {} }
    }
  }

  _wireCapture(accountId, sock, projectDir) {
    sock.ev.on("messages.upsert", (payload) => {
      const list = payload?.messages || [];
      for (const raw of list) this._capture(accountId, projectDir, raw, "live");
    });
  }

  _wireHistory(accountId, sock, projectDir) {
    sock.ev.on("messaging-history.set", (payload) => {
      const list = payload?.messages || [];
      for (const raw of list) this._capture(accountId, projectDir, raw, "backfill");
    });
  }

  // ---- lifecycle: connection.update routing + close-reason reconnect ----------

  // DisconnectReason numeric codes baileys uses (avoids importing the enum):
  // loggedOut=401, restartRequired=515, connectionClosed=428, connectionLost=408,
  // timedOut=408, badSession=500, connectionReplaced=440.
  _statusCode(update) {
    return update?.lastDisconnect?.error?.output?.statusCode
      ?? update?.lastDisconnect?.error?.output?.payload?.statusCode
      ?? null;
  }

  // Codes that should NOT trigger auto-reconnect: the session is permanently
  // invalid and re-connecting without re-login or manual intervention would
  // just spin in a tight storm.
  static _NO_RECONNECT_CODES = new Set([
    401, // loggedOut         — must re-login
    440, // connectionReplaced — another client took over
    500, // badSession        — auth is corrupt; reconnecting won't fix it
  ]);

  // Maximum consecutive reconnect attempts before giving up.
  static _MAX_RECONNECTS = 5;
  // Base delay (ms) between reconnect attempts; doubles with each attempt (capped).
  static _RECONNECT_BASE_MS = 500;
  static _RECONNECT_MAX_MS  = 30_000;
  // Default QR timeout (ms); injectable via constructor qrTimeoutMs for tests.
  static _QR_TIMEOUT_MS = 30_000;

  _wireConnection(accountId, sock, projectDir, makeSocket) {
    sock.ev.on("connection.update", async (update) => {
      if (update.connection === "open") {
        // Successful open — reset per-account backoff counter.
        this._reconnects.set(accountId, 0);
        this.statuses.set(accountId, "connected");
        return;
      }
      if (update.connection === "close") {
        const code = this._statusCode(update);
        if (code === 401) {
          // loggedOut: wipe auth, surface re-login, DO NOT reconnect.
          this.statuses.set(accountId, "logged_out");
          try { await this._wipeAuth(accountId); } catch {}
          return;
        }
        if (WhatsAppProvider._NO_RECONNECT_CODES.has(code)) {
          // Permanent failure — surface as logged_out so callers re-link.
          this.statuses.set(accountId, "logged_out");
          return;
        }
        // restartRequired(515) / connectionClosed(428) / connectionLost(408) /
        // others: attempt bounded reconnect with exponential backoff.
        this.statuses.set(accountId, "needs_login");
        const attempts = (this._reconnects.get(accountId) || 0) + 1;
        this._reconnects.set(accountId, attempts);
        if (attempts > WhatsAppProvider._MAX_RECONNECTS) {
          this.logger.warn("reconnect limit reached, giving up", { accountId, attempts });
          return;
        }
        const delay = Math.min(
          this._reconnectBaseMs * Math.pow(2, attempts - 1),
          WhatsAppProvider._RECONNECT_MAX_MS
        );
        await new Promise((r) => setTimeout(r, delay));
        try {
          await this.connect(accountId, { makeSocket }); // a socket is single-use after close
        } catch (e) { this.logger.warn("reconnect failed", String(e)); }
      }
    });
  }

  async _wipeAuth(accountId) {
    const dir = this.getSessionDir(accountId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // link: open a socket (if needed) and resolve to QR or pairing code.
  // opts: { phone? }. deps: { makeSocket?, qrToDataUrl? } (injectable for tests).
  async link(accountId, opts = {}, deps = {}) {
    const projectDir = this.projectDirFor(accountId);
    const makeSocket = deps.makeSocket || ((d) => this._realMakeSocket(accountId, this.getSessionDir(accountId), d));
    const qrToDataUrl = deps.qrToDataUrl || (async (s) => this._qrToDataUrl(s));
    const sock = await this.connect(accountId, { makeSocket });
    // NOTE: do NOT call _wireConnection here; connect() already wired it with
    // the correct factory. Calling it again would double-wire the handler,
    // causing two reconnects on every close event (socket leak / doubling storm).

    // Pairing path: request ONCE, never loop (429 guard).
    if (opts.phone) {
      const code = await sock.requestPairingCode(String(opts.phone).replace(/[^0-9]/g, ""));
      return { method: "pairing", payload: { code } };
    }

    // QR path: resolve on the first qr from connection.update; guard re-emits.
    // Timeout (default 30 s; injectable via constructor qrTimeoutMs) prevents the
    // promise from hanging forever when the connection reaches 'open' without ever
    // emitting a qr (already-authenticated session) or when a transport error
    // prevents qr delivery.
    return await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      const onUpdate = async (update) => {
        if (update.connection === "open") {
          // Connected without ever sending a QR — session was already authenticated.
          settle(reject, Object.assign(new Error("link_no_qr: session already authenticated; use re-link after logout"), { code: "link_no_qr" }));
          return;
        }
        if (!update.qr) return;
        const dataUrl = await qrToDataUrl(update.qr);
        settle(resolve, { method: "qr", payload: { dataUrl, ascii: `[QR] scan in WhatsApp > Linked Devices\n${update.qr}` } });
      };
      const timer = setTimeout(() => {
        settle(reject, Object.assign(new Error("link_timeout: QR not emitted within timeout"), { code: "link_timeout" }));
      }, this._qrTimeoutMs);
      sock.ev.on("connection.update", onUpdate);
    });
  }

  // Lazy qrcode import (build phase adds the dep). Falls back to a data-URL stub.
  async _qrToDataUrl(qr) {
    try {
      const qrcode = (await import("qrcode")).default || (await import("qrcode"));
      return await qrcode.toDataURL(qr);
    } catch {
      return `data:text/plain;base64,${Buffer.from(qr).toString("base64")}`;
    }
  }

  // Real baileys socket builder — lazily imported so tests never load baileys.
  async _realMakeSocket(accountId, authDir, _deps) {
    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      // §5.2 trap: ALWAYS pass an explicit callback; syncFullHistory:false alone
      // silently kills history sync and can break live routing.
      shouldSyncHistoryMessage: () => true,
      getMessage: async (key) => this._getMessageFromStore(accountId, key),
    });
    sock.ev.on("creds.update", saveCreds);
    return sock;
  }

  // getMessage: baileys asks us to re-supply a message for decryption/retries.
  // v1 returns undefined (store read is best-effort; missing => baileys retries).
  async _getMessageFromStore(_accountId, _key) { return undefined; }
}

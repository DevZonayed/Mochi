// Bridge: dual-mode coordination layer between MCP server processes and the
// Chrome extension's service worker.
//
// On startup each MCP process tries to bind ws://127.0.0.1:9009. The winner
// becomes the BROKER and holds the single TCP listener. Losers become CLIENTS
// and connect to the broker as a peer. Clients forward all browser-level
// commands through the broker; the broker tags each command with the
// originating clientId and the extension routes it to that client's session.
//
// Wire protocol (over a single port):
//   On connect, every WS sends:  {type:"hello", role:"extension"|"mcp-client", ...}
//   Extension role uses the original protocol with one new field:
//     broker → ext   {id, type, params, clientId}
//     ext   → broker {id, ok, result}
//   MCP-client role uses:
//     client → broker {id, type, params}        (regular tool calls)
//     broker → client {type:"welcome", clientId} (sent right after hello)
//     broker → client {id, ok, result}          (responses)
//
// When a client disconnects, the broker tells the extension to end that
// client's session so tab groups don't leak.

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

const HELLO_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 30000;
const CLIENT_CONNECT_TIMEOUT_MS = 5000;
const CLIENT_RECOVERY_MAX_DELAY_MS = 5000;
const CLIENT_CLEANUP_GRACE_MS = 5000;

export class Bridge {
  constructor({ log = () => {}, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.log = log;
    this.mode = null;            // "broker" | "client"
    this.requestTimeoutMs = requestTimeoutMs;
    this.host = null;
    this.port = null;
    this.closed = false;

    // Broker state ---------------------------------------------------------
    this.httpServer = null;
    this.wss = null;
    this.extensionWs = null;
    this.extensionStandbys = []; // Set<WebSocket> — extras kept alive but inactive
    this.mcpClients = new Map(); // clientId → ws
    this.clientCleanupTimers = new Map();
    this.extPending = new Map(); // id → { resolve, reject, clientId? }
    this.extWaiters = [];        // unblocked when extension connects
    this.localClientId = null;

    // Claude session registry (Continuum plugin <-> extension popup) -------
    // Keyed by Claude Code session_id (from SessionStart hook payload), NOT
    // by mcpClient connection — those are independent (our continuum MCP
    // server is stdio-only and never connects to this broker).
    this.claudeSessions = new Map(); // sessionId → {name, projectDir, registeredAt, lastActivity}
    this.claudeInbox = new Map();    // sessionId → Array<{message, context, ts}>

    // Client state ---------------------------------------------------------
    this.brokerWs = null;
    this.brokerPending = new Map(); // id → { resolve, reject }
    this.brokerWaiters = [];
    this.recoveryPromise = null;
    this.recoveryAttempts = 0;
    this.lastRecoveryAt = null;
    this.lastError = null;

    this.nextId = 1;
  }

  // --------- Mode entry points ----------

  // Try to become broker by binding the port. Resolves to "broker" on success
  // or "client" if the port is already taken.
  async start({ port = 9009, host = "127.0.0.1" } = {}) {
    this.port = port;
    this.host = host;
    const role = await this._tryBecomeBroker(port, host);
    if (role === "broker") return "broker";
    try {
      await this._becomeClient(port, host);
    } catch (e) {
      this.lastError = e.message;
      this.log(`[bridge] initial broker connection failed: ${e.message}; entering recovery`);
      await this._startClientRecovery();
    }
    return this.mode;
  }

  // ---------------- BROKER ----------------

  _tryBecomeBroker(port, host, { preserveLocalClientId = false } = {}) {
    return new Promise((resolve) => {
      // Shared HTTP server: handles /claude/* REST routes for the Continuum
      // plugin AND hosts the WS upgrade path for the extension/MCP clients.
      const server = http.createServer((req, res) => this._handleHttpRequest(req, res));
      const wss = new WebSocketServer({ server });
      // wss re-emits the underlying http server's errors. Attach a no-op
      // BEFORE listen() so an EADDRINUSE doesn't crash the process via
      // "Unhandled 'error' event" on the ws instance.
      wss.on("error", () => {});
      let settled = false;
      const settleClient = (e) => {
        if (settled) return; settled = true;
        if (e?.code !== "EADDRINUSE") {
          this.lastError = e?.message ?? String(e);
          this.log(`[bridge] http server error: ${e?.message ?? e}`);
        }
        resolve("client");
      };
      server.once("error", settleClient);
      server.listen(port, host, () => {
        if (settled) return; settled = true;
        this.httpServer = server;
        this.wss = wss;
        this.mode = "broker";
        this.localClientId = preserveLocalClientId && this.localClientId
          ? this.localClientId
          : this._mintClientId("self");
        this.log(`[bridge] broker bound ws://${host}:${port} + http://${host}:${port}/claude/* (clientId=${this.localClientId})`);
        server.removeAllListeners("error");
        server.on("error", (e) => this.log(`[bridge] http server error: ${e.message}`));
        wss.removeAllListeners("error");
        wss.on("error", (e) => this.log(`[bridge] wss error: ${e.message}`));
        wss.on("connection", (ws, req) => this._onBrokerConnection(ws, req));
        resolve("broker");
      });
    });
  }

  // ---------- Claude session registry (used by Continuum plugin) ----------

  _registerClaudeSession(sessionId, { name, projectDir }) {
    const now = new Date().toISOString();
    const existing = this.claudeSessions.get(sessionId);
    this.claudeSessions.set(sessionId, {
      name: name || existing?.name || sessionId,
      projectDir: projectDir || existing?.projectDir || null,
      registeredAt: existing?.registeredAt || now,
      lastActivity: now,
    });
    this._broadcastClaudeSessions();
  }

  _unregisterClaudeSession(sessionId) {
    const had = this.claudeSessions.delete(sessionId);
    this.claudeInbox.delete(sessionId);
    if (had) this._broadcastClaudeSessions();
    return had;
  }

  _renameClaudeSession(sessionId, name) {
    const s = this.claudeSessions.get(sessionId);
    if (!s) return false;
    s.name = name;
    s.lastActivity = new Date().toISOString();
    this._broadcastClaudeSessions();
    return true;
  }

  _pushClaudeMessage(sessionId, message, context) {
    if (!this.claudeSessions.has(sessionId)) return false;
    if (!this.claudeInbox.has(sessionId)) this.claudeInbox.set(sessionId, []);
    this.claudeInbox.get(sessionId).push({
      message: String(message ?? ""),
      context: context && typeof context === "object" ? context : null,
      ts: new Date().toISOString(),
    });
    const s = this.claudeSessions.get(sessionId);
    s.lastActivity = new Date().toISOString();
    this._writeInboxSentinel(sessionId);
    this._broadcastClaudeSessions();
    return true;
  }

  _drainClaudeInbox(sessionId) {
    const queue = this.claudeInbox.get(sessionId) || [];
    this.claudeInbox.delete(sessionId);
    const s = this.claudeSessions.get(sessionId);
    if (s) s.lastActivity = new Date().toISOString();
    this._clearInboxSentinel(sessionId);
    if (queue.length) this._broadcastClaudeSessions();
    return queue;
  }

  // Sentinel file under <projectDir>/.continuum/.inbox-flag — lets the
  // continuum plugin's PreToolUse hook skip the HTTP round-trip when the
  // inbox is empty (which is essentially always). Best-effort; absence of
  // the sentinel doesn't break correctness, only speed.
  _writeInboxSentinel(sessionId) {
    const info = this.claudeSessions.get(sessionId);
    if (!info?.projectDir) return;
    try {
      const dir = path.join(info.projectDir, ".continuum");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".inbox-flag"), String(Date.now()));
    } catch {}
  }
  _clearInboxSentinel(sessionId) {
    const info = this.claudeSessions.get(sessionId);
    if (!info?.projectDir) return;
    try { fs.unlinkSync(path.join(info.projectDir, ".continuum", ".inbox-flag")); }
    catch {}
  }

  _listClaudeSessions() {
    // Filter out sessions whose lastActivity is older than CLAUDE_SESSION_TTL_MS
    // (default 10 min). This keeps the extension popup clean when SessionEnd
    // didn't run (terminal killed, OS crash, test that registered then died).
    // GC-on-read keeps the registry tidy without a background timer.
    const ttlMs = Number(process.env.CLAUDE_SESSION_TTL_MS || 600_000);
    const cutoff = Date.now() - ttlMs;
    const out = [];
    const stale = [];
    for (const [sessionId, info] of this.claudeSessions) {
      const last = Date.parse(info.lastActivity) || 0;
      if (last < cutoff) { stale.push(sessionId); continue; }
      const queue = this.claudeInbox.get(sessionId) || [];
      out.push({
        sessionId,
        name: info.name,
        projectDir: info.projectDir,
        registeredAt: info.registeredAt,
        lastActivity: info.lastActivity,
        queuedCount: queue.length,
      });
    }
    for (const id of stale) {
      this.claudeSessions.delete(id);
      this.claudeInbox.delete(id);
    }
    return out;
  }

  _broadcastClaudeSessions() {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) return;
    try {
      this.extensionWs.send(JSON.stringify({
        type: "claude_sessions_update",
        sessions: this._listClaudeSessions(),
      }));
    } catch {}
  }

  // ---------------------- HTTP routes (/claude/*) -------------------------

  _handleHttpRequest(req, res) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`); }
    catch { res.writeHead(400).end(); return; }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (!url.pathname.startsWith("/claude/")) {
      res.writeHead(404, { "Content-Type": "application/json" })
         .end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/claude/sessions") {
      this._respondJson(res, 200, { sessions: this._listClaudeSessions() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/claude/inbox") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return this._respondJson(res, 400, { error: "sessionId required" });
      this._respondJson(res, 200, { messages: this._drainClaudeInbox(sessionId) });
      return;
    }

    if (req.method !== "POST") {
      this._respondJson(res, 405, { error: "method not allowed" });
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { if ((body += c).length > 1024 * 256) { req.destroy(); } });
    req.on("end", () => {
      let json = {};
      if (body) {
        try { json = JSON.parse(body); }
        catch { return this._respondJson(res, 400, { error: "bad json" }); }
      }
      const p = url.pathname;
      if (p === "/claude/register") {
        const { sessionId, name, projectDir } = json;
        if (!sessionId) return this._respondJson(res, 400, { error: "sessionId required" });
        this._registerClaudeSession(sessionId, { name, projectDir });
        return this._respondJson(res, 200, { ok: true });
      }
      if (p === "/claude/unregister") {
        const { sessionId } = json;
        if (!sessionId) return this._respondJson(res, 400, { error: "sessionId required" });
        const had = this._unregisterClaudeSession(sessionId);
        return this._respondJson(res, had ? 200 : 404, { ok: had });
      }
      if (p === "/claude/rename") {
        const { sessionId, name } = json;
        if (!sessionId || !name) return this._respondJson(res, 400, { error: "sessionId and name required" });
        const ok = this._renameClaudeSession(sessionId, name);
        return this._respondJson(res, ok ? 200 : 404, { ok });
      }
      if (p === "/claude/inbox") {
        const { sessionId, message, context } = json;
        if (!sessionId || !message) return this._respondJson(res, 400, { error: "sessionId and message required" });
        const ok = this._pushClaudeMessage(sessionId, message, context);
        return this._respondJson(res, ok ? 200 : 404, { ok });
      }
      if (p === "/os/open-notification-settings") {
        // Best-effort deep-link to the macOS Notifications settings pane so a
        // non-technical user can enable Chrome's notifications in one click.
        if (process.platform !== "darwin") {
          return this._respondJson(res, 200, { ok: false, reason: "not-macos" });
        }
        try {
          exec('open "x-apple.systempreferences:com.apple.preference.notifications"');
          return this._respondJson(res, 200, { ok: true });
        } catch (e) {
          return this._respondJson(res, 200, { ok: false, reason: String(e?.message ?? e) });
        }
      }
      this._respondJson(res, 404, { error: "not found" });
    });
    req.on("error", () => { try { res.destroy(); } catch {} });
  }

  _respondJson(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  _onBrokerConnection(ws) {
    let identified = false;
    const helloTimer = setTimeout(() => {
      if (!identified) {
        try { ws.close(1002, "no hello"); } catch {}
      }
    }, HELLO_TIMEOUT_MS);

    ws.once("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { try { ws.close(); } catch {}; return; }
      identified = true;
      clearTimeout(helloTimer);

      if (msg.type === "hello" && msg.role === "extension") {
        this._attachExtension(ws);
      } else if (msg.type === "hello" && msg.role === "mcp-client") {
        const clientId = this._resolvePeerClientId(msg.clientId);
        this._attachMcpClient(ws, clientId);
      } else {
        try { ws.close(1002, "bad hello"); } catch {}
      }
    });
  }

  _attachExtension(ws) {
    // Multi-profile guard: only ONE extension is active at a time. Any extras
    // (typically from a second Chrome profile) become standbys — kept alive
    // on a parked socket, NOT pinged with commands, until the active one
    // disconnects or a standby explicitly requests takeover. This stops the
    // last-one-wins reconnect loop two extensions used to do.
    if (this.extensionWs && this.extensionWs !== ws) {
      this._attachExtensionStandby(ws);
      return;
    }
    this.extensionWs = ws;
    this.log("[bridge] extension connected (active)");
    this._wireExtensionMessages(ws);
    // Send the current Claude-session registry so the popup has data immediately.
    this._broadcastClaudeSessions();

    ws.on("close", () => {
      if (this.extensionWs !== ws) return;  // already replaced; nothing to do
      this.extensionWs = null;
      for (const [id, p] of this.extPending) {
        p.reject(new Error("extension disconnected mid-request"));
        this.extPending.delete(id);
      }
      this.log("[bridge] extension disconnected (active)");
      this._promoteNextStandbyIfAny();
    });
    ws.on("error", () => {});

    const waiters = this.extWaiters;
    this.extWaiters = [];
    for (const w of waiters) w.resolve();
  }

  _attachExtensionStandby(ws) {
    this.extensionStandbys.push(ws);
    this.log(`[bridge] extension connected (standby; ${this.extensionStandbys.length} waiting)`);
    try {
      ws.send(JSON.stringify({
        type: "standby",
        reason: "another Super-Tester extension (probably from a different Chrome profile) is currently active",
      }));
    } catch {}
    // Listen for the takeover request; ignore everything else.
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "request_takeover") this._handleTakeover(ws);
    });
    ws.on("close", () => {
      this.extensionStandbys = this.extensionStandbys.filter((s) => s !== ws);
      this.log(`[bridge] standby extension disconnected (${this.extensionStandbys.length} remaining)`);
    });
    ws.on("error", () => {});
  }

  _wireExtensionMessages(ws) {
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "hello") return;
      if (msg.type === "request_takeover") return;  // already active, no-op

      // Extension wants the current Claude-session registry list (e.g. popup just opened).
      if (msg.type === "get_claude_sessions") {
        try {
          ws.send(JSON.stringify({
            id: msg.id, ok: true,
            result: { sessions: this._listClaudeSessions() },
          }));
        } catch {}
        return;
      }
      // Extension is sending a hint into a Claude session's inbox.
      if (msg.type === "send_claude_message") {
        const ok = this._pushClaudeMessage(msg.sessionId, msg.message, msg.context);
        try {
          ws.send(JSON.stringify({
            id: msg.id, ok, error: ok ? null : "no such session",
          }));
        } catch {}
        return;
      }

      const { id, ok, result, error } = msg;
      const p = this.extPending.get(id);
      if (!p) return;
      this.extPending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error ?? "unknown extension error"));
    });
  }

  // A standby is asking to become active. Demote the current active to
  // standby (it stays connected, just stops receiving commands) and promote
  // the requester. In-flight commands targeting the demoted ws are rejected
  // so callers can retry against the new active.
  _handleTakeover(requestingWs) {
    if (!this.extensionStandbys.includes(requestingWs)) return;
    this.extensionStandbys = this.extensionStandbys.filter((s) => s !== requestingWs);

    const previouslyActive = this.extensionWs;
    if (previouslyActive && previouslyActive !== requestingWs) {
      try {
        previouslyActive.send(JSON.stringify({
          type: "standby",
          reason: "another Super-Tester profile requested takeover",
        }));
      } catch {}
      this.extensionStandbys.push(previouslyActive);
      previouslyActive.removeAllListeners("message");
      previouslyActive.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "request_takeover") this._handleTakeover(previouslyActive);
      });
      for (const [id, p] of this.extPending) {
        p.reject(new Error("active extension demoted to standby; please retry"));
        this.extPending.delete(id);
      }
    }

    this.extensionWs = requestingWs;
    requestingWs.removeAllListeners("message");
    this._wireExtensionMessages(requestingWs);
    // Send fresh state so the just-promoted extension's popup is current.
    this._broadcastClaudeSessions();
    requestingWs.removeAllListeners("close");
    requestingWs.on("close", () => {
      if (this.extensionWs !== requestingWs) return;
      this.extensionWs = null;
      for (const [id, p] of this.extPending) {
        p.reject(new Error("extension disconnected mid-request"));
        this.extPending.delete(id);
      }
      this.log("[bridge] extension disconnected (active)");
      this._promoteNextStandbyIfAny();
    });
    try { requestingWs.send(JSON.stringify({ type: "promoted" })); } catch {}
    this.log("[bridge] extension takeover: a standby was promoted to active");

    const waiters = this.extWaiters;
    this.extWaiters = [];
    for (const w of waiters) w.resolve();
  }

  _promoteNextStandbyIfAny() {
    const next = this.extensionStandbys.shift();
    if (!next) return;
    this.extensionWs = next;
    // Send fresh state so the newly-promoted extension's popup shows reality.
    this._broadcastClaudeSessions();
    next.removeAllListeners("message");
    this._wireExtensionMessages(next);
    next.removeAllListeners("close");
    next.on("close", () => {
      if (this.extensionWs !== next) return;
      this.extensionWs = null;
      for (const [id, p] of this.extPending) {
        p.reject(new Error("extension disconnected mid-request"));
        this.extPending.delete(id);
      }
      this.log("[bridge] extension disconnected (active)");
      this._promoteNextStandbyIfAny();
    });
    try { next.send(JSON.stringify({ type: "promoted" })); } catch {}
    this.log("[bridge] active extension dropped; auto-promoted a standby");

    const waiters = this.extWaiters;
    this.extWaiters = [];
    for (const w of waiters) w.resolve();
  }

  _attachMcpClient(ws, clientId) {
    const cleanupTimer = this.clientCleanupTimers.get(clientId);
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      this.clientCleanupTimers.delete(clientId);
    }
    this.mcpClients.set(clientId, ws);
    this.log(`[bridge] mcp-client connected (clientId=${clientId}, total=${this.mcpClients.size})`);
    try { ws.send(JSON.stringify({ type: "welcome", clientId })); } catch {}

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { id, type, params } = msg;
      if (id == null || !type) return;
      // A peer MCP wants us to forward this command to the extension.
      this._sendToExtension(type, params ?? {}, clientId)
        .then((result) => { try { ws.send(JSON.stringify({ id, ok: true, result })); } catch {} })
        .catch((e) => { try { ws.send(JSON.stringify({ id, ok: false, error: String(e?.message ?? e) })); } catch {} });
    });

    ws.on("close", () => {
      if (this.mcpClients.get(clientId) === ws) this.mcpClients.delete(clientId);
      this.log(`[bridge] mcp-client disconnected (clientId=${clientId})`);
      // Give a crashed/restarted MCP client a short window to reconnect with
      // the same clientId before we release its tab group.
      const timer = setTimeout(() => {
        this.clientCleanupTimers.delete(clientId);
        if (this.mcpClients.has(clientId)) return;
        this._sendToExtension("client_cleanup", {}, clientId).catch(() => {});
      }, CLIENT_CLEANUP_GRACE_MS);
      this.clientCleanupTimers.set(clientId, timer);
    });
    ws.on("error", () => {});
  }

  // --------- broker: send-to-extension primitive ---------
  async _sendToExtension(type, params, clientId) {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      // Wait briefly in case the extension is reconnecting.
      await this._waitForExtension(15000).catch(() => {
        throw new Error(
          "extension didn't connect within timeout — make sure the Super-Tester extension is loaded in Chrome and auto-connect is on"
        );
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.extPending.has(id)) {
          this.extPending.delete(id);
          reject(new Error(`extension request timeout (${type})`));
        }
      }, this.requestTimeoutMs);
      this.extPending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.extensionWs.send(JSON.stringify({ id, type, params, clientId }));
      } catch (e) {
        this.extPending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _waitForExtension(timeoutMs) {
    if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onResolve = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const i = this.extWaiters.findIndex((w) => w.resolve === onResolve);
        if (i !== -1) this.extWaiters.splice(i, 1);
        reject(new Error("extension wait timeout"));
      }, timeoutMs);
      this.extWaiters.push({ resolve: onResolve });
    });
  }

  // ---------------- CLIENT ----------------

  _becomeClient(port, host) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        resolve();
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        reject(error);
      };

      this.mode = "client";
      const ws = new WebSocket(`ws://${host}:${port}`);
      this.brokerWs = ws;

      ws.on("open", () => {
        try {
          ws.send(JSON.stringify({
            type: "hello",
            role: "mcp-client",
            clientId: this.localClientId ?? undefined,
          }));
        } catch {}
      });

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "welcome") {
          this.localClientId = msg.clientId;
          this.log(`[bridge] client mode (clientId=${this.localClientId})`);
          // Wake any waiters.
          const waiters = this.brokerWaiters; this.brokerWaiters = [];
          for (const w of waiters) w.resolve();
          settleResolve();
          return;
        }
        const { id, ok, result, error } = msg;
        const p = this.brokerPending.get(id);
        if (!p) return;
        this.brokerPending.delete(id);
        if (ok) p.resolve(result);
        else p.reject(new Error(error ?? "broker error"));
      });

      ws.on("close", () => {
        if (this.brokerWs === ws) this.brokerWs = null;
        this._rejectBrokerPending("broker connection lost mid-request");
        this.log("[bridge] broker connection closed");
        if (!settled) settleReject(new Error("broker connection closed before welcome"));
        if (!this.closed) this._startClientRecovery().catch((e) => {
          this.lastError = e.message;
          this.log(`[bridge] client recovery failed: ${e.message}`);
        });
      });

      ws.on("error", (e) => {
        this.lastError = e.message;
        if (!settled) settleReject(new Error(`could not connect to broker: ${e.message}`));
      });

      // Failsafe — if welcome never arrives.
      const welcomeTimer = setTimeout(() => {
        if (!settled) settleReject(new Error(`no welcome from broker within ${CLIENT_CONNECT_TIMEOUT_MS}ms`));
        try { ws.close(); } catch {}
      }, CLIENT_CONNECT_TIMEOUT_MS);
    });
  }

  // --------- public API used by tools.js ---------

  // Send a tool command. In broker mode, this goes straight to the extension
  // tagged with our own clientId. In client mode, it goes to the broker which
  // tags and forwards.
  async send(type, params = {}) {
    if (this.mode === "broker") {
      return this._sendToExtension(type, params, this.localClientId);
    }
    if (this.mode === "client") {
      await this._withTimeout(
        this._ensureClientTransport(),
        this.requestTimeoutMs,
        "broker connection not ready"
      );
      if (this.mode === "broker") return this._sendToExtension(type, params, this.localClientId);
      return this._sendToBroker(type, params);
    }
    throw new Error("bridge not started");
  }

  isConnected() {
    if (this.mode === "broker") return !!this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN;
    if (this.mode === "client") return !!this.brokerWs && this.brokerWs.readyState === WebSocket.OPEN && !!this.localClientId;
    return false;
  }

  // Wait until we can serve a request (extension connected if broker, broker
  // connected if client). The MCP server's first tool call uses this.
  async waitForConnection(timeoutMs = 15000) {
    if (this.mode === "broker") {
      if (this.isConnected()) return;
      return this._waitForExtension(timeoutMs).catch(() => {
        throw new Error(
          "extension didn't connect within timeout — make sure the Super-Tester extension is loaded in Chrome and auto-connect is on"
        );
      });
    }
    if (this.mode === "client") {
      if (this.isConnected() && this.localClientId) return;
      await this._withTimeout(
        this._ensureClientTransport(),
        timeoutMs,
        "broker connection wait timeout"
      );
      if (this.mode === "broker") return this.waitForConnection(timeoutMs);
      return;
    }
    throw new Error("bridge not started");
  }

  // What clientId we appear as to the extension (used by tests + diagnostics).
  getLocalClientId() { return this.localClientId; }

  getStatus() {
    return {
      mode: this.mode ?? "uninitialized",
      connected: this.isConnected(),
      clientId: this.localClientId ?? null,
      mcpPeerCount: this.mode === "broker" ? this.mcpClients.size : null,
      recovering: !!this.recoveryPromise,
      recoveryAttempts: this.recoveryAttempts,
      lastRecoveryAt: this.lastRecoveryAt,
      lastError: this.lastError,
    };
  }

  async cleanupLocalSession() {
    if (!this.localClientId) return { cleaned: false, reason: "no-client-id" };
    try {
      if (this.mode === "broker") {
        if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
          return { cleaned: false, reason: "extension-not-connected" };
        }
        return await this._sendToExtension("client_cleanup", {}, this.localClientId);
      }
      if (this.mode === "client") {
        if (!this.brokerWs || this.brokerWs.readyState !== WebSocket.OPEN) {
          return { cleaned: false, reason: "broker-not-connected" };
        }
        return await this._sendToBroker("client_cleanup", {});
      }
    } catch (e) {
      return { cleaned: false, reason: String(e?.message ?? e) };
    }
    return { cleaned: false, reason: "bridge-not-started" };
  }

  shutdown() {
    this.closed = true;
    this._rejectBrokerPending("bridge shutting down");
    this._rejectBrokerWaiters("bridge shutting down");
    try { this.wss?.close(); } catch {}
    try { this.httpServer?.close(); } catch {}
    try { this.extensionWs?.close(); } catch {}
    try { this.brokerWs?.close(); } catch {}
    for (const ws of this.mcpClients.values()) try { ws.close(); } catch {}
    for (const timer of this.clientCleanupTimers.values()) clearTimeout(timer);
    this.clientCleanupTimers.clear();
  }

  _mintClientId(prefix = "c") {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    return `mc-${prefix}-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  _resolvePeerClientId(requested) {
    if (this._isUsableClientId(requested) && requested !== this.localClientId) {
      const existing = this.mcpClients.get(requested);
      if (existing && existing.readyState === WebSocket.OPEN) {
        // Same client process reconnected before the old socket's close
        // event fired (reconnect storm / settings reload). Kick the old
        // socket so we don't accumulate duplicate peers — that's the 1↔2
        // mcpPeerCount flapping in the wild.
        this.log(`[bridge] replacing stale mcp-client ws for clientId=${requested}`);
        try { existing.close(1000, "replaced by new connection"); } catch {}
      }
      this.mcpClients.delete(requested);
      return requested;
    }
    return this._mintClientId("c");
  }

  _isUsableClientId(value) {
    return typeof value === "string" &&
      /^[A-Za-z0-9_-]{4,96}$/.test(value) &&
      value.startsWith("mc-");
  }

  _sendToBroker(type, params) {
    if (!this.brokerWs || this.brokerWs.readyState !== WebSocket.OPEN) {
      throw new Error("broker connection not ready");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.brokerPending.has(id)) {
          this.brokerPending.delete(id);
          reject(new Error(`broker request timeout (${type})`));
        }
      }, this.requestTimeoutMs);
      this.brokerPending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.brokerWs.send(JSON.stringify({ id, type, params }));
      } catch (e) {
        this.brokerPending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  async _ensureClientTransport() {
    if (this.mode !== "client") return;
    if (this.brokerWs?.readyState === WebSocket.OPEN && this.localClientId) return;
    await this._startClientRecovery();
  }

  _startClientRecovery() {
    if (this.closed) return Promise.reject(new Error("bridge is shutting down"));
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this._recoverClientConnection()
      .finally(() => { this.recoveryPromise = null; });
    return this.recoveryPromise;
  }

  async _recoverClientConnection() {
    if (this.port == null || !this.host) {
      throw new Error("cannot recover broker connection before bridge.start()");
    }

    let delayMs = 100;
    while (!this.closed) {
      this.recoveryAttempts += 1;
      await this._sleep(delayMs);

      const role = await this._tryBecomeBroker(this.port, this.host, {
        preserveLocalClientId: true,
      });
      if (role === "broker") {
        this.lastRecoveryAt = new Date().toISOString();
        this.recoveryAttempts = 0;
        const waiters = this.brokerWaiters;
        this.brokerWaiters = [];
        for (const w of waiters) w.resolve();
        this.log(`[bridge] client promoted to broker (clientId=${this.localClientId})`);
        return "broker";
      }

      try {
        await this._becomeClient(this.port, this.host);
        this.lastRecoveryAt = new Date().toISOString();
        this.recoveryAttempts = 0;
        return "client";
      } catch (e) {
        this.lastError = e.message;
        this.log(`[bridge] broker reconnect attempt failed: ${e.message}`);
        delayMs = Math.min(delayMs * 2, CLIENT_RECOVERY_MAX_DELAY_MS);
      }
    }
    throw new Error("bridge is shutting down");
  }

  _rejectBrokerPending(reason) {
    for (const [id, p] of this.brokerPending) {
      p.reject(new Error(reason));
      this.brokerPending.delete(id);
    }
  }

  _rejectBrokerWaiters(reason) {
    const waiters = this.brokerWaiters;
    this.brokerWaiters = [];
    for (const w of waiters) {
      if (w.reject) w.reject(new Error(reason));
      else w.resolve();
    }
  }

  _withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

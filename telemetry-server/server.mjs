// telemetry-server/server.mjs
// Mochi Insight Zone-A ingest + owner dashboard. Node 22, built-in http only.
// SECURITY SPINE: every ingested event is re-redacted SERVER-SIDE (defense in
// depth, §13.1/§13.5) before any write — a tampered client cannot inject
// content. No static /data serving; no directory listing; /v1/health -> "ok".
import http from "node:http";
import { redactEvent, redactDistillation } from "./telemetry_redact.js";
import { appendEvents, readAllEvents, eraseIid, sweepRetention } from "./store.mjs";
import { aggregate } from "./aggregate.mjs";
import { renderDashboard } from "./dashboard.mjs";
import { checkWriteKey, checkOwner, TokenBucket } from "./auth.mjs";

const MAX_BODY = 256 * 1024;   // cap request body (anti-DoS)
const MAX_BATCH = 500;          // cap events per POST

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
};
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8" });

export function createServer(env = process.env) {
  const dataDir = env.DATA_DIR || "/data";
  const retentionDays = Number(env.RETENTION_DAYS) || 180;

  const perIp = new TokenBucket({ capacity: 120, refillPerSec: 2 });
  const global = new TokenBucket({ capacity: 10000, refillPerSec: 50 });

  const server = http.createServer(async (req, res) => {
    try {
      let url;
      try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, "bad request"); }
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/v1/health") return send(res, 200, "ok");

      if (req.method === "POST" && pathname === "/v1/ingest") {
        if (!checkWriteKey(req.headers, env.INGEST_WRITE_KEY)) return send(res, 401, "unauthorized");
        const ip = clientIp(req);
        if (!global.take("*") || !perIp.take(ip)) return send(res, 429, "rate limited");
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, "bad body"); }
        const batch = Array.isArray(payload?.batch) ? payload.batch.slice(0, MAX_BATCH) : [];
        const clean = [];
        for (const raw of batch) {
          if (raw && raw.kind === "distill") {
            const d = redactDistillation(raw);
            if (d) clean.push({ kind: "distill", ...d });
          } else {
            const e = redactEvent(raw);
            if (e) clean.push(e);
          }
        }
        if (clean.length) appendEvents(dataDir, clean);
        return sendJson(res, 200, { ok: true, stored: clean.length });
      }

      // owner-only routes
      if (pathname === "/dashboard" || pathname === "/v1/summary" || pathname === "/v1/data") {
        if (!checkOwner(req.headers, env)) {
          return send(res, 401, "unauthorized", { "www-authenticate": 'Basic realm="mochi-insight"' });
        }
      }

      if (req.method === "GET" && pathname === "/dashboard") {
        const html = renderDashboard(aggregate(readAllEvents(dataDir)));
        return send(res, 200, html, { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" });
      }
      if (req.method === "GET" && pathname === "/v1/summary") {
        return sendJson(res, 200, aggregate(readAllEvents(dataDir)));
      }
      if (req.method === "DELETE" && pathname === "/v1/data") {
        const iid = url.searchParams.get("iid");
        if (!iid) return send(res, 400, "iid required");
        return sendJson(res, 200, { ok: true, removed: eraseIid(dataDir, iid) });
      }

      return send(res, 404, "not found"); // no static serving, no listing
    } catch (err) {
      console.error("[mochi-insight] handler error:", err);
      if (!res.headersSent) send(res, 500, "internal server error");
    }
  });

  // Retention sweep on boot + daily. unref so it never holds the process open in tests.
  const sweep = () => { try { sweepRetention(dataDir, retentionDays); } catch { /* ignore */ } };
  sweep();
  const timer = setInterval(sweep, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();

  return server;
}

// Boot when run directly (npm start / Docker CMD).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  createServer(process.env).listen(port, () => console.log(`[mochi-insight] listening on :${port}`));
}

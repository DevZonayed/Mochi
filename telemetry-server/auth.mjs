// telemetry-server/auth.mjs
// Soft write-key gate + owner auth (constant-time, §13.5) + token-bucket limiter.
import crypto from "node:crypto";

// Length-safe constant-time string compare. We hash both sides to a fixed
// length first (timingSafeEqual throws on length mismatch), then also require
// equal raw lengths.
export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export function checkWriteKey(headers, serverKey) {
  if (!serverKey) return false; // fail-closed when unset
  const got = headers["x-mochi-key"];
  if (typeof got !== "string") return false;
  return timingSafeEqualStr(got, serverKey);
}

export function checkOwner(headers, env) {
  const pass = env.DASHBOARD_PASS;
  if (!pass) return false; // fail-closed
  const auth = headers.authorization;
  if (typeof auth !== "string") return false;
  if (auth.startsWith("Bearer ")) {
    return timingSafeEqualStr(auth.slice(7), pass);
  }
  if (auth.startsWith("Basic ")) {
    let decoded = "";
    try { decoded = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch { return false; }
    const idx = decoded.indexOf(":");
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pw = decoded.slice(idx + 1);
    const userOk = env.DASHBOARD_USER ? timingSafeEqualStr(user, env.DASHBOARD_USER) : true;
    const passOk = timingSafeEqualStr(pw, pass);
    return userOk && passOk;
  }
  return false;
}

// Per-key token bucket. One instance keyed by IP (per-IP) + a second keyed by
// "*" for a single global cap (§13.5: iids are forgeable, IPs aren't, and a
// global cap bounds total damage).
export class TokenBucket {
  constructor({ capacity, refillPerSec, now = () => Date.now() }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map();
  }
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: t }; this.buckets.set(key, b); }
    const elapsedSec = (t - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = t;
    if (b.tokens >= cost) { b.tokens -= cost; return true; }
    return false;
  }
}

// Zone-A telemetry emission. The GATED boundary: capture-to-local is always
// allowed, but emission only happens here and only when sharing is enabled,
// RE-CHECKED on every flush (spec §13.3 / §6). Fail-open: any error is
// swallowed so telemetry can never break a user's session. No LLM, off the
// hot path (called at session end / opportunistically, never in PreToolUse).
//
// flush(projectDir, env, deps):
//   deps.fetch  — injected fetch (defaults to global fetch) so tests mock it.
//   Re-reads config + env, gates on isSharingEnabled. If disabled → ZERO POST.

import fs from "node:fs";
import { readConfig, isSharingEnabled, INGEST_URL, INGEST_WRITE_KEY } from "./telemetry_config.js";
import { redactEvent } from "./telemetry_redact.js";
import { readEvents } from "./telemetry_log.js";
import { telemetryQueuePath, telemetryDir } from "./paths.js";

export const FETCH_TIMEOUT_MS = 4000;
export const MAX_QUEUE_BATCHES = 50;   // cap offline queue (drop oldest beyond)
export const MAX_BATCH_EVENTS = 500;   // cap a single POST body

// readQueue / writeQueue: unsent batches persist one-JSON-array-per-line.
function readQueue(projectDir) {
  const p = telemetryQueuePath(projectDir);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function writeQueue(projectDir, batches) {
  try {
    fs.mkdirSync(telemetryDir(projectDir), { recursive: true });
    const capped = batches.slice(-MAX_QUEUE_BATCHES); // keep newest
    fs.writeFileSync(telemetryQueuePath(projectDir), capped.map((b) => JSON.stringify(b)).join("\n") + (capped.length ? "\n" : ""));
  } catch { /* fail-open */ }
}

// POST one batch with a short timeout. Returns true on 2xx, false otherwise
// (including timeout / network error). NEVER throws (fail-open).
async function postBatch(fetchFn, iid, batch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mochi-key": INGEST_WRITE_KEY },
      body: JSON.stringify({ iid, batch }),
      signal: ctrl.signal,
    });
    return !!(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function flush(projectDir, env = process.env, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  try {
    // RE-CHECK consent at SEND time (the gated boundary). Absence ⇒ no send.
    const cfg = readConfig(projectDir);
    if (!isSharingEnabled(cfg, env)) return { sent: 0, queued: 0, skipped: true };

    // Re-redact every event through the whitelist serializer (defense in depth;
    // the SAME serializer used by /mochi:telemetry show).
    const fresh = readEvents(projectDir).map(redactEvent).filter(Boolean);
    const queued = readQueue(projectDir); // arrays of already-redacted events
    const iid = cfg.iid || (fresh[0] && fresh[0].iid) || (queued[0] && queued[0][0] && queued[0][0].iid) || "";

    // Build batches: each queued batch + one new-events batch (capped).
    const batches = [...queued];
    for (let i = 0; i < fresh.length; i += MAX_BATCH_EVENTS) {
      batches.push(fresh.slice(i, i + MAX_BATCH_EVENTS));
    }
    if (batches.length === 0) return { sent: 0, queued: 0, skipped: false };

    let sent = 0;
    const unsent = [];
    for (const batch of batches) {
      const okPost = await postBatch(fetchFn, iid, batch);
      if (okPost) sent++; else unsent.push(batch);
    }
    // Persist whatever failed for next-flush retry (capped). On full success
    // the queue is cleared.
    writeQueue(projectDir, unsent);
    return { sent, queued: unsent.length, skipped: false };
  } catch {
    return { sent: 0, queued: 0, skipped: false }; // fail-open
  }
}

// Zone-A telemetry emission. The GATED boundary: capture-to-local is always
// allowed, but emission only happens here and only when sharing is enabled,
// RE-CHECKED on every flush (spec §13.3 / §6). Fail-open: any error is
// swallowed so telemetry can never break a user's session. No LLM, off the
// hot path (called at session end / opportunistically, never in PreToolUse).
//
// flush(projectDir, env, deps):
//   deps.fetch  — injected fetch (defaults to global fetch) so tests mock it.
//   Re-reads config + env, gates on isSharingEnabled. If disabled → ZERO POST.
//
// SENT-WATERMARK (dedup guard):
//   flush() persists the last-attempted line offset in flush-watermark.json
//   so that consecutive flushes only POST genuinely new events. Without this,
//   every flush would re-POST the entire events.jsonl (pruned at 5000 lines /
//   180 days), inflating every server-side aggregate.
//   The watermark advances past ALL fresh events that were ATTEMPTED — including
//   those whose POST failed. Failed batches are placed in the retry queue instead;
//   this prevents double-sending (once as fresh + once as queued) on the next flush.
//   Queued-retry batches are already a separate list and are unaffected.

import fs from "node:fs";
import { readConfig, isSharingEnabled, INGEST_URL, INGEST_WRITE_KEY } from "./telemetry_config.js";
import { redactEvent } from "./telemetry_redact.js";
import { readEvents } from "./telemetry_log.js";
import { telemetryQueuePath, telemetryWatermarkPath, telemetryDir } from "./paths.js";

export const FETCH_TIMEOUT_MS = 4000;
export const MAX_QUEUE_BATCHES = 50;   // cap offline queue (drop oldest beyond)
export const MAX_BATCH_EVENTS = 500;   // cap a single POST body

// readWatermark / writeWatermark: persist the last-flushed line count so
// consecutive flushes only POST events that are NEW since the last success.
// Returns 0 (send everything) when the file is absent or corrupt.
function readWatermark(projectDir) {
  const p = telemetryWatermarkPath(projectDir);
  if (!fs.existsSync(p)) return 0;
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return (obj && typeof obj.flushedLines === "number") ? obj.flushedLines : 0;
  } catch { return 0; }
}
function writeWatermark(projectDir, flushedLines) {
  try {
    fs.mkdirSync(telemetryDir(projectDir), { recursive: true });
    fs.writeFileSync(telemetryWatermarkPath(projectDir), JSON.stringify({ flushedLines }) + "\n");
  } catch { /* fail-open */ }
}

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

    // Read ALL events, then slice off the already-sent prefix via the watermark.
    // The watermark tracks how many lines were successfully flushed in the last
    // flush() call — so only genuinely new events are POSTed, preventing the
    // same events from being re-sent on every session_end flush (§13 dedup guard).
    const allEvents = readEvents(projectDir);
    const watermark = readWatermark(projectDir);
    // Re-redact every fresh event through the whitelist serializer (defense in
    // depth; the SAME serializer used by /mochi:telemetry show).
    const fresh = allEvents.slice(watermark).map(redactEvent).filter(Boolean);

    const queued = readQueue(projectDir); // arrays of already-redacted events
    const iid = cfg.iid || (fresh[0] && fresh[0].iid) || (queued[0] && queued[0][0] && queued[0][0].iid) || "";

    // Build batches: each queued batch + one new-events batch (capped).
    const batches = [...queued];
    const freshBatchStart = batches.length; // index of the first fresh batch
    for (let i = 0; i < fresh.length; i += MAX_BATCH_EVENTS) {
      batches.push(fresh.slice(i, i + MAX_BATCH_EVENTS));
    }
    if (batches.length === 0) return { sent: 0, queued: 0, skipped: false };

    let sent = 0;
    const unsent = [];
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const okPost = await postBatch(fetchFn, iid, batch);
      if (okPost) {
        sent++;
      } else {
        unsent.push(batch);
      }
    }
    // Persist whatever failed for next-flush retry (capped). On full success
    // the queue is cleared.
    writeQueue(projectDir, unsent);
    // Advance the watermark past ALL fresh events that were ATTEMPTED (not just
    // the ones that succeeded). Failed fresh batches are placed in the queue for
    // retry — advancing the watermark ensures they are NOT re-included as "fresh"
    // on the next flush (which would double-send them: once fresh + once queued).
    // The queue is the sole retry path for failed batches.
    if (fresh.length > 0) {
      writeWatermark(projectDir, watermark + fresh.length);
    }
    return { sent, queued: unsent.length, skipped: false };
  } catch {
    return { sent: 0, queued: 0, skipped: false }; // fail-open
  }
}

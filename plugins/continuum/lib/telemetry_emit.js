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
//   flush() persists the identity of the last-attempted event (ts+sid) AND the
//   absolute count of events attempted (flushedCount) in flush-watermark.json so
//   that consecutive flushes only POST genuinely new events.
//
//   resolveWatermarkOffset uses a two-step strategy to handle the ts:sid collision
//   case (two or more events with identical ts AND sid — realistic for rapid
//   Read/Grep/click bursts within the same second):
//
//     1. FAST PATH: if allEvents[flushedCount-1] matches lastKey, the count
//        unambiguously identifies the exact anchor position even when multiple
//        events share the same ts:sid.  Returns flushedCount directly (O(1)).
//
//     2. PRUNE FALLBACK: if flushedCount points past the end or the key there
//        does not match (pruneEvents() rewrote the file), search backwards from
//        min(flushedCount-1, length-1) for the first match — this still produces
//        a correct slice in the no-collision case, and for the collision case the
//        anchor is searched from the right position in the post-prune file.
//        If no match is found at all, fall back to 0 (send all; server dedupes).
//
//   Using an event-identity anchor (rather than a raw line offset) makes the
//   watermark stable across pruneEvents() rewrites: even after events.jsonl is
//   compacted, we can still find the last-sent event by its ts+sid and slice
//   correctly. If the anchor event is no longer present after a prune (it aged
//   out or was dropped), we fall back to sending everything (safe — server
//   deduplicates by event identity).
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

// eventKey — a stable per-event identity string built from ts + sid.
// pruneEvents() may rewrite events.jsonl dropping old events, so we cannot use
// a raw line offset as an anchor. The key is used alongside flushedCount (the
// absolute event count at flush time) to disambiguate collisions where multiple
// events share the same ts AND sid (e.g. rapid bursts within a single second).
function eventKey(ev) {
  return (ev && ev.ts != null && ev.sid != null) ? `${ev.ts}:${ev.sid}` : null;
}

// readWatermark — returns the { lastKey, flushedCount } persisted by the
// last flush, or { lastKey: null, flushedCount: 0 } when absent/corrupt.
// `lastKey`     — ts:sid of the last event that was included in an attempted flush.
// `flushedCount`— ABSOLUTE number of events that had been attempted at watermark
//                 write time. Used as the primary position anchor; lastKey is the
//                 collision-safe confirmation check and prune-fallback key.
// Legacy files that only have `flushedLines` (pre-identity watermark) are
// treated as absent so the next flush re-sends everything (safe; server dedupes).
function readWatermark(projectDir) {
  const p = telemetryWatermarkPath(projectDir);
  if (!fs.existsSync(p)) return { lastKey: null, flushedCount: 0 };
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (obj && typeof obj.lastKey === "string") {
      return { lastKey: obj.lastKey, flushedCount: obj.flushedCount || 0 };
    }
    return { lastKey: null, flushedCount: 0 };
  } catch { return { lastKey: null, flushedCount: 0 }; }
}

function writeWatermark(projectDir, lastKey, flushedCount) {
  try {
    fs.mkdirSync(telemetryDir(projectDir), { recursive: true });
    fs.writeFileSync(telemetryWatermarkPath(projectDir), JSON.stringify({ lastKey, flushedCount }) + "\n");
  } catch { /* fail-open */ }
}

// resolveWatermarkOffset — find the index AFTER the last-sent event in allEvents.
// Uses a two-step strategy to correctly handle ts:sid collisions:
//
//   FAST PATH: allEvents[flushedCount-1] is the exact anchor when its key matches
//   lastKey. This is O(1) and correctly handles the collision case where multiple
//   events share the same ts:sid — the count pin-points the right occurrence.
//
//   PRUNE FALLBACK: when flushedCount overshoots the post-prune array length, or
//   the key there doesn't match (a different event now occupies that slot after a
//   prune rewrite), search backward from min(flushedCount-1, length-1) for the
//   last matching key. This covers the prune-offset scenario. If no match is
//   found (anchor was pruned out entirely), fall back to 0 (re-send all; safe,
//   server deduplicates by event identity).
function resolveWatermarkOffset(allEvents, watermark) {
  if (!watermark.lastKey) return 0;
  const len = allEvents.length;

  // Fast path: flushedCount is the absolute event count written at watermark time.
  // allEvents[flushedCount-1] is the anchor event when present and key-matching.
  const pinIdx = watermark.flushedCount - 1;
  if (pinIdx >= 0 && pinIdx < len && eventKey(allEvents[pinIdx]) === watermark.lastKey) {
    return watermark.flushedCount; // exact, O(1)
  }

  // Prune fallback: search backward from min(pinIdx, last) for the anchor key.
  // For the no-collision case this finds the correct single occurrence.
  // For the post-prune case the file is shorter and the anchor may be at a
  // different absolute index — still the rightmost match is the right anchor.
  const startIdx = Math.min(pinIdx >= 0 ? pinIdx : len - 1, len - 1);
  for (let i = startIdx; i >= 0; i--) {
    if (eventKey(allEvents[i]) === watermark.lastKey) {
      return i + 1; // slice from the event AFTER the anchor
    }
  }
  // Anchor not found — prune removed it. Fall back to sending everything.
  return 0;
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

    // Read ALL events, resolve the watermark to an offset that survives pruneEvents()
    // rewrites, then slice off the already-sent prefix.
    // Identity-keyed watermark: we search for the last-sent event by ts:sid rather
    // than relying on a raw line count that becomes stale after prune truncates the
    // file (quality-review finding #1).
    const allEvents = readEvents(projectDir);
    const watermark = readWatermark(projectDir);
    const offset = resolveWatermarkOffset(allEvents, watermark);
    // Re-redact every fresh event through the whitelist serializer (defense in
    // depth; the SAME serializer used by /mochi:telemetry show).
    const fresh = allEvents.slice(offset).map(redactEvent).filter(Boolean);
    // Keep a reference to the last RAW event (pre-redact) so we can record its
    // ts:sid as the new watermark anchor.
    const lastFreshRaw = fresh.length > 0 ? allEvents[offset + fresh.length - 1] : null;

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
    // We record the ts:sid of the last fresh event as the new anchor so the
    // watermark remains correct even after pruneEvents() rewrites events.jsonl.
    if (lastFreshRaw) {
      const newKey = eventKey(lastFreshRaw);
      if (newKey) writeWatermark(projectDir, newKey, offset + fresh.length);
    }
    return { sent, queued: unsent.length, skipped: false };
  } catch {
    return { sent: 0, queued: 0, skipped: false }; // fail-open
  }
}

// Unit tests for lib/telemetry_emit.js — Zone-A batch emission.
// Dependency-free. Every fetch is a MOCK injected via deps.fetch — no network.
//   Usage: node plugins/continuum/tests/run-telemetry-emit.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const { flush, MAX_QUEUE_BATCHES } = await import(path.join(PLUGIN_DIR, "lib/telemetry_emit.js"));
const { writeConfig, INGEST_URL, INGEST_WRITE_KEY } = await import(path.join(PLUGIN_DIR, "lib/telemetry_config.js"));
const { telemetryEventsPath, telemetryDir, telemetryQueuePath, telemetryWatermarkPath } = await import(path.join(PLUGIN_DIR, "lib/paths.js"));

let pass = 0, fail = 0;
const ok  = (m) => { console.log("  ✓", m); pass++; };
const bad = (m, e) => { console.log("  ✗", m, e ? "\n    " + (e.stack || e.message || e) : ""); fail++; };

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "telem-emit-"));
  fs.mkdirSync(telemetryDir(d), { recursive: true });
  return d;
}
// A mock fetch that records every call and returns a configurable response.
function mockFetch({ status = 200, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok: status >= 200 && status < 300, status, async text() { return "ok"; } };
  };
  fn.calls = calls;
  return fn;
}
// One valid Zone-A event line (already-redacted shape per §13).
const EV = { ts: 1717900000, sid: "s1", iid: "i1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", dur_b: "1-3s", v: "0.7.0", os: "darwin" };
function writeEvents(dir, evs) {
  fs.writeFileSync(telemetryEventsPath(dir), evs.map((e) => JSON.stringify(e)).join("\n") + (evs.length ? "\n" : ""));
}

// E1: OPTED OUT → zero POSTs. share=true but MOCHI_TELEMETRY=off ⇒ no send (§13.3).
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, reviewAuto: false, killSwitch: "on", sampleN: 1 });
  writeEvents(dir, [EV]);
  const f = mockFetch();
  await flush(dir, { MOCHI_TELEMETRY: "off" }, { fetch: f });
  assert.equal(f.calls.length, 0, "expected zero POSTs when opted out");
  ok("opted-out (env kill) ⇒ zero POST");
} catch (e) { bad("opted-out (env kill) ⇒ zero POST", e); }

// E2: never decided / share absent → zero POSTs (absence = no send, §13.3).
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: false }); // no share key at all
  writeEvents(dir, [EV]);
  const f = mockFetch();
  await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 0, "absence of share ⇒ no send");
  ok("share absent ⇒ zero POST");
} catch (e) { bad("share absent ⇒ zero POST", e); }

// E3: killSwitch === "off" → zero POSTs even if share=true and env clean.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "off", sampleN: 1 });
  writeEvents(dir, [EV]);
  const f = mockFetch();
  await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 0, "killSwitch off ⇒ no send");
  ok("killSwitch off ⇒ zero POST");
} catch (e) { bad("killSwitch off ⇒ zero POST", e); }

// E4: OPTED IN, clean env → POSTs once with correct URL, header, body shape.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", sampleN: 1, iid: "iid-xyz" });
  writeEvents(dir, [EV, { ...EV, ts: EV.ts + 5, tool: "browser_type" }]);
  const f = mockFetch({ status: 200 });
  const r = await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 1, "exactly one POST for one batch");
  const c = f.calls[0];
  assert.equal(c.url, INGEST_URL, "POSTs to INGEST_URL");
  assert.equal(c.opts.method, "POST");
  assert.equal(c.opts.headers["x-mochi-key"], INGEST_WRITE_KEY, "carries x-mochi-key header");
  const body = JSON.parse(c.opts.body);
  assert.equal(body.iid, "iid-xyz", "body.iid set");
  assert.ok(Array.isArray(body.batch) && body.batch.length === 2, "body.batch holds both events");
  assert.deepEqual(Object.keys(body.batch[0]).sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"], "Zone-A keys only");
  assert.equal(r.sent, 1);
  ok("opted-in ⇒ one POST, INGEST_URL + x-mochi-key + {iid,batch} body");
} catch (e) { bad("opted-in POST shape", e); }

// E5: short timeout — fetch wired with an AbortController signal.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  writeEvents(dir, [EV]);
  const f = mockFetch({ status: 200 });
  await flush(dir, {}, { fetch: f });
  assert.ok(f.calls[0].opts.signal, "fetch called with an abort signal (short timeout)");
  ok("fetch invoked with an AbortController signal");
} catch (e) { bad("fetch timeout signal", e); }

// E6: FAIL-OPEN — fetch throws ⇒ flush does NOT throw, returns, queues unsent.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  writeEvents(dir, [EV]);
  const f = mockFetch({ throwErr: new Error("ECONNREFUSED") });
  let threw = false; let r;
  try { r = await flush(dir, {}, { fetch: f }); } catch { threw = true; }
  assert.equal(threw, false, "flush must swallow fetch errors (fail-open)");
  assert.equal(r.sent, 0, "nothing counted as sent on failure");
  const q = fs.readFileSync(telemetryQueuePath(dir), "utf8").split("\n").filter(Boolean);
  assert.equal(q.length, 1, "failed batch persisted to queue");
  ok("fetch throws ⇒ fail-open + unsent batch queued");
} catch (e) { bad("fail-open + queue", e); }

// E7: RETRY — a queued batch from a prior flush is re-sent on the next flush.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  writeEvents(dir, []); // no new events this time
  fs.writeFileSync(telemetryQueuePath(dir), JSON.stringify([EV]) + "\n");
  const f = mockFetch({ status: 200 });
  const r = await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 1, "queued batch re-POSTed");
  assert.equal(r.sent, 1);
  const q = fs.existsSync(telemetryQueuePath(dir)) ? fs.readFileSync(telemetryQueuePath(dir), "utf8").split("\n").filter(Boolean) : [];
  assert.equal(q.length, 0, "queue cleared after successful retry");
  ok("queued batch retried + cleared on success");
} catch (e) { bad("retry queued batch", e); }

// E8: CAP — queue never grows past MAX_QUEUE_BATCHES; oldest dropped.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  const seed = Array.from({ length: MAX_QUEUE_BATCHES }, (_, i) => [{ ...EV, ts: EV.ts + i }]);
  fs.writeFileSync(telemetryQueuePath(dir), seed.map((b) => JSON.stringify(b)).join("\n") + "\n");
  writeEvents(dir, [{ ...EV, ts: 9999999999, tool: "browser_wait" }]);
  const f = mockFetch({ throwErr: new Error("down") });
  await flush(dir, {}, { fetch: f });
  const q = fs.readFileSync(telemetryQueuePath(dir), "utf8").split("\n").filter(Boolean);
  assert.ok(q.length <= MAX_QUEUE_BATCHES, `queue capped at ${MAX_QUEUE_BATCHES}, got ${q.length}`);
  const last = JSON.parse(q[q.length - 1]);
  assert.equal(last[0].tool, "browser_wait", "newest failed batch retained after cap");
  ok("offline queue capped (oldest dropped, newest kept)");
} catch (e) { bad("queue cap", e); }

// E9: WATERMARK — second flush of unchanged events sends ZERO POSTs (no re-send).
// Regression for: flush() re-POSTed the entire events.jsonl on every call
// (server-side duplicate inflation). The watermark must prevent this.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "iid-wm" });
  writeEvents(dir, [EV, { ...EV, ts: EV.ts + 5, tool: "browser_type" }]);
  const f1 = mockFetch({ status: 200 });
  const r1 = await flush(dir, {}, { fetch: f1 });
  assert.equal(f1.calls.length, 1, "first flush: one POST");
  assert.equal(r1.sent, 1, "first flush: sent=1");
  // Watermark must have been written using the identity (ts:sid) anchor, not a
  // raw line count. This is the fix for quality-review finding #1: a line-count
  // watermark becomes stale after pruneEvents() rewrites events.jsonl.
  assert.ok(fs.existsSync(telemetryWatermarkPath(dir)), "watermark file created after first flush");
  const wm = JSON.parse(fs.readFileSync(telemetryWatermarkPath(dir), "utf8"));
  assert.ok(typeof wm.lastKey === "string" && wm.lastKey.length > 0, "watermark records lastKey (ts:sid identity anchor)");
  assert.ok(!("flushedLines" in wm), "watermark does NOT use legacy flushedLines field (line-count is prune-unsafe)");
  // Second flush — no new events in events.jsonl.
  const f2 = mockFetch({ status: 200 });
  const r2 = await flush(dir, {}, { fetch: f2 });
  assert.equal(f2.calls.length, 0, "second flush of unchanged events: ZERO POSTs (watermark guard)");
  assert.equal(r2.sent, 0, "second flush: sent=0");
  ok("watermark: second flush of unchanged events sends zero POSTs");
} catch (e) { bad("watermark: second flush sends zero POSTs", e); }

// E10: WATERMARK — second flush sends only NEW events appended after the first flush.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "iid-wm2" });
  writeEvents(dir, [EV]);
  const f1 = mockFetch({ status: 200 });
  await flush(dir, {}, { fetch: f1 });
  assert.equal(f1.calls.length, 1, "first flush: one POST");
  // Append a NEW event after the first flush.
  const EV2 = { ...EV, ts: EV.ts + 100, tool: "browser_scroll" };
  fs.appendFileSync(telemetryEventsPath(dir), JSON.stringify(EV2) + "\n");
  const f2 = mockFetch({ status: 200 });
  const r2 = await flush(dir, {}, { fetch: f2 });
  assert.equal(f2.calls.length, 1, "second flush: one POST for new event only");
  const body2 = JSON.parse(f2.calls[0].opts.body);
  assert.equal(body2.batch.length, 1, "second flush body has exactly 1 (new) event");
  assert.equal(body2.batch[0].tool, "browser_scroll", "second flush sends only the new event");
  ok("watermark: second flush sends only newly appended events");
} catch (e) { bad("watermark: second flush sends only new events", e); }

// E11: WATERMARK — failed flush advances the watermark (prevents double-send)
//      and places the failed batch in the queue for retry.
//      If watermark did NOT advance, the next flush would include those events as
//      "fresh" PLUS find them in the queue — sending them twice.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "iid-wm3" });
  writeEvents(dir, [EV, { ...EV, ts: EV.ts + 1, tool: "browser_type" }]);
  const f1 = mockFetch({ throwErr: new Error("network down") });
  const r1 = await flush(dir, {}, { fetch: f1 });
  assert.equal(r1.sent, 0, "failed flush: sent=0");
  assert.equal(r1.queued, 1, "failed flush: batch queued for retry");
  // Watermark MUST advance past all attempted events so the next flush does not
  // re-include them as fresh (which would double-send with the queue).
  // The watermark uses a ts:sid identity anchor (not a raw line count) so it
  // remains correct even after pruneEvents() rewrites events.jsonl.
  assert.ok(fs.existsSync(telemetryWatermarkPath(dir)), "watermark file written even on failure");
  const wmObj = JSON.parse(fs.readFileSync(telemetryWatermarkPath(dir), "utf8"));
  assert.ok(typeof wmObj.lastKey === "string" && wmObj.lastKey.length > 0, "failed flush: watermark written with lastKey identity anchor");
  // The anchor must point to the LAST attempted event (browser_type, ts+1).
  assert.equal(wmObj.lastKey, `${EV.ts + 1}:s1`, "failed flush: watermark anchor is the last attempted event (ts:sid)");
  // Retry with a working fetch — the queued batch is sent, no extra fresh events.
  const f2 = mockFetch({ status: 200 });
  const r2 = await flush(dir, {}, { fetch: f2 });
  assert.equal(f2.calls.length, 1, "retry flush: exactly one POST (queued batch only, not fresh again)");
  assert.equal(r2.sent, 1, "retry flush: sent=1 (the queued batch)");
  assert.equal(r2.queued, 0, "retry flush: queue cleared on success");
  ok("watermark: failed flush advances watermark + queues; retry sends once not twice");
} catch (e) { bad("watermark: failed flush advances watermark + queues; retry sends once not twice", e); }

// E12: WATERMARK survives pruneEvents() rewrite (quality-review finding #1 + #2).
// Scenario: flush1 → 3 events sent; pruneEvents() drops the OLDEST event so
// events.jsonl now has only 2 lines (the newer two); a new event is then appended;
// flush2 must send ONLY the new event — not skip it (broken line-count watermark
// would have pointed past the end) and not re-send the already-sent events.
try {
  const { pruneEvents } = await import(path.join(PLUGIN_DIR, "lib/telemetry_log.js"));
  const { appendEvent } = await import(path.join(PLUGIN_DIR, "lib/telemetry_log.js"));

  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "iid-prune" });

  // Three events: EV_A (oldest), EV_B, EV_C — all in different seconds.
  const nowSec = 1_800_000_000;
  const DAY = 86400;
  const EV_A = { ...EV, ts: nowSec - 200 * DAY, sid: "sprune", tool: "browser_click"    }; // old — will be pruned
  const EV_B = { ...EV, ts: nowSec - 10  * DAY, sid: "sprune", tool: "browser_type"     }; // recent
  const EV_C = { ...EV, ts: nowSec - 5   * DAY, sid: "sprune", tool: "browser_navigate" }; // recent
  writeEvents(dir, [EV_A, EV_B, EV_C]);

  // Flush 1: all three events sent.
  const f1 = mockFetch({ status: 200 });
  const r1 = await flush(dir, {}, { fetch: f1 });
  assert.equal(f1.calls.length, 1, "E12: flush1 posts once");
  assert.equal(JSON.parse(f1.calls[0].opts.body).batch.length, 3, "E12: flush1 sends all 3 events");
  assert.equal(r1.sent, 1, "E12: flush1 sent=1");

  // Now prune: drop events older than 180 days. EV_A is removed; EV_B + EV_C remain.
  // This rewrites events.jsonl atomically — the file now has 2 lines, not 3.
  // A line-count watermark of 3 would now point PAST the end of the 2-line file,
  // causing the next flush to skip the newly appended event entirely (the bug).
  pruneEvents(dir, { maxLines: 5000, maxAgeDays: 180, now: nowSec * 1000 });
  const afterPrune = fs.readFileSync(telemetryEventsPath(dir), "utf8").split("\n").filter(Boolean);
  assert.equal(afterPrune.length, 2, "E12: prune reduced file to 2 lines");

  // Append a brand-new event AFTER the prune.
  const EV_NEW = { ...EV, ts: nowSec, sid: "sprune", tool: "browser_scroll" };
  appendEvent(dir, EV_NEW);

  // Flush 2: must send ONLY EV_NEW (not skip it, not re-send EV_B/EV_C).
  const f2 = mockFetch({ status: 200 });
  const r2 = await flush(dir, {}, { fetch: f2 });
  assert.equal(f2.calls.length, 1, "E12: flush2 posts once (EV_NEW only)");
  const body2 = JSON.parse(f2.calls[0].opts.body);
  assert.equal(body2.batch.length, 1, "E12: flush2 batch has exactly 1 event (EV_NEW, not already-sent events)");
  assert.equal(body2.batch[0].tool, "browser_scroll", "E12: flush2 sends the new post-prune event");
  assert.equal(r2.sent, 1, "E12: flush2 sent=1");
  ok("watermark survives pruneEvents() rewrite: post-prune new events not skipped, old events not re-sent");
} catch (e) { bad("watermark survives pruneEvents() rewrite (prune-offset regression)", e); }

console.log("─────────────────────────────");
console.log("passed:", pass); console.log("failed:", fail);
process.exit(fail === 0 ? 0 : 1);

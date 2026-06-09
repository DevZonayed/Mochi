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
const { telemetryEventsPath, telemetryDir, telemetryQueuePath } = await import(path.join(PLUGIN_DIR, "lib/paths.js"));

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

console.log("─────────────────────────────");
console.log("passed:", pass); console.log("failed:", fail);
process.exit(fail === 0 ? 0 : 1);

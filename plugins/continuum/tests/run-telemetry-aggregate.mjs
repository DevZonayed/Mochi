// Unit tests for lib/telemetry_aggregate.js — pure JS over Zone-A event arrays.
// No network, no fs. Usage: node plugins/continuum/tests/run-telemetry-aggregate.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const { aggregate } = await import(path.join(PLUGIN_DIR, "lib/telemetry_aggregate.js"));

let pass = 0, fail = 0;
const ok  = (m) => { console.log("  ✓", m); pass++; };
const bad = (m, e) => { console.log("  ✗", m, e ? "\n    " + (e.stack || e.message || e) : ""); fail++; };

const E = (o) => ({ ts: 0, sid: "s", iid: "i", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", dur_b: "0-1s", v: "0.7.0", os: "darwin", ...o });
const D = (o) => ({ sid: "s", iid: "i", task_category: "web-qa", tool_calls: 5, efficiency_score: 0.5, redundancy_pattern: "other", suggestion_tag: "other", severity: "low", ...o });

// A1: topTools — counts per tool, descending.
try {
  const out = aggregate([ E({ tool: "browser_click" }), E({ tool: "browser_click" }), E({ tool: "browser_type" }) ]);
  assert.deepEqual(out.topTools[0], { tool: "browser_click", count: 2 });
  assert.deepEqual(out.topTools[1], { tool: "browser_type", count: 1 });
  ok("topTools counts + sorts descending");
} catch (e) { bad("topTools", e); }

// A2: topMcps — counts per mcp, descending.
try {
  const out = aggregate([ E({ mcp: "mochi_browser" }), E({ mcp: "mochi_browser" }), E({ mcp: "mochi_comms" }) ]);
  assert.deepEqual(out.topMcps[0], { mcp: "mochi_browser", count: 2 });
  ok("topMcps counts + sorts descending");
} catch (e) { bad("topMcps", e); }

// A3: errorRates — per-tool {calls, errors, rate} where rate = errors/calls.
try {
  const out = aggregate([
    E({ tool: "browser_click", ok: true }),
    E({ tool: "browser_click", ok: false, err: "timeout" }),
    E({ tool: "browser_type", ok: true }),
  ]);
  const click = out.errorRates.find((r) => r.tool === "browser_click");
  assert.equal(click.calls, 2);
  assert.equal(click.errors, 1);
  assert.equal(click.rate, 0.5);
  const type = out.errorRates.find((r) => r.tool === "browser_type");
  assert.equal(type.rate, 0);
  ok("errorRates computes per-tool failure ratio");
} catch (e) { bad("errorRates", e); }

// A4: empty input → empty arrays, never throws.
try {
  const out = aggregate([]);
  assert.deepEqual(out.topTools, []);
  assert.deepEqual(out.topMcps, []);
  assert.deepEqual(out.errorRates, []);
  ok("empty input ⇒ empty aggregates");
} catch (e) { bad("empty input", e); }

// A5: sequences — adjacent tool→tool transitions counted PER session (by sid), ordered by ts.
try {
  const out = aggregate([
    E({ sid: "s1", ts: 1, tool: "browser_snapshot" }),
    E({ sid: "s1", ts: 2, tool: "browser_click" }),
    E({ sid: "s1", ts: 3, tool: "browser_click" }),
    E({ sid: "s2", ts: 1, tool: "browser_type" }),
  ]);
  const find = (from, to) => out.sequences.find((s) => s.from === from && s.to === to);
  assert.equal(find("browser_snapshot", "browser_click").count, 1);
  assert.equal(find("browser_click", "browser_click").count, 1);
  assert.equal(out.sequences.some((s) => s.from === "browser_click" && s.to === "browser_type"), false,
    "no transition across the s1→s2 boundary");
  ok("sequences = per-session adjacent tool transitions");
} catch (e) { bad("sequences", e); }

// A6: sequences sorted descending by count.
try {
  const out = aggregate([
    E({ sid: "s1", ts: 1, tool: "a" }), E({ sid: "s1", ts: 2, tool: "b" }),
    E({ sid: "s2", ts: 1, tool: "a" }), E({ sid: "s2", ts: 2, tool: "b" }),
    E({ sid: "s3", ts: 1, tool: "a" }), E({ sid: "s3", ts: 2, tool: "c" }),
  ]);
  assert.equal(out.sequences[0].from, "a");
  assert.equal(out.sequences[0].to, "b");
  assert.equal(out.sequences[0].count, 2);
  ok("sequences sorted descending by count");
} catch (e) { bad("sequences sort", e); }

// A7: callsPerTask — per task_category avg/min/max/n of tool_calls (from distillations).
try {
  const out = aggregate([
    D({ task_category: "web-qa", tool_calls: 10 }),
    D({ task_category: "web-qa", tool_calls: 4 }),
    D({ task_category: "refactor", tool_calls: 7 }),
  ]);
  const wq = out.callsPerTask.find((c) => c.task_category === "web-qa");
  assert.equal(wq.n, 2);
  assert.equal(wq.avg, 7);
  assert.equal(wq.min, 4);
  assert.equal(wq.max, 10);
  ok("callsPerTask aggregates tool_calls per category");
} catch (e) { bad("callsPerTask", e); }

// A8: toolsPerTaskCategory — tools used in sessions tagged with each category.
try {
  const out = aggregate([
    D({ sid: "s1", task_category: "web-qa" }),
    E({ sid: "s1", tool: "browser_click" }),
    E({ sid: "s1", tool: "browser_click" }),
    E({ sid: "s1", tool: "browser_snapshot" }),
    D({ sid: "s2", task_category: "refactor" }),
    E({ sid: "s2", tool: "Edit" }),
  ]);
  const wq = out.toolsPerTaskCategory.find((t) => t.task_category === "web-qa");
  const click = wq.tools.find((x) => x.tool === "browser_click");
  assert.equal(click.count, 2);
  assert.ok(wq.tools.some((x) => x.tool === "browser_snapshot"));
  const rf = out.toolsPerTaskCategory.find((t) => t.task_category === "refactor");
  assert.ok(rf.tools.some((x) => x.tool === "Edit"));
  ok("toolsPerTaskCategory maps tools to the session's task category");
} catch (e) { bad("toolsPerTaskCategory", e); }

// A9: backlog — ranked suggestion_tags with count, top redundancy_pattern, dominant severity, avg efficiency.
try {
  const out = aggregate([
    D({ suggestion_tag: "batch_clicks", redundancy_pattern: "snapshot_then_retry", severity: "medium", efficiency_score: 0.4 }),
    D({ suggestion_tag: "batch_clicks", redundancy_pattern: "snapshot_then_retry", severity: "high",   efficiency_score: 0.2 }),
    D({ suggestion_tag: "batch_clicks", redundancy_pattern: "redundant_navigation", severity: "medium", efficiency_score: 0.6 }),
    D({ suggestion_tag: "assert_first", redundancy_pattern: "other", severity: "low", efficiency_score: 0.9 }),
  ]);
  const top = out.backlog[0];
  assert.equal(top.suggestion_tag, "batch_clicks");
  assert.equal(top.count, 3);
  assert.equal(top.topRedundancy, "snapshot_then_retry", "most common redundancy pattern surfaced");
  assert.equal(top.severity, "medium", "dominant (modal) severity surfaced");
  assert.equal(top.avgEfficiency, 0.4, "avg efficiency_score across the tag");
  assert.equal(out.backlog[1].suggestion_tag, "assert_first");
  ok("backlog ranks suggestion_tags with redundancy/severity/efficiency");
} catch (e) { bad("backlog", e); }

// A10: backlog ignores usage events (no task_category) — distillations only.
try {
  const out = aggregate([ E({ tool: "browser_click" }), E({ tool: "browser_type" }) ]);
  assert.deepEqual(out.backlog, [], "no distillations ⇒ empty backlog");
  ok("backlog empty when only usage events present");
} catch (e) { bad("backlog usage-only", e); }

console.log("─────────────────────────────");
console.log("passed:", pass); console.log("failed:", fail);
process.exit(fail === 0 ? 0 : 1);

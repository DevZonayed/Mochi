import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "./aggregate.mjs";

const EVENTS = [
  { ts: 1, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other" },
  { ts: 2, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: false, err: "timeout" },
  { ts: 3, sid: "s1", tool: "browser_snapshot", mcp: "mochi_browser", ok: true, err: "other" },
  { ts: 4, sid: "s2", tool: "Read", mcp: "", ok: true, err: "other" },
  { kind: "distill", task_category: "web-qa", tool_calls: 10, efficiency_score: 0.4,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "medium" },
  { kind: "distill", task_category: "web-qa", tool_calls: 8, efficiency_score: 0.5,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "low" },
];

test("topTools ranks tool usage by count", () => {
  const a = aggregate(EVENTS);
  assert.equal(a.topTools[0].name, "browser_click");
  assert.equal(a.topTools[0].count, 2);
});

test("topMcps ranks mcp usage by count", () => {
  const a = aggregate(EVENTS);
  assert.equal(a.topMcps.find((m) => m.name === "mochi_browser").count, 3);
});

test("errorRates reports fail/total per tool", () => {
  const a = aggregate(EVENTS);
  const click = a.errorRates.find((e) => e.tool === "browser_click");
  assert.equal(click.total, 2);
  assert.equal(click.fail, 1);
  assert.ok(Math.abs(click.rate - 0.5) < 1e-9);
});

test("sequences counts adjacent tool->tool co-occurrence within a session", () => {
  const a = aggregate(EVENTS);
  const seq = a.sequences.find((s) => s.from === "browser_click" && s.to === "browser_snapshot");
  assert.ok(seq && seq.count >= 1);
  assert.ok(!a.sequences.some((s) => s.to === "Read" && s.from === "browser_snapshot"));
});

test("callsPerTask buckets tool_calls per task_category from distillations", () => {
  const a = aggregate(EVENTS);
  const webqa = a.callsPerTask.find((c) => c.task_category === "web-qa");
  assert.equal(webqa.count, 2);
  assert.equal(webqa.avgCalls, 9);
});

test("toolsPerTaskCategory maps each task_category to its tools+counts (N3)", () => {
  const tagged = [
    { ts: 1, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", task_category: "web-qa" },
    { ts: 2, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", task_category: "web-qa" },
    { ts: 3, sid: "s2", tool: "Read", mcp: "", ok: true, err: "other", task_category: "coding" },
  ];
  const a = aggregate(tagged);
  const webqa = a.toolsPerTaskCategory.find((t) => t.task_category === "web-qa");
  assert.equal(webqa.tools[0].name, "browser_click");
  assert.equal(webqa.tools[0].count, 2);
  assert.equal(a.toolsPerTaskCategory.find((t) => t.task_category === "coding").tools[0].name, "Read");
});

test("backlog ranks suggestion_tags with counts + example redundancy + confidence", () => {
  const a = aggregate(EVENTS);
  assert.equal(a.backlog[0].suggestion_tag, "batch_clicks");
  assert.equal(a.backlog[0].count, 2);
  assert.equal(a.backlog[0].topRedundancy, "snapshot_then_retry");
  assert.ok("lowConfidence" in a.backlog[0]);
});

test("aggregate is robust to empty input", () => {
  const a = aggregate([]);
  assert.deepEqual(a.topTools, []);
  assert.deepEqual(a.backlog, []);
});

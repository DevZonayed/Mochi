import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "./dashboard.mjs";

const AGG = {
  topTools: [{ name: "browser_click", count: 2 }, { name: "Read", count: 1 }],
  topMcps: [{ name: "mochi_browser", count: 3 }],
  errorRates: [{ tool: "browser_click", total: 2, fail: 1, rate: 0.5 }],
  sequences: [{ from: "browser_click", to: "browser_snapshot", count: 1 }],
  callsPerTask: [{ task_category: "web-qa", count: 2, avgCalls: 9 }],
  toolsPerTaskCategory: [{ task_category: "web-qa", tools: [{ name: "browser_click", count: 2 }] }],
  backlog: [{ suggestion_tag: "batch_clicks", count: 2, topRedundancy: "snapshot_then_retry", lowConfidence: true }],
};

test("renders every §13.8 view as plain HTML", () => {
  const html = renderDashboard(AGG);
  assert.ok(html.toLowerCase().startsWith("<!doctype html>"));
  for (const label of [
    "Top Tools", "Top MCPs", "Error Rates", "Co-occurrence",
    "Calls per Task", "Tools per Task Category", "Improvement Backlog",
  ]) {
    assert.ok(html.includes(label), `missing dashboard section: ${label}`);
  }
});

test("backlog row shows tag, count, redundancy, and a low-confidence caveat (§13.5)", () => {
  const html = renderDashboard(AGG);
  assert.ok(html.includes("batch_clicks"));
  assert.ok(html.includes("snapshot_then_retry"));
  assert.ok(/low.?confidence/i.test(html));
});

test("uses inline SVG (no external chart library)", () => {
  const html = renderDashboard(AGG);
  assert.ok(html.includes("<svg"));
  assert.ok(!html.includes("<script src="));
});

test("escapes values to prevent HTML injection from stored data", () => {
  const html = renderDashboard({ ...AGG, topTools: [{ name: "<img src=x onerror=alert(1)>", count: 1 }] });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});

test("handles empty aggregates without throwing", () => {
  const html = renderDashboard({
    topTools: [], topMcps: [], errorRates: [], sequences: [],
    callsPerTask: [], toolsPerTaskCategory: [], backlog: [],
  });
  assert.ok(html.includes("Top Tools"));
});

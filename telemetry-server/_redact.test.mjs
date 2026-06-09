import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM, SEVERITY_ENUM,
  ALLOW_TOOLS, ALLOW_MCPS, ZONE_A_EVENT_KEYS, ZONE_A_DISTILL_KEYS,
  redactEvent, redactDistillation,
} from "./telemetry_redact.js";

test("enums match the canonical Shared Contracts set", () => {
  assert.deepEqual(ERR_ENUM, ["timeout","not_found","bad_input","permission","network","other"]);
  assert.deepEqual(TASK_ENUM, ["web-qa","coding","refactor","debug","research","docs","comms","other"]);
  assert.deepEqual(SEVERITY_ENUM, ["low","medium","high","other"]);
  for (const e of [ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM]) assert.ok(e.includes("other"));
});

test("event keys are exactly the Zone-A contract — NO model field", () => {
  assert.deepEqual([...ZONE_A_EVENT_KEYS].sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"].sort());
  assert.ok(!ZONE_A_EVENT_KEYS.includes("model"), "model removed per §13.6");
});

test("redactEvent whitelists known keys and DROPS everything else", () => {
  const out = redactEvent({
    ts: 1717900000, sid: "s1", iid: "i1", tool: "browser_click", mcp: "mochi_browser",
    ok: true, err: "other", dur_b: "1-3s", v: "0.7.0", os: "darwin",
    prompt: "the user said hello", model: "claude-opus", secret: "sk-live-123",
    tool_input: { url: "https://client.example/secret" },
  });
  assert.deepEqual(Object.keys(out).sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"].sort());
  const s = JSON.stringify(out);
  for (const leak of ["prompt","hello","model","claude","secret","sk-live","client.example"]) {
    assert.ok(!s.includes(leak), `Zone-A payload must not contain "${leak}"`);
  }
});

test("B1 — non-allowlisted tool/mcp names are bucketed", () => {
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", ok: true, err: "other", dur_b: "0-1s", v: "0.7.0", os: "linux",
    tool: "mcp__client_secret_project__do_thing", mcp: "client_secret_project" });
  assert.equal(out.tool, "thirdparty_tool");
  assert.equal(out.mcp, "thirdparty_mcp");
  assert.ok(!JSON.stringify(out).includes("client_secret_project"));
});

test("known mochi/built-in tool + mcp names pass through verbatim", () => {
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", ok: true, err: "other", dur_b: "0-1s", v: "0.7.0", os: "linux",
    tool: "browser_click", mcp: "mochi_browser" });
  assert.equal(out.tool, "browser_click");
  assert.equal(out.mcp, "mochi_browser");
});

test("B2 — bad err value coerced to enum-or-other, raw string absent", () => {
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", tool: "Read", mcp: "", ok: false,
    err: "/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-abc", dur_b: "1-3s", v: "0.7.0", os: "darwin" });
  assert.ok(["network","other"].includes(out.err));
  assert.ok(!JSON.stringify(out).includes("sk-live"));
  assert.ok(!JSON.stringify(out).includes("ECONNREFUSED"));
});

test("redactDistillation whitelists categorical keys; Zone-B free text dropped", () => {
  const out = redactDistillation({
    task_category: "web-qa", tool_calls: 10, efficiency_score: 0.4,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "medium",
    suggestion_text: "advice mentioning /secret", quality_issue: "missing_assertion in /Users/j/login.test.ts",
  });
  assert.deepEqual([...ZONE_A_DISTILL_KEYS].sort(), Object.keys(out).sort());
  assert.ok(!("suggestion_text" in out) && !("quality_issue" in out));
  assert.ok(!JSON.stringify(out).includes("/secret") && !JSON.stringify(out).includes("login.test.ts"));
});

test("B2 — distillation categoricals coerced to enum-or-other", () => {
  const out = redactDistillation({ task_category: "made up /etc/passwd", tool_calls: "10", efficiency_score: 1.5,
    redundancy_pattern: "leak sk-live", suggestion_tag: "free text", severity: "EXTREME" });
  assert.equal(out.task_category, "other");
  assert.equal(out.redundancy_pattern, "other");
  assert.equal(out.suggestion_tag, "other");
  assert.equal(out.severity, "other");
  assert.equal(typeof out.tool_calls, "number");
  assert.ok(out.efficiency_score >= 0 && out.efficiency_score <= 1);
  assert.ok(!JSON.stringify(out).includes("passwd") && !JSON.stringify(out).includes("sk-live"));
});

test("redactEvent returns null for non-object input (fail-closed)", () => {
  assert.equal(redactEvent(null), null);
  assert.equal(redactEvent("a string"), null);
  assert.equal(redactEvent(42), null);
});

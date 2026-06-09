// plugins/continuum/tests/run-telemetry-redact.mjs
// telemetry_redact.js — THE privacy keystone (spec §13.1/§13.2), fail-closed.
// Asserts: key whitelist, third-party tool/mcp bucketing, enum value-coercion,
// Zone-B fields NEVER present, and the planted-secret cases are fully absent.
import assert from "node:assert/strict";
import {
  redactEvent, redactDistillation,
  ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM, SEVERITY_ENUM,
  ALLOW_TOOLS, ALLOW_MCPS,
} from "../lib/telemetry_redact.js";

// helper: assert a substring appears NOWHERE in the serialized object.
function absent(obj, needle, msg) {
  assert.ok(!JSON.stringify(obj).includes(needle), msg || `secret leaked: ${needle}`);
}

// enums are non-empty and each categorical enum contains "other".
{
  for (const [name, e] of Object.entries({ ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM })) {
    assert.ok(Array.isArray(e) && e.length > 0, `${name} non-empty`);
    assert.ok(e.includes("other"), `${name} must include "other" bucket`);
  }
  assert.deepEqual(ERR_ENUM, ["timeout","not_found","bad_input","permission","network","other"]);
  assert.ok(Array.isArray(ALLOW_TOOLS) && Array.isArray(ALLOW_MCPS));
}

// 1) happy path: allowlisted tool/mcp + valid enum survive verbatim; exact Zone-A keys.
{
  const out = redactEvent({
    ts: 1717900000, sid: "s1", iid: "i1",
    tool: "browser_click", mcp: "mochi_browser", ok: false,
    err: "timeout", dur_b: "1-3s", v: "0.7.0", os: "darwin",
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"]);
  assert.equal(out.tool, "browser_click");
  assert.equal(out.mcp, "mochi_browser");
  assert.equal(out.err, "timeout");
  assert.equal(out.ok, false);
}

// 2) §13.6 — NO model field even if present in input.
{
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", tool: "Read", mcp: "",
    ok: true, err: "", dur_b: "0-1s", v: "0.7.0", os: "linux", model: "claude-opus-4" });
  assert.equal("model" in out, false, "model is dropped from Zone-A (§13.6)");
  absent(out, "claude-opus-4", "model value must not leak");
}

// 3) §13.1 B1 — third-party MCP/tool names are BUCKETED, never echoed.
//    Planted: mcp__client_secret_project__do
{
  const out = redactEvent({
    ts: 1, sid: "s", iid: "i",
    tool: "mcp__client_secret_project__do", mcp: "client_secret_project",
    ok: true, err: "", dur_b: "0-1s", v: "0.7.0", os: "darwin",
  });
  assert.equal(out.tool, "thirdparty_tool", "non-allowlisted tool -> literal bucket");
  assert.equal(out.mcp, "thirdparty_mcp", "non-allowlisted mcp -> literal bucket");
  absent(out, "client_secret_project", "client codename must be fully absent");
  absent(out, "secret", "no fragment of the codename survives");
}

// 4) §13.2 B2 — raw error string with paths/IPs/tokens is COERCED to an enum,
//    raw string fully absent. Planted: "/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-…"
{
  const planted = "/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-abcd1234";
  const out = redactEvent({
    ts: 1, sid: "s", iid: "i", tool: "Bash", mcp: "",
    ok: false, err: planted, dur_b: "3-10s", v: "0.7.0", os: "darwin",
  });
  assert.ok(ERR_ENUM.includes(out.err), "err coerced into ERR_ENUM");
  assert.ok(out.err === "network" || out.err === "other", "ECONNREFUSED -> network (or other)");
  absent(out, "sk-live", "token must be stripped");
  absent(out, "10.0.0.5", "IP must be stripped");
  absent(out, "/Users/j", "file path must be stripped");
}

// 5) unknown keys are DROPPED (fail-closed whitelist).
{
  const out = redactEvent({
    ts: 1, sid: "s", iid: "i", tool: "Read", mcp: "", ok: true, err: "", dur_b: "0-1s",
    v: "0.7.0", os: "darwin",
    prompt: "delete prod database now", file_contents: "AWS_SECRET=xyz", tool_input: { path: "/etc/passwd" },
  });
  assert.equal("prompt" in out, false);
  assert.equal("file_contents" in out, false);
  assert.equal("tool_input" in out, false);
  absent(out, "delete prod database", "Zone-B prompt text must not survive");
  absent(out, "AWS_SECRET", "planted secret must not survive");
  absent(out, "/etc/passwd", "tool args must not survive");
}

// 6) distillation: valid categoricals survive; exact Zone-A distillation keys.
{
  const out = redactDistillation({
    task_category: "web-qa", tool_calls: 10, efficiency_score: 0.4,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "medium",
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["efficiency_score","redundancy_pattern","severity","suggestion_tag","task_category","tool_calls"]);
  assert.equal(out.task_category, "web-qa");
  assert.equal(out.tool_calls, 10);
  assert.equal(out.suggestion_tag, "batch_clicks");
}

// 7) distillation: out-of-enum categoricals coerce to "other".
{
  const out = redactDistillation({
    task_category: "totally-made-up-category", tool_calls: "7", efficiency_score: 2,
    redundancy_pattern: "weird_thing", suggestion_tag: "nope", severity: "spicy",
  });
  assert.equal(out.task_category, "other");
  assert.equal(out.redundancy_pattern, "other");
  assert.equal(out.suggestion_tag, "other");
  assert.equal(out.tool_calls, 7, "numeric string coerced to int");
  assert.ok(out.efficiency_score >= 0 && out.efficiency_score <= 1, "score clamped to [0,1]");
}

// 8) §13.1/§13.2 — Zone-B fields suggestion_text + quality_issue are NEVER emitted,
//    even when planted with content. Also a Zone-B sentence planted in suggestion_tag is coerced.
{
  const out = redactDistillation({
    task_category: "web-qa", tool_calls: 3, efficiency_score: 0.9,
    redundancy_pattern: "other",
    suggestion_tag: "You should refactor /Users/j/secret.js and remove token sk-live-XYZ",
    severity: "low",
    suggestion_text: "Full human advice mentioning the client AcmeCorp and prod-db-7 host",
    quality_issue: "missing_assertion in /app/private/checkout.test.ts",
  });
  assert.equal("suggestion_text" in out, false, "suggestion_text is Zone-B (never emitted)");
  assert.equal("quality_issue" in out, false, "quality_issue is Zone-B (never emitted)");
  assert.equal(out.suggestion_tag, "other", "free-text in suggestion_tag coerced to other");
  absent(out, "sk-live-XYZ", "token planted in suggestion_tag must be absent");
  absent(out, "AcmeCorp", "client name in suggestion_text must be absent");
  absent(out, "checkout.test.ts", "path in quality_issue must be absent");
  absent(out, "/Users/j", "path planted in suggestion_tag must be absent");
}

console.log("✓ telemetry_redact (fail-closed: whitelist + bucketing + enum coercion + planted secrets stripped)");

#!/usr/bin/env node
// Test for qa_coverage.js — the EXHAUSTIVE QA honesty gate.
//
// Run: node plugins/qa/lib/qa_coverage.test.mjs
//
// Writes temp ledgers under <tmp>/.continuum/verification/<slug>.json, invokes
// qa_coverage.js as a child process, and asserts gate verdict + exit code:
//   - all-WORKS ledger              -> exit 0, "GATE: PASS"
//   - one UNTESTED cell             -> exit 2, "GATE: BLOCKED"
//   - --require-clean + a NO-OP     -> exit 1, "GATE: BLOCKED"
//   - missing ledger                -> exit 2, "GATE: BLOCKED" (zero coverage)
//   - --require-clean, clean+complete -> exit 0, "GATE: PASS"

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "qa_coverage.js");

let failures = 0;
let passes = 0;

function ok(cond, msg) {
  if (cond) {
    passes++;
    console.log(`ok   - ${msg}`);
  } else {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

// MUST match qa_coverage.js slugify AND continuum verification_ledger.js slug(),
// including the "app" fallback for degenerate names.
function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "app";
}

function makeProject(app, ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-cov-"));
  if (ledger !== null) {
    const vdir = path.join(dir, ".continuum", "verification");
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, slugify(app) + ".json"), JSON.stringify(ledger, null, 2));
  }
  return dir;
}

function runGate(app, projectDir, extraArgs = []) {
  const res = spawnSync(process.execPath, [CLI, "--app", app, "--project-dir", projectDir, ...extraArgs], {
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function el(selector, verdict, extra = {}) {
  return { selector, verdict, ...extra };
}

// ---- Case 1: all WORKS -> PASS / exit 0 ----
{
  const app = "Demo App";
  const ledger = {
    app,
    routes: [
      { route: "/", elements: [el("#login", "WORKS", { evidence: "200 + DOM change" }), el("#nav", "NAVIGATES")] },
      { route: "/settings", elements: [el("#save", "WORKS"), el("#del", "DISABLED", { reason: "no selection" })] },
    ],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir);
  ok(r.code === 0, "all-WORKS ledger exits 0");
  ok(/GATE:\s*PASS/.test(r.stdout), "all-WORKS ledger prints GATE: PASS");
  ok(/4 of 4 controls verified/.test(r.stdout), "all-WORKS reports 4 of 4 verified");
}

// ---- Case 2: one UNTESTED -> BLOCKED / exit 2 ----
{
  const app = "Demo App";
  const ledger = {
    app,
    routes: [
      { route: "/", elements: [el("#login", "WORKS"), el("#forgot", "UNTESTED")] },
    ],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir);
  ok(r.code === 2, "one-UNTESTED ledger exits 2");
  ok(/GATE:\s*BLOCKED/.test(r.stdout), "one-UNTESTED ledger prints GATE: BLOCKED");
  ok(/untested/.test(r.stdout) && /#forgot/.test(r.stdout), "BLOCKED output names the untested control");
}

// ---- Case 3: --require-clean + a NO-OP defect -> BLOCKED / exit 1 ----
{
  const app = "Demo App";
  const ledger = {
    app,
    routes: [
      { route: "/", elements: [el("#login", "WORKS"), el("#deadbtn", "NO-OP", { evidence: "click, no effect" })] },
    ],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir, ["--require-clean"]);
  ok(r.code === 1, "--require-clean + NO-OP exits 1");
  ok(/GATE:\s*BLOCKED/.test(r.stdout), "--require-clean + NO-OP prints GATE: BLOCKED");
  ok(/defect/.test(r.stdout), "BLOCKED output mentions defect");
}

// ---- Case 3b: same defect WITHOUT --require-clean -> still PASS (coverage complete) ----
{
  const app = "Demo App";
  const ledger = {
    app,
    routes: [
      { route: "/", elements: [el("#login", "WORKS"), el("#deadbtn", "NO-OP")] },
    ],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir);
  ok(r.code === 0, "NO-OP without --require-clean exits 0 (coverage complete)");
  ok(/GATE:\s*PASS/.test(r.stdout), "NO-OP without --require-clean prints GATE: PASS");
}

// ---- Case 4: missing ledger -> BLOCKED / exit 2 (zero coverage) ----
{
  const app = "Never Tested";
  const dir = makeProject(app, null); // no ledger written
  const r = runGate(app, dir);
  ok(r.code === 2, "missing ledger exits 2");
  ok(/GATE:\s*BLOCKED/.test(r.stdout), "missing ledger prints GATE: BLOCKED");
  ok(/MISSING/.test(r.stdout), "missing ledger is flagged as MISSING");
}

// ---- Case 5: --require-clean, clean + complete -> PASS / exit 0 ----
{
  const app = "Clean App";
  const ledger = {
    app,
    routes: [
      { route: "/", elements: [el("#a", "WORKS"), el("#b", "NAVIGATES"), el("#c", "DISABLED", { reason: "n/a" })] },
    ],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir, ["--require-clean"]);
  ok(r.code === 0, "--require-clean clean+complete exits 0");
  ok(/GATE:\s*PASS/.test(r.stdout), "--require-clean clean+complete prints GATE: PASS");
}

// ---- Case 6: UNCERTAIN also blocks (exit 2) ----
{
  const app = "Demo App";
  const ledger = {
    app,
    routes: [{ route: "/", elements: [el("#x", "WORKS"), el("#y", "UNCERTAIN", { reason: "ambiguous result" })] }],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir);
  ok(r.code === 2, "one-UNCERTAIN ledger exits 2");
  ok(/uncertain/.test(r.stdout), "BLOCKED output mentions uncertain");
}

// ---- Case 7: object-keyed routes (real continuum ledger shape) ----
// continuum/lib/verification_ledger.js writes routes as { "/path": { elements } }.
// The gate MUST read that shape, not only the array shape.
{
  const app = "Real Ledger";
  const ledger = {
    app,
    bundle_hash: "abc123",
    verified_at: "2026-06-07T00:00:00Z",
    routes: {
      "/": { elements: [el("#a", "WORKS"), el("#b", "NAVIGATES")] },
      "/admin": { elements: [el("#save", "WORKS")] },
    },
    gaps: [],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir);
  ok(r.code === 0, "object-keyed routes complete ledger exits 0");
  ok(/GATE:\s*PASS/.test(r.stdout), "object-keyed routes prints GATE: PASS");
  ok(/3 of 3 controls verified/.test(r.stdout), "object-keyed routes counts all 3 controls across routes");
}

// ---- Case 8: object-keyed routes with UNTESTED -> BLOCKED ----
{
  const app = "Real Ledger";
  const ledger = {
    app,
    routes: { "/": { elements: [el("#a", "WORKS"), el("#b", "UNTESTED")] } },
    gaps: ["/billing route needs a paid account we do not have"],
  };
  const dir = makeProject(app, ledger);
  const r = runGate(app, dir);
  ok(r.code === 2, "object-keyed UNTESTED exits 2");
  ok(/Known gaps/.test(r.stdout), "ledger gaps[] are surfaced in output");
  ok(/paid account/.test(r.stdout), "specific gap text is shown");
}

// ---- Case 9: degenerate app name slug parity (regression for slug divergence) ----
// A non-ASCII name collapses to "" under the [^a-z0-9] slug rule; it must resolve
// to the SAME "app.json" the continuum ledger writes — otherwise the gate would
// read a different file and silently pass. (Uses a CJK name rather than an
// all-dashes one, which would be misread by the shared --flag arg parser.)
{
  const app = "我的应用";              // slugifies to "" -> fallback "app"
  ok(slugify(app) === "app", "non-ASCII app name slugs to 'app' (parity with continuum)");
  const ledger = { app, routes: { "/": { elements: [el("#a", "WORKS")] } }, gaps: [] };
  const dir = makeProject(app, ledger); // writes .continuum/verification/app.json
  const r = runGate(app, dir);
  ok(r.code === 0, "degenerate app name: gate reads the app.json the ledger wrote (exit 0)");
  ok(/GATE:\s*PASS/.test(r.stdout) && !/MISSING/.test(r.stdout), "degenerate app name: not treated as MISSING");
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);

#!/usr/bin/env node
// qa_coverage.js — the machine-checkable HONESTY GATE for EXHAUSTIVE QA MODE.
//
// Reads the verification ledger written by the continuum verification_ledger_cli
// (`record --app … --route … --element '<json>'`) at:
//   <project-dir>/.continuum/verification/<slug>.json
// where slug = app name lowercased with every non-alphanumeric run -> '-'.
//
// It computes coverage over every routes[].elements[] cell and decides whether
// the run may honestly be reported as "pass". A run CANNOT pass while any cell is
// UNTESTED or UNCERTAIN — that is what makes "passed" un-fakeable.
//
// Pure Node, builtins only. No deps.
//
// Usage:
//   node qa_coverage.js --app <name> [--project-dir P] [--require-clean] [--json]
//
// Exit codes:
//   2  any UNTESTED/UNCERTAIN cell (coverage incomplete -> cannot claim pass)
//   1  --require-clean given AND any defect (NO-OP/ERROR) exists
//   0  coverage complete (and clean, when --require-clean)
//
// Verdict vocabulary (per the exhaustive QA spec):
//   WORKS      verified, had an observable effect (2xx and/or DOM/route change)
//   NO-OP      clickable but nothing happened — a dead control == defect
//   ERROR      console error or >=400 response — defect
//   NAVIGATES  control routed/navigated as intended
//   DISABLED   intentionally disabled (reason recorded)
//   UNTESTED   never exercised — blocks the gate
//   UNCERTAIN  exercised but no confident verdict — blocks the gate

import fs from "node:fs";
import path from "node:path";

const VERDICTS = ["WORKS", "NO-OP", "ERROR", "NAVIGATES", "DISABLED", "UNTESTED", "UNCERTAIN"];
const DEFECT_VERDICTS = new Set(["NO-OP", "ERROR"]);
const INCOMPLETE_VERDICTS = new Set(["UNTESTED", "UNCERTAIN"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) {
        args[k] = true;
      } else {
        args[k] = n;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// slug: lowercase, every run of non-alphanumeric -> single '-', trim leading/trailing '-'.
// MUST stay byte-for-byte identical to verification_ledger.js slug() (including the
// "app" fallback) or the gate would read a different file than the ledger wrote.
function slugify(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "app";
}

function ledgerPath(projectDir, app) {
  return path.join(projectDir, ".continuum", "verification", slugify(app) + ".json");
}

// Read + parse the ledger. Missing file -> zero-coverage ledger (not an error:
// "no evidence" is a legitimate, gate-blocking state, never a silent pass).
//
// The continuum verification_ledger writes routes as an OBJECT keyed by route
// name: { routes: { "/path": { elements: [...] } }, gaps: [...] }. Some callers
// (and the spec narrative) use an ARRAY: { routes: [{ route, elements: [...] }] }.
// We accept BOTH so this gate reads the real ledger as written.
function readLedger(file) {
  if (!fs.existsSync(file)) {
    return { app: null, routes: {}, gaps: [], _missing: true };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { app: null, routes: {}, gaps: [], _error: `unreadable ledger: ${e.message}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { app: null, routes: {}, gaps: [], _error: `invalid ledger JSON: ${e.message}` };
  }
  if (!data || typeof data !== "object") {
    return { app: null, routes: {}, gaps: [], _error: "ledger is not an object" };
  }
  if (data.routes == null) data.routes = {};
  if (!Array.isArray(data.gaps)) data.gaps = [];
  return data;
}

function normalizeVerdict(v) {
  if (typeof v !== "string") return "UNTESTED";
  const up = v.trim().toUpperCase();
  // tolerate common aliases / spacing
  const alias = {
    NOOP: "NO-OP",
    "NO_OP": "NO-OP",
    NAVIGATE: "NAVIGATES",
    PASS: "WORKS",
    WORK: "WORKS",
  };
  const canon = alias[up] || up;
  return VERDICTS.includes(canon) ? canon : "UNCERTAIN";
}

// Normalize ledger.routes (object-keyed OR array) into [{ name, elements }].
function routeEntries(routes) {
  if (Array.isArray(routes)) {
    return routes.map((r) => ({
      name: (r && (r.route || r.url || r.name || r.path)) || "(unknown route)",
      elements: (r && Array.isArray(r.elements)) ? r.elements : [],
    }));
  }
  if (routes && typeof routes === "object") {
    return Object.keys(routes).map((key) => {
      const r = routes[key] || {};
      return {
        name: key,
        elements: Array.isArray(r.elements) ? r.elements : [],
      };
    });
  }
  return [];
}

// Flatten ledger into a list of {route, selector, label, verdict, evidence, reason}.
function collectCells(ledger) {
  const cells = [];
  for (const route of routeEntries(ledger.routes)) {
    for (const el of route.elements) {
      const e = el || {};
      cells.push({
        route: route.name,
        selector: e.selector || e.ref || e.id || "(no selector)",
        label: e.accessibleName || e.label || e.text || e.name || "",
        verdict: normalizeVerdict(e.verdict),
        evidence: e.evidence || e.note || e.summary || "",
        reason: e.reason || e.why || "",
      });
    }
  }
  return cells;
}

function computeCoverage(cells) {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const c of cells) counts[c.verdict] = (counts[c.verdict] || 0) + 1;

  const total = cells.length;
  const untested = cells.filter((c) => c.verdict === "UNTESTED");
  const uncertain = cells.filter((c) => c.verdict === "UNCERTAIN");
  const incomplete = cells.filter((c) => INCOMPLETE_VERDICTS.has(c.verdict));
  const defects = cells.filter((c) => DEFECT_VERDICTS.has(c.verdict));
  const verified = cells.filter((c) => !INCOMPLETE_VERDICTS.has(c.verdict));

  return {
    total,
    verifiedCount: verified.length,
    untestedCount: untested.length,
    uncertainCount: uncertain.length,
    incompleteCount: incomplete.length,
    defectCount: defects.length,
    counts,
    untested,
    uncertain,
    incomplete,
    defects,
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function renderTable(cells) {
  if (cells.length === 0) return "(no controls recorded)";
  const rows = cells.map((c) => ({
    route: c.route,
    selector: c.selector,
    verdict: c.verdict,
    evidence: c.verdict === "DISABLED" && c.reason ? c.reason : (c.evidence || ""),
  }));
  const wRoute = Math.max(5, ...rows.map((r) => r.route.length));
  const wSel = Math.max(8, ...rows.map((r) => r.selector.length));
  const wVer = Math.max(7, ...rows.map((r) => r.verdict.length));
  const lines = [];
  lines.push(`${pad("ROUTE", wRoute)}  ${pad("SELECTOR", wSel)}  ${pad("VERDICT", wVer)}  EVIDENCE`);
  lines.push(`${"-".repeat(wRoute)}  ${"-".repeat(wSel)}  ${"-".repeat(wVer)}  --------`);
  for (const r of rows) {
    lines.push(`${pad(r.route, wRoute)}  ${pad(r.selector, wSel)}  ${pad(r.verdict, wVer)}  ${r.evidence}`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = args.app && args.app !== true ? args.app : null;
  const projectDir = (args["project-dir"] && args["project-dir"] !== true)
    ? args["project-dir"]
    : (process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const requireClean = !!args["require-clean"];
  const asJson = !!args.json;

  if (!app) {
    process.stderr.write("qa_coverage: --app <name> is required\n");
    process.exit(2);
  }

  const file = ledgerPath(projectDir, app);
  const ledger = readLedger(file);

  if (ledger._error) {
    // A corrupt ledger is NOT a pass — treat as a hard block.
    process.stderr.write(`qa_coverage: ${ledger._error} (${file})\n`);
    if (asJson) {
      process.stdout.write(JSON.stringify({ gate: "BLOCKED", reason: ledger._error, ledgerPath: file }, null, 2) + "\n");
    } else {
      process.stdout.write(`GATE: BLOCKED (ledger error: ${ledger._error})\n`);
    }
    process.exit(2);
  }

  const cells = collectCells(ledger);
  const cov = computeCoverage(cells);

  const incomplete = cov.incompleteCount > 0;
  const hasDefects = cov.defectCount > 0;
  // No controls recorded at all (missing/empty ledger) is NOT a pass — there is
  // zero evidence anything was verified. Count it as incomplete coverage.
  const noEvidence = cov.total === 0;

  // Decide gate + exit code.
  let exitCode = 0;
  let gate = "PASS";
  let gateDetail = "";
  if (noEvidence) {
    exitCode = 2;
    gate = "BLOCKED";
    gateDetail = ledger._missing
      ? "no ledger — 0 controls recorded (zero coverage)"
      : "0 controls recorded (zero coverage)";
  } else if (incomplete) {
    exitCode = 2;
    gate = "BLOCKED";
    gateDetail = `${cov.untestedCount} untested, ${cov.uncertainCount} uncertain`;
  } else if (requireClean && hasDefects) {
    exitCode = 1;
    gate = "BLOCKED";
    gateDetail = `${cov.defectCount} defect(s)`;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({
      gate,
      gateDetail,
      app,
      slug: slugify(app),
      ledgerPath: file,
      ledgerMissing: !!ledger._missing,
      requireClean,
      coverage: {
        total: cov.total,
        verified: cov.verifiedCount,
        untested: cov.untestedCount,
        uncertain: cov.uncertainCount,
        defects: cov.defectCount,
        counts: cov.counts,
      },
      cells,
    }, null, 2) + "\n");
    process.exit(exitCode);
  }

  // Human summary.
  const out = [];
  out.push(`EXHAUSTIVE QA COVERAGE — app "${app}" (slug: ${slugify(app)})`);
  out.push(`ledger: ${file}${ledger._missing ? "  [MISSING — treated as zero coverage]" : ""}`);
  out.push("");
  out.push(renderTable(cells));
  out.push("");
  out.push("Verdict tally:");
  for (const v of VERDICTS) {
    if (cov.counts[v]) out.push(`  ${pad(v, 10)} ${cov.counts[v]}`);
  }
  out.push("");
  out.push(`Coverage: ${cov.verifiedCount} of ${cov.total} controls verified`
    + ` (${cov.untestedCount} untested, ${cov.uncertainCount} uncertain, ${cov.defectCount} defect(s)).`);

  // The explicit "Did NOT verify / why" list — never silently dropped.
  if (cov.incompleteCount > 0) {
    out.push("");
    out.push("Did NOT verify (gate blockers):");
    for (const c of cov.incomplete) {
      const why = c.verdict === "UNCERTAIN"
        ? (c.reason || c.evidence || "no confident verdict")
        : (c.reason || "never exercised");
      out.push(`  - [${c.verdict}] ${c.route} :: ${c.selector} — ${why}`);
    }
  }
  if (cov.defectCount > 0) {
    out.push("");
    out.push("Defects (NO-OP / ERROR):");
    for (const c of cov.defects) {
      out.push(`  - [${c.verdict}] ${c.route} :: ${c.selector} — ${c.evidence || c.reason || "(no evidence captured)"}`);
    }
  }

  // Ledger-level gaps: the agent's explicit "could not verify X" notes (e.g. a
  // route requiring an account we don't have). Reported, never silently dropped.
  if (Array.isArray(ledger.gaps) && ledger.gaps.length > 0) {
    out.push("");
    out.push("Known gaps (could not verify):");
    for (const g of ledger.gaps) out.push(`  - ${g}`);
  }

  out.push("");
  if (gate === "PASS") {
    out.push("GATE: PASS");
  } else {
    out.push(`GATE: BLOCKED (${gateDetail})`);
  }
  process.stdout.write(out.join("\n") + "\n");
  process.exit(exitCode);
}

main();

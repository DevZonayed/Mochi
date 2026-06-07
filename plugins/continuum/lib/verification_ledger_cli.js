#!/usr/bin/env node
// CLI shim for the verification ledger. Backs the QA honesty-gate flow:
// record each control's verdict, then read/coverage to assert "N of M verified".
//
// Subcommands:
//   read        --app X                     -> the full ledger JSON
//   record      --app X --route Y --element '<json>'
//                                           -> merged ledger (or short summary)
//   coverage    --app X                     -> coverage rollup JSON
//   set-bundle  --app X --hash H            -> ledger after stamping bundle_hash
//   gap         --app X --text "..."        -> ledger after adding a gap note
//
// All subcommands accept [--project-dir P] and [--json|--quiet]. Default
// project dir is CLAUDE_PROJECT_DIR || cwd, matching recall_cli / feedback_cli.

import {
  readLedger,
  recordElement,
  coverage,
  setBundle,
  addGap,
  ledgerPath,
} from "./verification_ledger.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      args[key] = (next === undefined || next.startsWith("--")) ? true : argv[++i];
    } else args._.push(a);
  }
  return args;
}

function requireApp(args) {
  const app = args.app;
  if (!app || app === true) {
    process.stderr.write("verification_ledger: --app <name> is required\n");
    process.exit(2);
  }
  return app;
}

function out(obj, args) {
  process.stdout.write(JSON.stringify(obj, null, args.json ? 2 : 0) + "\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  const projectDir = args["project-dir"] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (sub === "read") {
    const app = requireApp(args);
    out(readLedger(projectDir, app), args);
    return;
  }

  if (sub === "record") {
    const app = requireApp(args);
    const route = args.route;
    if (!route || route === true) {
      process.stderr.write("verification_ledger record: --route <route> is required\n");
      process.exit(2);
    }
    if (!args.element || args.element === true) {
      process.stderr.write("verification_ledger record: --element '<json>' is required\n");
      process.exit(2);
    }
    let element;
    try { element = JSON.parse(String(args.element)); }
    catch {
      process.stderr.write("verification_ledger record: --element is not valid JSON\n");
      process.exit(2);
    }
    const ledger = recordElement(projectDir, app, route, element);
    if (args.quiet) {
      const c = coverage(ledger);
      process.stdout.write(`recorded ${element.id ?? element.selector} (${element.verdict ?? "UNTESTED"}) on ${route} — ${c.covered}/${c.total} covered\n`);
    } else {
      out(ledger, args);
    }
    return;
  }

  if (sub === "coverage") {
    const app = requireApp(args);
    const ledger = readLedger(projectDir, app);
    const c = coverage(ledger);
    if (args.quiet) {
      const verdicts = Object.entries(c.byVerdict).map(([k, v]) => `${k}=${v}`).join(" ");
      process.stdout.write(`${c.covered}/${c.total} covered (${c.pct}%) · defects=${c.defects} untested=${c.untested} uncertain=${c.uncertain}${verdicts ? " · " + verdicts : ""}\n`);
    } else {
      out({ app: ledger.app, ledgerPath: ledgerPath(projectDir, app), ...c, gaps: ledger.gaps }, args);
    }
    return;
  }

  if (sub === "set-bundle") {
    const app = requireApp(args);
    const hash = (args.hash && args.hash !== true) ? String(args.hash) : null;
    out(setBundle(projectDir, app, hash), args);
    return;
  }

  if (sub === "gap") {
    const app = requireApp(args);
    if (!args.text || args.text === true) {
      process.stderr.write("verification_ledger gap: --text \"...\" is required\n");
      process.exit(2);
    }
    out(addGap(projectDir, app, String(args.text)), args);
    return;
  }

  process.stderr.write(`unknown subcommand: ${sub ?? "(none)"}\n`);
  process.stderr.write("usage: verification_ledger_cli.js <read|record|coverage|set-bundle|gap> --app X [...]\n");
  process.exit(2);
}

main();

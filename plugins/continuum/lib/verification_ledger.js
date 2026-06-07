// Verification ledger — the per-app QA coverage record for Mochi 0.5.0.
//
// Where the Phase-3 verification_log.js tracks transient frontend *changes*
// between checkpoints, this ledger is the durable, app-scoped truth of which
// interactive controls have actually been exercised and what verdict each got.
// It is the data backbone of the "N of M controls verified" honesty rule:
// you can only claim a control works if there is a ledger entry that says so.
//
// Storage: pretty-printed JSON (NOT YAML) under
//   .continuum/verification/<slug(app)>.json
// Zero external deps by design — the continuum lib has no node_modules. Atomic
// writes (tmp + rename) keep the file readable even if a write is interrupted.
//
// Verdicts (mirrors the locked 0.5.0 tool surface):
//   WORKS       — clicked/typed and the page did something correct
//   NO-OP       — clickable but nothing happened (a dead control = defect)
//   ERROR       — interaction threw / produced a console error or >=400
//   NAVIGATES   — the action took us to another route (recorded, not a defect)
//   DISABLED    — the control is disabled and was correctly skipped
//   UNTESTED    — enumerated but never exercised (NOT coverage)
//   UNCERTAIN   — exercised but the outcome could not be confirmed (NOT coverage)

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

// Lowercase + collapse any run of non-alphanumerics to a single '-', then trim
// leading/trailing '-'. "My App (v2)!" -> "my-app-v2". Empty/garbage -> "app".
export function slug(app) {
  const s = String(app || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "app";
}

export function ledgerPath(projectDir, app) {
  return path.join(paths(projectDir).root, "verification", slug(app) + ".json");
}

// A fresh, empty ledger skeleton. Returned whenever the file is missing or
// unparseable so callers never have to null-check the shape.
function skeleton(app) {
  return { app: app ?? null, bundle_hash: null, verified_at: null, routes: {}, gaps: [] };
}

export function readLedger(projectDir, app) {
  const f = ledgerPath(projectDir, app);
  if (!fs.existsSync(f)) return skeleton(app);
  try {
    const obj = JSON.parse(fs.readFileSync(f, "utf8"));
    // Defensive: ensure the required containers exist even if an older/partial
    // file was written by hand.
    if (!obj || typeof obj !== "object") return skeleton(app);
    if (obj.app == null) obj.app = app ?? null;
    if (!obj.routes || typeof obj.routes !== "object") obj.routes = {};
    if (!Array.isArray(obj.gaps)) obj.gaps = [];
    if (!("bundle_hash" in obj)) obj.bundle_hash = null;
    if (!("verified_at" in obj)) obj.verified_at = null;
    return obj;
  } catch {
    return skeleton(app);
  }
}

// Atomic write: serialize to a sibling tmp file then rename over the target so
// a reader never sees a half-written ledger. mkdir -p the verification/ dir.
export function writeLedger(projectDir, app, obj) {
  const f = ledgerPath(projectDir, app);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, f);
  return obj;
}

// Upsert an element under routes[route].elements[], keyed by element.id (or
// element.selector as a fallback). Re-recording the same control overwrites the
// prior verdict — the ledger reflects the *latest* observation, not history.
// Stamps verified_at = now ISO and returns the merged ledger.
export function recordElement(projectDir, app, route, element) {
  if (!route) throw new Error("recordElement: route required");
  if (!element || typeof element !== "object") throw new Error("recordElement: element object required");
  const key = element.id ?? element.selector;
  if (!key) throw new Error("recordElement: element needs an id or selector");

  const ledger = readLedger(projectDir, app);
  if (!ledger.routes[route] || typeof ledger.routes[route] !== "object") {
    ledger.routes[route] = { elements: [] };
  }
  if (!Array.isArray(ledger.routes[route].elements)) {
    ledger.routes[route].elements = [];
  }

  const elements = ledger.routes[route].elements;
  const idx = elements.findIndex((e) => (e.id ?? e.selector) === key);
  if (idx >= 0) elements[idx] = { ...elements[idx], ...element };
  else elements.push({ ...element });

  ledger.verified_at = new Date().toISOString();
  writeLedger(projectDir, app, ledger);
  return ledger;
}

// Record the bundle hash this verification pass ran against (stale-bundle guard
// pairs with staleSinceBundle()). Also bumps verified_at.
export function setBundle(projectDir, app, hash) {
  const ledger = readLedger(projectDir, app);
  ledger.bundle_hash = hash ?? null;
  ledger.verified_at = new Date().toISOString();
  writeLedger(projectDir, app, ledger);
  return ledger;
}

// Push a "could not verify X" note. Deduped — recording the same gap twice is a
// no-op. Gaps are the explicit "here is what I could NOT verify and why" half of
// the honesty rule.
export function addGap(projectDir, app, text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("addGap: text required");
  const ledger = readLedger(projectDir, app);
  if (!ledger.gaps.includes(t)) ledger.gaps.push(t);
  writeLedger(projectDir, app, ledger);
  return ledger;
}

// Coverage rollup across every element in every route. covered = total minus
// the two non-coverage verdicts (UNTESTED, UNCERTAIN). defects = NO-OP + ERROR.
// pct is integer percent of covered/total (0 when total is 0).
export function coverage(ledger) {
  const byVerdict = {};
  let total = 0;
  const routes = (ledger && ledger.routes) || {};
  for (const route of Object.keys(routes)) {
    const els = Array.isArray(routes[route].elements) ? routes[route].elements : [];
    for (const e of els) {
      total += 1;
      const v = e.verdict || "UNTESTED";
      byVerdict[v] = (byVerdict[v] || 0) + 1;
    }
  }
  const untested = byVerdict["UNTESTED"] || 0;
  const uncertain = byVerdict["UNCERTAIN"] || 0;
  const defects = (byVerdict["NO-OP"] || 0) + (byVerdict["ERROR"] || 0);
  const covered = total - untested - uncertain;
  const pct = total === 0 ? 0 : Math.round((covered / total) * 100);
  return { total, byVerdict, untested, uncertain, defects, covered, pct };
}

// Is the ledger's verification stale relative to a freshly observed bundle hash?
// stale=true only when we actually have a new hash AND it differs from what the
// ledger was verified against. A null/absent newHash means "can't tell" -> not
// stale (don't cry wolf).
export function staleSinceBundle(ledger, newHash) {
  const recorded = (ledger && ledger.bundle_hash) || null;
  if (!newHash) return { stale: false, reason: "no current bundle hash to compare" };
  if (!recorded) return { stale: false, reason: "ledger has no recorded bundle hash yet" };
  if (newHash !== recorded) {
    return {
      stale: true,
      reason: `bundle changed since last verification (recorded ${String(recorded).slice(0, 12)} != current ${String(newHash).slice(0, 12)}) — re-verify`,
    };
  }
  return { stale: false, reason: "bundle matches last verification" };
}

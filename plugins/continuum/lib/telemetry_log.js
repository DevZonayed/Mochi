// telemetry_log.js — local Zone-A event store (Arm 1). Mirrors the run-history
// shape in server/src/memory.js: append-only JSONL + a capped/aged prune that
// rewrites atomically (tmp + rename), preserving chronological order.
//
// HOT-PATH SAFETY (spec §4/§13.7): appendEvent is the ONLY thing the PreToolUse
// hook calls. It does ONE synchronous fs.appendFileSync of a single line — NO
// network, NO LLM, NO redaction, NO heavy parse. Redaction is the EMIT boundary
// (telemetry_redact.js), not the capture boundary, so the hook stays ~1ms.

import fs from "node:fs";
import path from "node:path";
import { telemetryEventsPath, telemetryDir } from "./paths.js";

// appendEvent — one JSONL line, append-only. Fault-tolerant: a write failure is
// swallowed (telemetry must never crash a session). Stores the event VERBATIM.
export function appendEvent(projectDir, event) {
  try {
    const file = telemetryEventsPath(projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    // swallow — never throw in the hot path.
  }
}

// readEvents — parse the JSONL into an array; skip blank/corrupt lines.
export function readEvents(projectDir) {
  const file = telemetryEventsPath(projectDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function writeAllAtomic(projectDir, rows) {
  const dir = telemetryDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = telemetryEventsPath(projectDir);
  const tmp = file + "." + process.pid + ".tmp";
  const text = rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// pruneEvents — cap by size (newest maxLines) AND age (drop ts older than
// maxAgeDays). Mirrors memory.js pruneRuns: keep newest, restore chronological
// order, rewrite atomically. `ts` is in seconds; `now` is in ms (injectable).
export function pruneEvents(projectDir, { maxLines = 5000, maxAgeDays = 180, now = Date.now() } = {}) {
  const rows = readEvents(projectDir);
  if (rows.length === 0) return;
  const cutoffSec = Math.floor(now / 1000) - maxAgeDays * 86400;
  let kept = rows.filter((r) => Number(r.ts) >= cutoffSec);
  if (kept.length > maxLines) {
    // newest-first by ts, take maxLines, then restore chronological order.
    kept = kept.slice().sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, maxLines);
    kept.sort((a, b) => Number(a.ts) - Number(b.ts));
  }
  if (kept.length !== rows.length) writeAllAtomic(projectDir, kept);
}

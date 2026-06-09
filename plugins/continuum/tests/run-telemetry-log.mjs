// plugins/continuum/tests/run-telemetry-log.mjs
// telemetry_log.js: append-only JSONL (hot-path-safe) + capped/aged prune,
// mirroring server/src/memory.js run-history (append + _writeRunsAll prune).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendEvent, readEvents, pruneEvents } from "../lib/telemetry_log.js";
import { telemetryEventsPath } from "../lib/paths.js";

function ev(over = {}) {
  return { ts: 1000, sid: "s", iid: "i", tool: "Read", mcp: "", ok: true,
    err: "other", dur_b: "0-1s", v: "0.7.0", os: "darwin", ...over };
}

// 1) appendEvent writes ONE JSONL line per call; readEvents round-trips in order.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-rt-"));
  appendEvent(dir, ev({ ts: 1, tool: "Read" }));
  appendEvent(dir, ev({ ts: 2, tool: "Edit" }));
  const text = fs.readFileSync(telemetryEventsPath(dir), "utf8");
  assert.equal(text.trim().split("\n").length, 2, "one line per appended event");
  const rows = readEvents(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, "Read");
  assert.equal(rows[1].tool, "Edit");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) hot-path safety: appendEvent writes the object verbatim (NO redaction here)
//    — redaction is the emit boundary; the hook must stay ~1ms append-only.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-verbatim-"));
  appendEvent(dir, ev({ tool: "mcp__client_x__do" }));
  assert.equal(readEvents(dir)[0].tool, "mcp__client_x__do",
    "log stores verbatim; bucketing happens at emit-time redact, not in the hot path");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) readEvents skips blank + corrupt lines (fault-tolerant).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-corrupt-"));
  fs.mkdirSync(path.dirname(telemetryEventsPath(dir)), { recursive: true });
  fs.writeFileSync(telemetryEventsPath(dir),
    JSON.stringify(ev({ ts: 1 })) + "\n\n{bad json\n" + JSON.stringify(ev({ ts: 2 })) + "\n");
  const rows = readEvents(dir);
  assert.equal(rows.length, 2, "blank + corrupt lines skipped");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4) pruneEvents caps to the newest maxLines, preserving chronological order.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-cap-"));
  for (let i = 1; i <= 5; i++) appendEvent(dir, ev({ ts: i }));
  pruneEvents(dir, { maxLines: 3, maxAgeDays: 9999, now: 5 * 1000 });
  const rows = readEvents(dir);
  assert.equal(rows.length, 3, "capped to newest 3");
  assert.deepEqual(rows.map((r) => r.ts), [3, 4, 5], "kept newest, chronological order");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5) pruneEvents drops events older than maxAgeDays (by ts seconds).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-age-"));
  const nowSec = 1_700_000_000;
  const DAY = 86400;
  appendEvent(dir, ev({ ts: nowSec - 200 * DAY })); // too old
  appendEvent(dir, ev({ ts: nowSec - 10 * DAY }));  // recent
  pruneEvents(dir, { maxLines: 9999, maxAgeDays: 180, now: nowSec * 1000 });
  const rows = readEvents(dir);
  assert.equal(rows.length, 1, "old event aged out");
  assert.equal(rows[0].ts, nowSec - 10 * DAY);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6) prune writes atomically (no leftover .tmp) and no-ops under cap.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-atomic-"));
  appendEvent(dir, ev({ ts: 1 }));
  pruneEvents(dir, { maxLines: 100, maxAgeDays: 9999, now: 2000 });
  const leftovers = fs.readdirSync(path.dirname(telemetryEventsPath(dir))).filter((f) => f.includes(".tmp"));
  assert.equal(leftovers.length, 0, "no .tmp leftovers (atomic rename)");
  assert.equal(readEvents(dir).length, 1, "under cap => unchanged");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("✓ telemetry_log (append + prune, hot-path-safe)");

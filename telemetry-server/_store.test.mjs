import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dayBucket, eventsPath, appendEvents, readAllEvents, sweepRetention, eraseIid } from "./store.mjs";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tele-store-")); }

test("dayBucket converts epoch-seconds ts to YYYY-MM-DD (UTC)", () => {
  assert.equal(dayBucket(1717900000), "2024-06-09");
});

test("appendEvents writes one JSONL line per event to /data/events/<day>.jsonl", () => {
  const dir = tmp();
  appendEvents(dir, [{ ts: 1717900000, tool: "Read" }, { ts: 1717900001, tool: "Edit" }]);
  const p = eventsPath(dir, "2024-06-09");
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).tool, "Read");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendEvents day-buckets by each event's own ts (cross-midnight)", () => {
  const dir = tmp();
  appendEvents(dir, [{ ts: 1717900000, tool: "A" }, { ts: 1718000000, tool: "B" }]);
  assert.ok(fs.existsSync(eventsPath(dir, "2024-06-09")));
  assert.ok(fs.existsSync(eventsPath(dir, "2024-06-10")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readAllEvents reads every day-file back as parsed objects", () => {
  const dir = tmp();
  appendEvents(dir, [{ ts: 1717900000, tool: "A" }, { ts: 1718000000, tool: "B" }]);
  const all = readAllEvents(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.tool).sort(), ["A", "B"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepRetention deletes day-files older than RETENTION_DAYS", () => {
  const dir = tmp();
  const evDir = path.join(dir, "events");
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, "2000-01-01.jsonl"), "{}\n");
  const today = dayBucket(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(evDir, `${today}.jsonl`), "{}\n");
  const removed = sweepRetention(dir, 180, Date.now());
  assert.ok(removed.includes("2000-01-01.jsonl"));
  assert.ok(!fs.existsSync(path.join(evDir, "2000-01-01.jsonl")));
  assert.ok(fs.existsSync(path.join(evDir, `${today}.jsonl`)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepRetention drops iid after the dedup window (keeps aggregate fields)", () => {
  const dir = tmp();
  const oldTs = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const day = dayBucket(oldTs);
  appendEvents(dir, [{ ts: oldTs, iid: "i-secret", tool: "Read", mcp: "", ok: true }]);
  sweepRetention(dir, 180, Date.now(), { dedupWindowDays: 7 });
  const lines = fs.readFileSync(eventsPath(dir, day), "utf8").split("\n").filter(Boolean);
  const ev = JSON.parse(lines[0]);
  assert.ok(!("iid" in ev) || ev.iid === "", "iid dropped after dedup window");
  assert.equal(ev.tool, "Read", "aggregate fields preserved");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepRetention KEEPS iid for events inside the dedup window", () => {
  const dir = tmp();
  const nowSec = Math.floor(Date.now() / 1000);
  const recentTs = nowSec - 60 * 60 * 24 * 2;   // 2 days ago — within default 7-day window
  const oldTs    = nowSec - 60 * 60 * 24 * 30;  // 30 days ago — outside window
  const recentDay = dayBucket(recentTs);
  const oldDay    = dayBucket(oldTs);
  appendEvents(dir, [
    { ts: recentTs, iid: "i-fresh", tool: "Read",  mcp: "", ok: true },
    { ts: oldTs,    iid: "i-stale", tool: "Write", mcp: "", ok: true },
  ]);
  sweepRetention(dir, 180, Date.now(), { dedupWindowDays: 7 });
  // Recent event: iid must still be present
  const recentLines = fs.readFileSync(eventsPath(dir, recentDay), "utf8").split("\n").filter(Boolean);
  const recentEv = JSON.parse(recentLines[0]);
  assert.equal(recentEv.iid, "i-fresh", "iid preserved for recent event inside dedup window");
  // Old event: iid must have been stripped
  const oldLines = fs.readFileSync(eventsPath(dir, oldDay), "utf8").split("\n").filter(Boolean);
  const oldEv = JSON.parse(oldLines[0]);
  assert.ok(!("iid" in oldEv) || oldEv.iid === "", "iid dropped for old event outside dedup window");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("eraseIid removes every stored event for an iid (GDPR erasure), returns count", () => {
  const dir = tmp();
  appendEvents(dir, [
    { ts: 1717900000, iid: "i-erase", tool: "A" },
    { ts: 1717900001, iid: "i-keep", tool: "B" },
    { ts: 1718000000, iid: "i-erase", tool: "C" },
  ]);
  const removed = eraseIid(dir, "i-erase");
  assert.equal(removed, 2);
  const left = readAllEvents(dir);
  assert.deepEqual(left.map((e) => e.iid), ["i-keep"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readAllEvents skips blank + corrupt lines (fault-tolerant), eraseIid preserves them", () => {
  const dir = tmp();
  // Write a day-file manually: valid line, blank line, corrupt line, valid line
  // This mirrors the exact pattern tested in plugins/continuum/tests/run-telemetry-log.mjs test #3.
  const evDir = path.join(dir, "events");
  fs.mkdirSync(evDir, { recursive: true });
  const good1 = JSON.stringify({ ts: 1717900000, iid: "i-good", tool: "Read" });
  const good2 = JSON.stringify({ ts: 1717900001, iid: "i-good", tool: "Edit" });
  fs.writeFileSync(path.join(evDir, "2024-06-09.jsonl"),
    good1 + "\n\n{bad json\n" + good2 + "\n");
  // readAllEvents must return only the 2 valid events, skipping blank + corrupt
  const all = readAllEvents(dir);
  assert.equal(all.length, 2, "blank + corrupt lines skipped by readAllEvents");
  assert.deepEqual(all.map((e) => e.tool).sort(), ["Edit", "Read"]);
  // eraseIid for a different iid must preserve the corrupt line (catch { kept.push(line) })
  const removed = eraseIid(dir, "i-other");
  assert.equal(removed, 0, "no events removed for unknown iid");
  const raw = fs.readFileSync(path.join(evDir, "2024-06-09.jsonl"), "utf8");
  assert.ok(raw.includes("{bad json"), "corrupt line preserved through eraseIid");
  fs.rmSync(dir, { recursive: true, force: true });
});

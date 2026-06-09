// telemetry-server/store.mjs
// Date-bucketed JSONL persistence on the /data volume. No DB (§6). Mirrors the
// append+prune discipline of server/src/memory.js run-history. All retention,
// iid-dropping (§13.4) and erasure (§13.4 DELETE) operate over plain day-files.
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayBucket(tsSeconds) {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
export function eventsDir(dataDir) { return path.join(dataDir, "events"); }
export function eventsPath(dataDir, day) { return path.join(eventsDir(dataDir), `${day}.jsonl`); }

export function appendEvents(dataDir, events) {
  const byDay = new Map();
  for (const e of events) {
    // Fall back to current time (seconds) when ts is absent or non-numeric so
    // that distillation records (which carry no ts field) land in today's bucket
    // rather than 1970-01-01.jsonl where they would be immediately swept away.
    const tsSeconds = typeof e.ts === "number" ? e.ts : Math.floor(Date.now() / 1000);
    const day = dayBucket(tsSeconds);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(JSON.stringify(e));
  }
  fs.mkdirSync(eventsDir(dataDir), { recursive: true });
  for (const [day, lines] of byDay) {
    fs.appendFileSync(eventsPath(dataDir, day), lines.join("\n") + "\n");
  }
}

function dayFiles(dataDir) {
  const dir = eventsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
}

export function readAllEvents(dataDir) {
  const out = [];
  for (const f of dayFiles(dataDir)) {
    const txt = fs.readFileSync(path.join(eventsDir(dataDir), f), "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
  }
  return out;
}

// Expire whole day-files older than retentionDays; within still-kept files,
// strip `iid` from events older than the dedup window. Returns removed filenames.
export function sweepRetention(dataDir, retentionDays, nowMs = Date.now(), { dedupWindowDays = 7 } = {}) {
  const removed = [];
  const cutoffExpire = nowMs - retentionDays * DAY_MS;
  const cutoffDedup = Math.floor((nowMs - dedupWindowDays * DAY_MS) / 1000);
  for (const f of dayFiles(dataDir)) {
    const day = f.slice(0, 10);
    const dayMs = Date.parse(day + "T00:00:00Z");
    if (Number.isFinite(dayMs) && dayMs < cutoffExpire) {
      fs.rmSync(path.join(eventsDir(dataDir), f), { force: true });
      removed.push(f);
      continue;
    }
    const p = path.join(eventsDir(dataDir), f);
    let changed = false;
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return line; }
      if ("iid" in ev && typeof ev.ts === "number" && ev.ts < cutoffDedup) {
        delete ev.iid; changed = true; return JSON.stringify(ev);
      }
      return line;
    });
    if (changed) fs.writeFileSync(p, lines.join("\n") + "\n");
  }
  return removed;
}

// Owner-triggered erasure for a single install-id across all day-files.
export function eraseIid(dataDir, iid) {
  let removed = 0;
  for (const f of dayFiles(dataDir)) {
    const p = path.join(eventsDir(dataDir), f);
    const kept = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { kept.push(line); continue; }
      if (ev.iid === iid) { removed++; continue; }
      kept.push(line);
    }
    if (kept.length) fs.writeFileSync(p, kept.join("\n") + "\n");
    else fs.rmSync(p, { force: true });
  }
  return removed;
}

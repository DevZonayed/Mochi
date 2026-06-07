// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lock.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { consoleLogger, acquireLock, releaseLock, readLock } from "./src/comms/whatsapp.js";

// 1) console-logger shim: pino-shaped, no throw, child() returns a logger.
{
  const calls = [];
  const lg = consoleLogger({ level: "info", write: (s) => calls.push(s) });
  assert.equal(lg.level, "info");
  for (const m of ["trace","debug","info","warn","error","fatal"]) assert.equal(typeof lg[m], "function");
  lg.info({ a: 1 }, "hello");
  lg.error("boom");
  const child = lg.child({ mod: "wa" });
  assert.equal(typeof child.info, "function");
  child.warn("nested");
  assert.ok(calls.length >= 1);
  assert.ok(calls.join("\n").includes("hello"));
}

// 2) lockfile acquire writes {pid, startedAt}; double-acquire by a LIVE pid refuses.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-lock-"));
  const ok = await acquireLock(dir);
  assert.equal(ok.acquired, true);
  const lk = await readLock(dir);
  assert.equal(lk.pid, process.pid);
  assert.equal(typeof lk.startedAt, "number");

  // Simulate another live process already holding it (current pid is alive) -> refuse.
  const again = await acquireLock(dir);
  assert.equal(again.acquired, false);
  assert.equal(again.reason, "held");
  assert.equal(again.holder.pid, process.pid);

  await releaseLock(dir);
  const after = await readLock(dir);
  assert.equal(after, null);

  await fs.rm(dir, { recursive: true, force: true });
}

// 3) stale lock (dead pid) is reclaimed.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-lock2-"));
  await fs.mkdir(dir, { recursive: true });
  // pid that cannot be alive (very large); startedAt in the past.
  await fs.writeFile(path.join(dir, ".lock"), JSON.stringify({ pid: 2 ** 30, startedAt: 1 }));
  const ok = await acquireLock(dir);
  assert.equal(ok.acquired, true, "stale (dead-pid) lock must be reclaimed");
  const lk = await readLock(dir);
  assert.equal(lk.pid, process.pid);
  await releaseLock(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp logger + lockfile");

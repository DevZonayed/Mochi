// server/_uploads.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { sha256, uploadsDir, initUploads } from "./src/uploads.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-uploads-test-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initUploads();

assert.equal(sha256(Buffer.from("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
assert.equal(uploadsDir(), path.join(tmp, ".continuum", "uploads"));

const stat = await fs.stat(path.join(tmp, ".continuum", "uploads"));
assert.ok(stat.isDirectory());
const idxRaw = await fs.readFile(path.join(tmp, ".continuum", "uploads", "index.json"), "utf8");
assert.deepEqual(JSON.parse(idxRaw), { version: 1, entries: [] });

console.log("✓ Task 1 — scaffold");
await fs.rm(tmp, { recursive: true, force: true });

import { readIndex, writeIndex } from "./src/uploads.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-uploads-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initUploads();

  const idx = await readIndex();
  assert.deepEqual(idx, { version: 1, entries: [] });

  idx.entries.push({ stashId: "u_abc", sha256: "abc", ext: "png", mime: "image/png", name: "x.png", sizeBytes: 1, source: { kind: "base64" }, keep: "session", sessionId: null, createdAt: "2026-05-19T00:00:00Z", lastUsedAt: "2026-05-19T00:00:00Z" });
  await writeIndex(idx);
  const idx2 = await readIndex();
  assert.equal(idx2.entries.length, 1);
  assert.equal(idx2.entries[0].stashId, "u_abc");

  // verify atomic: index.json.tmp must not linger
  const dir = await fs.readdir(path.join(tmp, ".continuum", "uploads"));
  assert.ok(!dir.includes("index.json.tmp"));

  console.log("✓ Task 2 — atomic index.json read/write");
  await fs.rm(tmp, { recursive: true, force: true });
}

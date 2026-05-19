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

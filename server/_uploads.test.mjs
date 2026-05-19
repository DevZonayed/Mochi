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

import { sniffMime, extForMime } from "./src/uploads.js";

{
  // PNG magic bytes
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,0]);
  assert.equal(sniffMime(png), "image/png");

  // JPEG SOI
  const jpg = Buffer.from([0xff,0xd8,0xff,0xe0, 0,0,0,0]);
  assert.equal(sniffMime(jpg), "image/jpeg");

  // GIF
  const gif = Buffer.from("GIF89a", "binary");
  assert.equal(sniffMime(gif), "image/gif");

  // WebP — RIFF...WEBP
  const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP")]);
  assert.equal(sniffMime(webp), "image/webp");

  // PDF
  const pdf = Buffer.from("%PDF-1.4");
  assert.equal(sniffMime(pdf), "application/pdf");

  // unknown
  assert.equal(sniffMime(Buffer.from("hello")), "application/octet-stream");

  // extForMime
  assert.equal(extForMime("image/png"), "png");
  assert.equal(extForMime("image/jpeg"), "jpg");
  assert.equal(extForMime("application/pdf"), "pdf");
  assert.equal(extForMime("application/octet-stream"), "bin");
  assert.equal(extForMime("video/mp4"), "mp4");
  assert.equal(extForMime("text/plain"), "txt");

  console.log("✓ Task 3 — MIME sniffing");
}

import { stageBuffer } from "./src/uploads.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-uploads-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initUploads();

  const png = Buffer.from([0x89,0x50,0x4e,0x47, ...Buffer.from("body-of-png")]);
  const r1 = await stageBuffer(png, { source: { kind: "test" }, name: "first.png" });
  assert.equal(r1.mime, "image/png");
  assert.equal(r1.sizeBytes, png.length);
  assert.equal(r1.dedupedFrom, undefined);
  assert.match(r1.stashId, /^u_[0-9a-f]{8}$/);
  assert.ok(r1.path.endsWith(".png"));

  // dedup: same bytes → same stashId, dedupedFrom set
  const r2 = await stageBuffer(png, { source: { kind: "test" }, name: "second.png" });
  assert.equal(r2.stashId, r1.stashId);
  assert.equal(r2.dedupedFrom, r1.stashId);

  // index has exactly one entry
  const idx = await readIndex();
  assert.equal(idx.entries.length, 1);

  // blob on disk
  const stat = await fs.stat(r1.path);
  assert.equal(stat.size, png.length);

  console.log("✓ Task 4 — stage from buffer + dedup");
  await fs.rm(tmp, { recursive: true, force: true });
}

import { resolveSource } from "./src/uploads.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-uploads-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initUploads();

  // exclusivity
  await assert.rejects(resolveSource({}), /source-missing/);
  await assert.rejects(resolveSource({ path: "/x", base64: "y" }), /source-conflict/);

  // base64 needs to actually be a buffer
  const r1 = await resolveSource({ base64: Buffer.from("hello-png-body").toString("base64") });
  assert.equal(r1.kind, "base64");
  assert.equal(r1.buf.toString(), "hello-png-body");

  // data URL
  const r2 = await resolveSource({ dataUrl: "data:image/png;base64," + Buffer.from([0x89,0x50,0x4e,0x47]).toString("base64") });
  assert.equal(r2.kind, "dataUrl");
  assert.equal(r2.mime, "image/png");
  assert.equal(r2.buf.length, 4);

  // path
  const onDisk = path.join(tmp, "sample.bin");
  await fs.writeFile(onDisk, "from-disk");
  const r3 = await resolveSource({ path: onDisk });
  assert.equal(r3.kind, "path");
  assert.equal(r3.buf.toString(), "from-disk");

  // stashId
  const staged = await stageBuffer(Buffer.from("stash-bytes"), { source: { kind: "test" } });
  const r4 = await resolveSource({ stashId: staged.stashId });
  assert.equal(r4.kind, "stash");
  assert.equal(r4.buf.toString(), "stash-bytes");
  assert.equal(r4.entry.stashId, staged.stashId);

  // stash-not-found
  await assert.rejects(resolveSource({ stashId: "u_deadbeef" }), /stash-not-found/);

  console.log("✓ Task 5 — source resolver");
  await fs.rm(tmp, { recursive: true, force: true });
}

import http from "node:http";
import { resolveSource as _rs } from "./src/uploads.js";

{
  const srv = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89,0x50,0x4e,0x47, ...Buffer.from("body")]));
    } else if (req.url === "/big") {
      res.writeHead(200);
      res.end(Buffer.alloc(10 * 1024 * 1024));
    } else if (req.url === "/404") {
      res.writeHead(404); res.end("nope");
    } else { res.writeHead(500); res.end("?"); }
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;

  const ok = await _rs({ url: `http://127.0.0.1:${port}/ok` });
  assert.equal(ok.kind, "url");
  assert.equal(ok.mime, "image/png");
  assert.equal(ok.buf.toString("ascii", 4, 8), "body");

  await assert.rejects(_rs({ url: `http://127.0.0.1:${port}/404` }), /fetch-failed/);
  await assert.rejects(_rs({ url: `http://127.0.0.1:${port}/big`, maxBytes: 1024 }), /too-large/);

  srv.close();
  console.log("✓ Task 6 — URL source");
}

import { stage } from "./src/uploads.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-uploads-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initUploads();

  const r = await stage({
    source: { dataUrl: "data:image/png;base64," + Buffer.from([0x89,0x50,0x4e,0x47, ...Buffer.from("payload")]).toString("base64") },
    name: "icon.png",
  });
  assert.equal(r.mime, "image/png");
  assert.equal(r.name, "icon.png");
  assert.equal(r.source.kind, "dataUrl");

  // size cap
  await assert.rejects(stage({
    source: { base64: Buffer.alloc(1024).toString("base64"), mime: "application/octet-stream" },
    maxBytes: 16,
  }), /too-large/);

  console.log("✓ Task 7 — stage() top-level");
  await fs.rm(tmp, { recursive: true, force: true });
}

import { gcSession } from "./src/uploads.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-uploads-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initUploads();

  const a = await stage({ source: { base64: Buffer.from("aaaa").toString("base64") }, keep: "session",    sessionId: "S1" });
  const b = await stage({ source: { base64: Buffer.from("bbbb").toString("base64") }, keep: "session",    sessionId: "S2" });
  const c = await stage({ source: { base64: Buffer.from("cccc").toString("base64") }, keep: "persistent", sessionId: "S1" });

  // share a sha between session-S2 and persistent — should NOT be unlinked when S2 gc's
  const d = await stage({ source: { base64: Buffer.from("dddd").toString("base64") }, keep: "session",    sessionId: "S2" });
  const dPersistent = await stage({ source: { base64: Buffer.from("dddd").toString("base64") }, keep: "persistent", sessionId: null });
  assert.equal(d.stashId, dPersistent.stashId);

  const removed = await gcSession("S1");
  // S1 had `a` session-only → should be gone; `c` persistent → kept
  const idx1 = await readIndex();
  assert.ok(!idx1.entries.find((e) => e.stashId === a.stashId));
  assert.ok( idx1.entries.find((e) => e.stashId === c.stashId));
  assert.ok( idx1.entries.find((e) => e.stashId === b.stashId));
  assert.deepEqual(removed.sort(), [a.stashId].sort());

  // file for `a` should be gone
  await assert.rejects(fs.access(a.path));
  // file for `c` should still be there
  await fs.access(c.path);

  // gc S2 — `b` (only session) should be removed; `d` (also referenced as persistent) keeps blob
  const removed2 = await gcSession("S2");
  const idx2 = await readIndex();
  assert.ok(!idx2.entries.find((e) => e.stashId === b.stashId));
  assert.ok(!idx2.entries.find((e) => e.sessionId === "S2"));
  // persistent twin survives
  assert.ok(idx2.entries.find((e) => e.stashId === dPersistent.stashId && e.keep === "persistent"));
  await fs.access(dPersistent.path);

  console.log("✓ Task 8 — gcSession");
  await fs.rm(tmp, { recursive: true, force: true });
}

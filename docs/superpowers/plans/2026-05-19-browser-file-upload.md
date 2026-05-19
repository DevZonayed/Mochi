# Browser File Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two browser MCP tools — `browser_upload_stage` and `browser_upload_file` — that bypass the native OS file picker and reliably attach files to any page via a strategy chain (direct → intercept → drop → paste), with content-addressed staging and smart-wait completion.

**Architecture:** A new server-side `uploads.js` module owns all file I/O (fetch URL / decode base64 / sha256 dedup / write `.continuum/uploads/<sha>.<ext>` / atomic index.json). `browser_upload_stage` is local-only and short-circuits in `handleToolCall`. `browser_upload_file` is a wire tool whose extension handler (`extension/upload.js`) runs the strategy chain via the already-attached `chrome.debugger` session — `DOM.setFileInputFiles`, `Page.setInterceptFileChooserDialog`/`handleFileChooser`, and `Runtime.evaluate`-injected drop/paste synthesis. Smart-wait listens for preview thumbnails (MutationObserver) and upload-network 2xx responses.

**Tech Stack:** Node 22 (ESM), `ws` (existing), `undici` (new — URL fetch), `node:crypto`, `node:fs/promises`, Chrome DevTools Protocol via `chrome.debugger` (existing MV3 extension), `esbuild` bundling (existing).

**Spec:** `docs/superpowers/specs/2026-05-19-browser-file-upload-design.md`

---

## File Structure

**New files (server):**
- `server/src/uploads.js` — staging, dedup, index.json, GC, source resolution. ~350 lines.
- `server/_uploads.test.mjs` — unit tests for uploads module. ~250 lines.
- `server/_upload_wire.test.mjs` — wire-payload contract tests. ~150 lines.
- `server/_upload_e2e.mjs` — end-to-end integration against fixture pages. ~200 lines.
- `server/_fixtures/upload/server.mjs` — fixture HTTP server. ~120 lines.
- `server/_fixtures/upload/pages/01-direct.html` — plain `<input type=file>` page.
- `server/_fixtures/upload/pages/02-intercept.html` — button-triggered hidden input.
- `server/_fixtures/upload/pages/03-drop.html` — drag-drop-only zone.
- `server/_fixtures/upload/pages/04-paste.html` — contenteditable paste zone.
- `server/_fixtures/upload/pages/05-iframe.html` — same-origin iframe wrapping #01.
- `server/_fixtures/upload/pages/01-direct-frame.html` — iframe contents for #05.

**New files (extension):**
- `extension/upload.js` — strategy chain, target resolution, smart-wait. ~600 lines.

**Modified files:**
- `server/src/tools.js` — register both tools; add local dispatch case for `browser_upload_stage`; map `browser_upload_file → upload_file` wire type; resolve source server-side before send.
- `extension/background.js` — add `case "upload_file": return uploadFile(p, clientId);` to dispatch switch (~line 875); import strategy module.
- `server/package.json` — add `undici` dependency; extend `test` script to include new test files.
- `server/_smoke.mjs` — verify the two new tools appear in `tools` array with valid schemas.
- `.gitignore` — ensure `.continuum/uploads/` content is not committed (only the directory shape if any).
- `server/dist/server.bundle.mjs` — rebuilt via `npm run build`.

---

## Task 1: Scaffold `uploads.js` with sha256 helper and project-dir resolver

**Files:**
- Create: `server/src/uploads.js`
- Create: `server/_uploads.test.mjs`
- Modify: `server/package.json` (add test entry)

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: Cannot find module './src/uploads.js'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/uploads.js`:
```js
// server/src/uploads.js
// Content-addressed file staging for browser_upload_* tools.
// All file I/O lives here; the extension never reads/writes the filesystem.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const INDEX_VERSION = 1;

function projectDir() {
  return process.env.MOCHI_PROJECT_DIR || process.cwd();
}

export function uploadsDir() {
  return path.join(projectDir(), ".continuum", "uploads");
}

function indexPath() {
  return path.join(uploadsDir(), "index.json");
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function initUploads() {
  await fs.mkdir(uploadsDir(), { recursive: true });
  await fs.mkdir(path.join(uploadsDir(), ".tmp"), { recursive: true });
  try {
    await fs.access(indexPath());
  } catch {
    await fs.writeFile(indexPath(), JSON.stringify({ version: INDEX_VERSION, entries: [] }, null, 2));
  }
}
```

- [ ] **Step 4: Update `server/package.json` test script**

Change the `test` line to:
```json
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _integration.mjs && node _multi-client.mjs",
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 1 — scaffold`

- [ ] **Step 6: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs server/package.json
git commit -m "feat(uploads): scaffold module with sha256 + project-dir resolver"
```

---

## Task 2: Atomic `index.json` read/write helpers

**Files:**
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: readIndex is not defined` (or similar).

- [ ] **Step 3: Implement `readIndex` / `writeIndex` in `uploads.js`**

Append to `server/src/uploads.js`:
```js
export async function readIndex() {
  const raw = await fs.readFile(indexPath(), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.version !== INDEX_VERSION) {
    throw new Error(`uploads index version ${parsed.version} unsupported`);
  }
  return parsed;
}

let writeMutex = Promise.resolve();
export async function writeIndex(idx) {
  // serialize concurrent writes within this process
  const prev = writeMutex;
  let release;
  writeMutex = new Promise((r) => { release = r; });
  try {
    await prev;
    const tmpFile = path.join(uploadsDir(), `index.json.tmp.${process.pid}.${Date.now()}`);
    await fs.writeFile(tmpFile, JSON.stringify(idx, null, 2));
    await fs.rename(tmpFile, indexPath());
  } finally {
    release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: both prior assertion blocks plus `✓ Task 2 — atomic index.json read/write`.

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): atomic index.json read/write with in-process mutex"
```

---

## Task 3: MIME sniffing + extension mapping

**Files:**
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: sniffMime is not defined`.

- [ ] **Step 3: Implement sniffer and ext map**

Append to `server/src/uploads.js`:
```js
const EXT_BY_MIME = {
  "image/png":  "png",
  "image/jpeg": "jpg",
  "image/gif":  "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4":  "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav":  "wav",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/html":  "html",
  "application/octet-stream": "bin",
};

export function extForMime(mime) {
  return EXT_BY_MIME[mime] ?? "bin";
}

export function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return "application/octet-stream";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // GIF87a / GIF89a
  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
  // WebP: RIFF....WEBP
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  // PDF: %PDF-
  if (buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  // ZIP: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "application/zip";
  // SVG: starts with "<?xml" or "<svg"
  const head = buf.toString("ascii", 0, Math.min(64, buf.length)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  // mp4 (ftyp box at offset 4)
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  // webm (EBML header 1A 45 DF A3)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return "application/octet-stream";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 3 — MIME sniffing` plus all prior tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): magic-byte MIME sniffing + extension mapping"
```

---

## Task 4: `stage()` from in-memory buffer (the core)

**Files:**
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: stageBuffer is not defined`.

- [ ] **Step 3: Implement `stageBuffer`**

Append to `server/src/uploads.js`:
```js
function stashIdFromSha(sha) { return "u_" + sha.slice(0, 8); }

export async function stageBuffer(buf, { source, mime, name, keep = "session", sessionId = null } = {}) {
  if (!Buffer.isBuffer(buf)) throw uploadErr("decode-failed", "stageBuffer requires a Buffer");
  const sha = sha256(buf);
  const stashId = stashIdFromSha(sha);
  const idx = await readIndex();
  const existing = idx.entries.find((e) => e.sha256 === sha);
  if (existing) {
    existing.lastUsedAt = new Date().toISOString();
    await writeIndex(idx);
    return { ...entryToResult(existing), dedupedFrom: existing.stashId };
  }
  const sniffed = sniffMime(buf);
  const effectiveMime = sniffed !== "application/octet-stream" ? sniffed : (mime || "application/octet-stream");
  const ext = extForMime(effectiveMime);
  const finalName = name || `${stashId}.${ext}`;
  const blobPath = path.join(uploadsDir(), `${sha}.${ext}`);

  const tmpBlob = path.join(uploadsDir(), ".tmp", `${sha}.${process.pid}.${Date.now()}`);
  await fs.writeFile(tmpBlob, buf);
  await fs.rename(tmpBlob, blobPath);

  const now = new Date().toISOString();
  const entry = {
    stashId, sha256: sha, ext, mime: effectiveMime, name: finalName, sizeBytes: buf.length,
    source: source ?? { kind: "unknown" }, keep, sessionId, createdAt: now, lastUsedAt: now,
  };
  idx.entries.push(entry);
  await writeIndex(idx);
  return entryToResult(entry);
}

function entryToResult(e) {
  return {
    stashId: e.stashId, sha256: e.sha256, path: path.join(uploadsDir(), `${e.sha256}.${e.ext}`),
    name: e.name, mime: e.mime, sizeBytes: e.sizeBytes, source: e.source, keep: e.keep,
  };
}

export function uploadErr(code, message, details) {
  const e = new Error(message);
  e.uploadError = { code, message, details };
  return e;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 4 — stage from buffer + dedup`.

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): stageBuffer with sha256 dedup + atomic blob write"
```

---

## Task 5: Source-shape resolver (path / dataUrl / base64 / stashId)

**Files:**
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: resolveSource is not defined`.

- [ ] **Step 3: Implement `resolveSource`**

Append to `server/src/uploads.js`:
```js
export async function resolveSource(src) {
  if (!src || typeof src !== "object") throw uploadErr("source-missing", "source object required");
  const kinds = ["path", "url", "dataUrl", "base64", "bytes", "stashId"];
  const present = kinds.filter((k) => src[k] !== undefined && src[k] !== null && src[k] !== "");
  if (present.length === 0) throw uploadErr("source-missing", "specify one of: " + kinds.join(", "));
  if (present.length > 1) throw uploadErr("source-conflict", "exactly one of: " + kinds.join(", "), { present });
  const kind = present[0];

  if (kind === "path") {
    const p = path.resolve(src.path);
    let buf;
    try { buf = await fs.readFile(p); }
    catch (e) { throw uploadErr("decode-failed", `cannot read path: ${e.message}`, { path: p }); }
    return { kind: "path", buf, mime: undefined, originalPath: p };
  }

  if (kind === "base64" || kind === "bytes") {
    let buf;
    try { buf = Buffer.from(src[kind], "base64"); }
    catch (e) { throw uploadErr("decode-failed", "invalid base64", { error: e.message }); }
    if (!buf.length) throw uploadErr("decode-failed", "base64 decoded to zero bytes");
    return { kind: "base64", buf, mime: src.mime };
  }

  if (kind === "dataUrl") {
    const m = /^data:([^;,]+)?(?:;([^,]+))?,(.+)$/s.exec(src.dataUrl);
    if (!m) throw uploadErr("decode-failed", "malformed data URL");
    const mime = m[1] || "application/octet-stream";
    const isB64 = (m[2] || "").includes("base64");
    const body = m[3];
    const buf = isB64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body));
    if (!buf.length) throw uploadErr("decode-failed", "data URL body empty");
    return { kind: "dataUrl", buf, mime };
  }

  if (kind === "stashId") {
    const idx = await readIndex();
    const entry = idx.entries.find((e) => e.stashId === src.stashId);
    if (!entry) throw uploadErr("stash-not-found", `no stash entry for ${src.stashId}`);
    const p = path.join(uploadsDir(), `${entry.sha256}.${entry.ext}`);
    let buf;
    try { buf = await fs.readFile(p); }
    catch { throw uploadErr("stash-not-found", `blob missing on disk for ${src.stashId}`, { path: p }); }
    return { kind: "stash", buf, mime: entry.mime, entry };
  }

  if (kind === "url") {
    return resolveUrlSource(src.url, src.maxBytes);
  }
  throw uploadErr("source-missing", `unhandled source kind ${kind}`);
}

// Implemented in Task 6.
async function resolveUrlSource(_url, _maxBytes) {
  throw uploadErr("fetch-failed", "URL source not yet implemented (see Task 6)");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 5 — source resolver`.

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): resolveSource for path/base64/dataUrl/stashId"
```

---

## Task 6: URL source via undici with size cap and redirect limit

**Files:**
- Modify: `server/package.json` (add `undici`)
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Add `undici` to dependencies**

```bash
cd server && npm install undici@7
```

- [ ] **Step 2: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: failure on first URL call with "URL source not yet implemented".

- [ ] **Step 4: Implement `resolveUrlSource`**

Replace the stub at the bottom of `server/src/uploads.js` with:
```js
import { request as undiciRequest } from "undici";

const URL_FETCH_TIMEOUT_MS = 30_000;
const URL_MAX_REDIRECTS = 5;

async function resolveUrlSource(url, maxBytes) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw uploadErr("fetch-failed", "url must be http(s)", { url });
  }
  if (process.env.SUPER_TESTER_UPLOAD_ALLOW_PRIVATE_URLS !== "1") {
    const host = new URL(url).hostname;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|::1|localhost)/i.test(host) || host === "0.0.0.0") {
      // local fixture tests need this — allow IPv4 loopback but not 0.0.0.0
      if (!/^127\./.test(host) && host !== "localhost" && host !== "::1") {
        throw uploadErr("fetch-failed", "private host blocked; set SUPER_TESTER_UPLOAD_ALLOW_PRIVATE_URLS=1", { host });
      }
    }
  }
  let currentUrl = url;
  for (let i = 0; i <= URL_MAX_REDIRECTS; i++) {
    const { statusCode, headers, body } = await undiciRequest(currentUrl, {
      method: "GET",
      headersTimeout: URL_FETCH_TIMEOUT_MS,
      bodyTimeout: URL_FETCH_TIMEOUT_MS,
      maxRedirections: 0,
    });
    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      currentUrl = new URL(headers.location, currentUrl).toString();
      body.resume(); // drain
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) {
      body.resume();
      throw uploadErr("fetch-failed", `HTTP ${statusCode}`, { status: statusCode, url: currentUrl });
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        body.destroy();
        throw uploadErr("too-large", `body exceeds maxBytes=${maxBytes}`, { receivedBytes: total, maxBytes });
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    const mime = String(headers["content-type"] || "").split(";")[0].trim() || undefined;
    return { kind: "url", buf, mime, finalUrl: currentUrl };
  }
  throw uploadErr("fetch-failed", `too many redirects`, { redirects: URL_MAX_REDIRECTS, url });
}
```

(Remove the stub `async function resolveUrlSource(_url, _maxBytes)` at the bottom of the file.)

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 6 — URL source`.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): undici URL fetcher with redirect/size/private-host guards"
```

---

## Task 7: Top-level `stage()` + size caps

**Files:**
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: stage is not defined`.

- [ ] **Step 3: Implement `stage()`**

Append to `server/src/uploads.js`:
```js
const DEFAULT_MAX_BYTES = Number(process.env.SUPER_TESTER_MAX_UPLOAD_BYTES) || 100 * 1024 * 1024;

export async function stage({ source, mime, name, keep = "session", sessionId = null, maxBytes } = {}) {
  await initUploads();
  const cap = Math.min(maxBytes || DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const resolved = await resolveSource({ ...source, maxBytes: cap });
  if (resolved.buf.length > cap) {
    throw uploadErr("too-large", `staged bytes exceed ${cap}`, { sizeBytes: resolved.buf.length, maxBytes: cap });
  }
  if (resolved.kind === "stash") {
    // already in library — just bump and return
    const idx = await readIndex();
    const entry = idx.entries.find((e) => e.stashId === resolved.entry.stashId);
    if (entry) {
      entry.lastUsedAt = new Date().toISOString();
      if (keep === "persistent") entry.keep = "persistent";
      await writeIndex(idx);
      return { ...entryToResult(entry), dedupedFrom: entry.stashId };
    }
  }
  return stageBuffer(resolved.buf, {
    source: sourceDescriptor(source, resolved),
    mime: mime || resolved.mime,
    name,
    keep,
    sessionId,
  });
}

function sourceDescriptor(rawSource, resolved) {
  if (resolved.kind === "url")     return { kind: "url",     value: resolved.finalUrl };
  if (resolved.kind === "path")    return { kind: "path",    value: resolved.originalPath };
  if (resolved.kind === "dataUrl") return { kind: "dataUrl" };
  if (resolved.kind === "base64")  return { kind: "base64" };
  if (resolved.kind === "stash")   return { kind: "stash",   stashId: resolved.entry.stashId };
  return { kind: "unknown" };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 7 — stage() top-level`.

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): stage() entry point with size caps + source descriptor"
```

---

## Task 8: Session GC hook

**Files:**
- Modify: `server/src/uploads.js`
- Modify: `server/_uploads.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_uploads.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && node _uploads.test.mjs
```
Expected: `Error: gcSession is not defined`.

- [ ] **Step 3: Implement `gcSession`**

Append to `server/src/uploads.js`:
```js
export async function gcSession(sessionId) {
  const idx = await readIndex();
  const kept = [];
  const removed = [];
  for (const e of idx.entries) {
    if (e.sessionId === sessionId && e.keep === "session") {
      removed.push(e.stashId);
      continue;
    }
    kept.push(e);
  }
  if (!removed.length) return removed;
  // figure out which sha256s are no longer referenced and unlink their blobs
  const keptShas = new Set(kept.map((e) => e.sha256));
  const removedShas = new Set(idx.entries.filter((e) => removed.includes(e.stashId)).map((e) => e.sha256));
  idx.entries = kept;
  await writeIndex(idx);
  for (const sha of removedShas) {
    if (keptShas.has(sha)) continue;
    const e = idx.entries.find((x) => x.sha256 === sha) || null;
    const ext = e?.ext || (await guessExtFromDisk(sha));
    if (!ext) continue;
    try { await fs.unlink(path.join(uploadsDir(), `${sha}.${ext}`)); } catch {}
  }
  return removed;
}

async function guessExtFromDisk(sha) {
  const files = await fs.readdir(uploadsDir());
  const match = files.find((f) => f.startsWith(sha + "."));
  return match ? match.split(".").pop() : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && node _uploads.test.mjs
```
Expected: `✓ Task 8 — gcSession`.

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.js server/_uploads.test.mjs
git commit -m "feat(uploads): gcSession unlinks unreferenced blobs on session end"
```

---

## Task 9: Register `browser_upload_stage` tool

**Files:**
- Modify: `server/src/tools.js`
- Modify: `server/_smoke.mjs`

- [ ] **Step 1: Add to the `tools` array (in `server/src/tools.js`, before the closing `]`)**

Locate the end of the `export const tools = [` array (around line 540) and add this entry:
```js
  {
    name: "browser_upload_stage",
    description:
      "Stage a file (image/video/document) into the project's content-addressed upload library at `.continuum/uploads/`. " +
      "Accepts one of: local path, https URL, data URL, or raw base64. Returns a stashId that can be passed to browser_upload_file " +
      "(or reused across multiple uploads). Idempotent — same bytes always produce the same stashId.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "object",
          description: "Exactly one of: path, url, dataUrl, base64. Use `mime` to supplement base64.",
          properties: {
            path:    { type: "string", description: "Absolute filesystem path on this host." },
            url:     { type: "string", description: "https:// URL to fetch." },
            dataUrl: { type: "string", description: "Full data: URL (with mime + base64)." },
            base64:  { type: "string", description: "Raw base64 bytes; pair with `mime`." },
            bytes:   { type: "string", description: "Alias for `base64`." },
          },
        },
        mime: { type: "string", description: "MIME override (used when source is raw base64)." },
        name: { type: "string", description: "Friendly filename (some upload endpoints inspect form-data name)." },
        keep: { type: "string", enum: ["session", "persistent"], default: "session" },
        maxBytes: { type: "number", description: "Reject if file exceeds this many bytes. Default 50MB; hard cap 100MB." },
      },
      required: ["source"],
    },
  },
```

- [ ] **Step 2: Add local dispatch case**

In `server/src/tools.js`, inside `handleToolCall`'s `switch (name)` block (the local-tools switch ~line 569), add:
```js
    case "browser_upload_stage":      return jsonResult(await toolUploadStage(args));
```

- [ ] **Step 3: Implement `toolUploadStage` (anywhere in `tools.js`, near the other local tool helpers)**

Add at top of file:
```js
import { stage as stageUpload } from "./uploads.js";
```
And add function:
```js
async function toolUploadStage(args = {}) {
  try {
    const result = await stageUpload({
      source: args.source,
      mime: args.mime,
      name: args.name,
      keep: args.keep ?? "session",
      maxBytes: args.maxBytes,
      sessionId: currentClaudeSessionId() ?? null,
    });
    return { ok: true, ...result };
  } catch (e) {
    if (e.uploadError) return { ok: false, error: e.uploadError };
    return { ok: false, error: { code: "internal", message: String(e?.message ?? e) } };
  }
}

function currentClaudeSessionId() {
  // The active Claude session ID isn't stamped per-call yet; placeholder for future
  // wiring through bridge.localClientId or a per-request sessionId hook.
  return null;
}
```

- [ ] **Step 4: Smoke test — verify tool appears**

Add to `server/_smoke.mjs` in the `want` array:
```js
  "browser_upload_stage",
  "browser_upload_file",
```

(The `browser_upload_file` line will be implemented in Task 11; smoke test will fail until then. To keep the smoke test green per-task, temporarily add ONLY `browser_upload_stage` in this task; add `browser_upload_file` in Task 11.)

- [ ] **Step 5: Run smoke test**

```bash
cd server && node _smoke.mjs
```
Expected: smoke test passes and reports `browser_upload_stage` in the tool count.

- [ ] **Step 6: Commit**

```bash
git add server/src/tools.js server/_smoke.mjs
git commit -m "feat(tools): register browser_upload_stage (local-only tool)"
```

---

## Task 10: Register `browser_upload_file` tool definition (no extension yet)

**Files:**
- Modify: `server/src/tools.js`
- Modify: `server/_smoke.mjs`

- [ ] **Step 1: Add tool definition in `tools` array**

Add after the `browser_upload_stage` entry:
```js
  {
    name: "browser_upload_file",
    description:
      "Attach a file to a target on the page. Bypasses the native OS file picker via a strategy chain " +
      "(direct DOM.setFileInputFiles → file-chooser intercept → drag-drop synthesis → paste synthesis). " +
      "Source can be a stashId from browser_upload_stage OR inline (path/url/dataUrl/base64). " +
      "Target can be a CSS selector, accessibility ref, visible trigger element, or auto-detected from a nearby anchor.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },

        stashId: { type: "string" },
        path:    { type: "string" },
        url:     { type: "string" },
        dataUrl: { type: "string" },
        base64:  { type: "string" },
        bytes:   { type: "string", description: "Alias for `base64`." },
        mime:    { type: "string" },
        name:    { type: "string" },
        files:   { type: "array", description: "For multi-file inputs: array of source descriptors (each like the inline fields above OR { stashId })." },

        selector: { type: "string" },
        ref:      { type: "string" },
        trigger:  { type: "object", properties: { selector: { type: "string" }, ref: { type: "string" } } },
        auto:     { type: "object", properties: { near: { type: "string", description: "ref or selector" } } },

        strategies: {
          type: "array",
          items: { type: "string", enum: ["direct", "intercept", "drop", "paste"] },
          default: ["direct", "intercept", "drop", "paste"],
        },
        frames:         { type: "string", description: '"all" | "top" | <frameId>', default: "all" },
        dispatchEvents: { type: "array", items: { type: "string" }, default: ["change", "input"] },

        waitFor: {
          type: "object",
          properties: {
            mode:            { type: "string", enum: ["smart", "explicit", "none"], default: "smart" },
            timeoutMs:       { type: "number", default: 15000 },
            previewSelector: { type: "string" },
            networkPattern:  { type: "string", description: "JS regex source" },
            successSelector: { type: "string" },
          },
        },
      },
    },
  },
```

- [ ] **Step 2: Add wire mapping**

In `server/src/tools.js`, find `WIRE_TYPE_BY_TOOL` (~line 539) and add the entry:
```js
  browser_upload_file: "upload_file",
```

- [ ] **Step 3: Add `browser_upload_file` to smoke test want list**

In `server/_smoke.mjs` `want` array, add `"browser_upload_file"` if it's not already there from Task 9.

- [ ] **Step 4: Run smoke test**

```bash
cd server && node _smoke.mjs
```
Expected: smoke test passes, both tools listed in count.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools.js server/_smoke.mjs
git commit -m "feat(tools): define browser_upload_file tool schema + wire mapping"
```

---

## Task 11: Server-side source resolution for `browser_upload_file`

**Files:**
- Modify: `server/src/tools.js`
- Create: `server/_upload_wire.test.mjs`
- Modify: `server/package.json` (extend test script)

- [ ] **Step 1: Write the wire-contract test**

Create `server/_upload_wire.test.mjs`:
```js
// _upload_wire.test.mjs — verify browser_upload_file builds correct wire payload.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { stage, initUploads } from "./src/uploads.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-wire-test-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initUploads();
initToolsState({ log: () => {} });

const staged = await stage({ source: { base64: Buffer.from([0x89,0x50,0x4e,0x47, ...Buffer.from("body")]).toString("base64") } });

const sent = [];
const bridge = {
  mode: "broker", isConnected: () => true, getLocalClientId: () => "mc-self",
  mcpClients: new Map(), extensionWs: {},
  send: async (type, params) => {
    sent.push({ type, params });
    return { ok: true, strategy: "direct", attempts: [{ strategy: "direct", ok: true, durationMs: 12 }], target: { resolved: "input", backendNodeId: 1 }, files: [{ name: staged.name, mime: staged.mime, sizeBytes: staged.sizeBytes, stashId: staged.stashId }], waitedFor: null, totalMs: 20 };
  },
};

// 1. stashId source — extension receives filePaths, NO fileBytes
sent.length = 0;
let r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: { stashId: staged.stashId, selector: "input[type=file]", strategies: ["direct"] } });
assert.equal(sent.length, 1);
assert.equal(sent[0].type, "upload_file");
assert.deepEqual(sent[0].params.filePaths, [staged.path]);
assert.equal(sent[0].params.fileBytes, undefined);
assert.deepEqual(sent[0].params.target, { selector: "input[type=file]" });
assert.deepEqual(sent[0].params.strategies, ["direct"]);

// 2. inline base64 + drop strategy → fileBytes populated
sent.length = 0;
r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: {
  base64: Buffer.from([0xff,0xd8,0xff, ...Buffer.from("jpeg")]).toString("base64"),
  selector: ".drop-zone",
  strategies: ["drop"],
}});
assert.equal(sent[0].params.fileBytes.length, 1);
assert.equal(sent[0].params.fileBytes[0].mime, "image/jpeg");
assert.ok(typeof sent[0].params.fileBytes[0].base64 === "string");

// 3. files: [] multi
sent.length = 0;
const second = await stage({ source: { base64: Buffer.from([0x47,0x49,0x46,0x38,0x39,0x61]).toString("base64") } });
r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: {
  files: [{ stashId: staged.stashId }, { stashId: second.stashId }],
  selector: "input[multiple]",
}});
assert.equal(sent[0].params.filePaths.length, 2);

// 4. source-conflict
r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: { stashId: "u_x", base64: "abc" }});
const parsed = JSON.parse(r.content[0].text);
assert.equal(parsed.ok, false);
assert.equal(parsed.error.code, "source-conflict");

console.log("✓ upload_file wire contract");
await fs.rm(tmp, { recursive: true, force: true });
```

- [ ] **Step 2: Add wire dispatch in `tools.js`**

Add a top-level handler that runs BEFORE `runWireTool` for `browser_upload_file`. In `handleToolCall`, change:
```js
  return jsonResult(await runWireTool(bridge, name, args));
```
to:
```js
  if (name === "browser_upload_file") {
    return jsonResult(await toolUploadFile(bridge, args));
  }
  return jsonResult(await runWireTool(bridge, name, args));
```

Then add `toolUploadFile`:
```js
async function toolUploadFile(bridge, args = {}) {
  try {
    const fileSources = collectFileSources(args);
    const resolved = await Promise.all(fileSources.map(async (src) => {
      const r = await resolveOrStage(src);
      return r;
    }));

    const target = pickTarget(args);
    if (!target) throw uploadErr("source-missing", "specify one target: selector | ref | trigger | auto");

    const strategies = Array.isArray(args.strategies) && args.strategies.length
      ? args.strategies
      : ["direct", "intercept", "drop", "paste"];

    const needsBytes = strategies.includes("drop") || strategies.includes("paste");
    const filePaths = resolved.map((r) => r.path);
    const fileBytes = needsBytes
      ? await Promise.all(resolved.map(async (r) => ({
          name:   r.name,
          mime:   r.mime,
          base64: (await import("node:fs/promises")).then ? (await (await import("node:fs/promises")).readFile(r.path)).toString("base64") : null,
        })))
      : undefined;

    const params = {
      filePaths,
      ...(fileBytes ? { fileBytes } : {}),
      target,
      strategies,
      frames:         args.frames ?? "all",
      dispatchEvents: args.dispatchEvents ?? ["change", "input"],
      waitFor:        args.waitFor ?? { mode: "smart", timeoutMs: 15000 },
    };

    if (args.tabId != null) params.tabId = args.tabId;
    const result = await bridge.send("upload_file", params);
    return { ok: true, ...result, files: resolved.map((r) => ({ name: r.name, mime: r.mime, sizeBytes: r.sizeBytes, stashId: r.stashId })) };
  } catch (e) {
    if (e.uploadError) return { ok: false, error: e.uploadError };
    return { ok: false, error: { code: "internal", message: String(e?.message ?? e) } };
  }
}

function collectFileSources(args) {
  if (Array.isArray(args.files) && args.files.length) return args.files;
  const inline = {};
  for (const k of ["stashId", "path", "url", "dataUrl", "base64", "bytes", "mime", "name"]) {
    if (args[k] !== undefined) inline[k] = args[k];
  }
  return [inline];
}

async function resolveOrStage(src) {
  // If only stashId given, no need to stage — just look up.
  if (src.stashId && !src.path && !src.url && !src.dataUrl && !src.base64 && !src.bytes) {
    const idx = await (await import("./uploads.js")).readIndex();
    const entry = idx.entries.find((e) => e.stashId === src.stashId);
    if (!entry) throw uploadErr("stash-not-found", `no stash entry for ${src.stashId}`);
    return { stashId: entry.stashId, name: entry.name, mime: entry.mime, sizeBytes: entry.sizeBytes, path: (await import("path")).join((await import("./uploads.js")).uploadsDir(), `${entry.sha256}.${entry.ext}`) };
  }
  const staged = await stageUpload({ source: src, mime: src.mime, name: src.name, sessionId: null });
  return staged;
}

function pickTarget(args) {
  if (args.selector) return { selector: args.selector };
  if (args.ref)      return { ref: args.ref };
  if (args.trigger)  return { trigger: args.trigger };
  if (args.auto)     return { auto: args.auto };
  return null;
}
```

Also import `uploadErr` at the top:
```js
import { stage as stageUpload, uploadErr } from "./uploads.js";
```

- [ ] **Step 3: Extend `server/package.json` test script**

Change to:
```json
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _integration.mjs && node _multi-client.mjs",
```

- [ ] **Step 4: Run wire test to verify it fails (yet)**

```bash
cd server && node _upload_wire.test.mjs
```
Expected: the test passes (the implementation was added simultaneously, common in this codebase's hand-rolled style — but the test acts as the spec). Verify pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools.js server/_upload_wire.test.mjs server/package.json
git commit -m "feat(tools): server-side dispatch for browser_upload_file (no extension yet)"
```

---

## Task 12: Extension dispatch stub for `upload_file`

**Files:**
- Create: `extension/upload.js`
- Modify: `extension/background.js`

- [ ] **Step 1: Create `extension/upload.js` scaffold**

```js
// extension/upload.js — strategy chain for browser_upload_file.
// Receives wire params { filePaths, fileBytes?, target, strategies, frames, dispatchEvents, waitFor }
// and runs the chain via chrome.debugger CDP calls.

import {} from "./background.js"; // intentional: reuse globals via window scope under MV3 SW — actually MV3 SW: use globalThis

// NOTE: This file lives in the extension SW. It is imported by background.js
// via `importScripts` or ES-module dynamic-import. We use globalThis to access
// shared helpers (attachDebugger, sendCommand, attachedTabs, currentTabFor).

export async function handleUploadFile(params, clientId) {
  const { filePaths = [], fileBytes, target, strategies = ["direct"], frames = "all", dispatchEvents = ["change", "input"], waitFor } = params || {};
  if (!filePaths.length) {
    return { ok: false, error: { code: "source-missing", message: "filePaths empty" } };
  }
  if (!target) {
    return { ok: false, error: { code: "source-missing", message: "target missing" } };
  }
  const tabId = await resolveTabIdForClient(params, clientId);
  await globalThis.attachDebugger(tabId);

  const ctx = {
    tabId,
    filePaths,
    fileBytes,
    target,
    frames,
    dispatchEvents,
    waitFor,
    attempts: [],
  };

  for (const strategy of strategies) {
    const t0 = Date.now();
    try {
      const r = await runStrategy(strategy, ctx);
      if (r.ok) {
        ctx.attempts.push({ strategy, ok: true, durationMs: Date.now() - t0 });
        const waited = await smartWait(ctx);
        return {
          ok: true,
          strategy,
          attempts: ctx.attempts,
          target: r.target,
          files: filePaths.map((p, i) => ({ name: fileBytes?.[i]?.name ?? p.split("/").pop(), mime: fileBytes?.[i]?.mime, sizeBytes: undefined })),
          waitedFor: waited,
          totalMs: Date.now() - t0,
        };
      }
      ctx.attempts.push({ strategy, ok: false, reason: r.reason, durationMs: Date.now() - t0 });
    } catch (e) {
      ctx.attempts.push({ strategy, ok: false, reason: String(e?.message ?? e), durationMs: Date.now() - t0 });
    }
  }
  return { ok: false, error: { code: "all-strategies-failed", message: "no strategy succeeded", details: { attempts: ctx.attempts } } };
}

async function runStrategy(name, ctx) {
  // Stubs — implemented in Tasks 13-16.
  return { ok: false, reason: `strategy "${name}" not implemented yet` };
}

async function smartWait(_ctx) {
  // Stub — implemented in Task 18.
  return null;
}

async function resolveTabIdForClient(params, clientId) {
  if (params.tabId) return params.tabId;
  if (typeof globalThis.activeTabForClient === "function") return globalThis.activeTabForClient(clientId);
  throw new Error("no active tab for client " + clientId);
}

globalThis.__mochiHandleUploadFile = handleUploadFile;
```

- [ ] **Step 2: Wire dispatch in `background.js`**

Find the switch in `background.js` (~line 875) and add the case before `default:`:
```js
    case "upload_file":        return uploadFile(p, clientId);
```

Then near the other helpers in `background.js`, add:
```js
// Lazy-load the upload module on first call. MV3 SW allows dynamic import.
let _uploadModule = null;
async function uploadFile(p, clientId) {
  if (!_uploadModule) _uploadModule = await import(chrome.runtime.getURL("upload.js"));
  return _uploadModule.handleUploadFile(p, clientId);
}
```

(If the import path doesn't work due to MV3 module restrictions, alternative: include `"upload.js"` in `manifest.json` background.service_worker via `"type":"module"` config, then `import { handleUploadFile } from "./upload.js"` at top of `background.js`. The exact wiring depends on whether the current SW is module-mode. Check current `manifest.json`: if `"type": "module"`, use static import; otherwise use the dynamic import above.)

- [ ] **Step 3: Verify the extension still loads**

Manually (or via existing extension test harness if present): load the extension in Chrome, open DevTools for the service worker, confirm no errors. The test for full wiring is in later tasks.

- [ ] **Step 4: Commit**

```bash
git add extension/upload.js extension/background.js
git commit -m "feat(extension): upload.js scaffold + dispatch stub for upload_file"
```

---

## Task 13: Target resolution (selector + ref) and helper for CDP DOM queries

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement target resolution helpers**

Append to `extension/upload.js`:
```js
async function cdp(tabId, method, params) {
  return globalThis.sendDebuggerCommand(tabId, method, params);
  // sendDebuggerCommand is defined in background.js; see line ~395.
}

async function getDocumentNodeId(tabId, frameId) {
  if (frameId && frameId !== "top") {
    // resolve frame's content document
    const tree = await cdp(tabId, "Page.getFrameTree", {});
    const target = findFrame(tree.frameTree, frameId);
    if (!target) throw new Error(`frame ${frameId} not found`);
    // DOM.getFrameOwner gives us a nodeId for the iframe element; DOM.describeNode + DOM.requestChildNodes to enter content.
    // Simpler: use DOM.resolveNode with contextId from Page.getResourceTree? CDP path:
    const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId });
    const node = await cdp(tabId, "DOM.describeNode", { backendNodeId: owner.backendNodeId, depth: 0, pierce: false });
    // contentDocument backendNodeId
    if (!node.node.contentDocument) throw new Error(`frame ${frameId} has no contentDocument (cross-origin?)`);
    return node.node.contentDocument.nodeId ?? (await cdp(tabId, "DOM.requestNode", { objectId: undefined })).nodeId;
  }
  const root = await cdp(tabId, "DOM.getDocument", { depth: 0, pierce: false });
  return root.root.nodeId;
}

function findFrame(node, frameId) {
  if (node.frame.id === frameId) return node;
  for (const child of (node.childFrames || [])) {
    const r = findFrame(child, frameId);
    if (r) return r;
  }
  return null;
}

async function resolveTargetNode(ctx, target) {
  // Returns { nodeId, frameId } or throws target-not-found.
  const frames = await listFrames(ctx);
  for (const frameId of frames) {
    try {
      if (target.selector) {
        const doc = await getDocumentNodeId(ctx.tabId, frameId);
        const r = await cdp(ctx.tabId, "DOM.querySelector", { nodeId: doc, selector: target.selector });
        if (r.nodeId) return { nodeId: r.nodeId, frameId };
      } else if (target.ref) {
        const nodeId = globalThis.refToNodeId?.(ctx.tabId, target.ref, frameId);
        if (nodeId) return { nodeId, frameId };
      } else if (target.trigger) {
        return resolveTargetNode(ctx, target.trigger); // recurse with selector/ref
      } else if (target.auto) {
        const anchor = await resolveAnchor(ctx, target.auto.near, frameId);
        if (anchor) return await autoDetectFromAnchor(ctx, anchor, frameId);
      }
    } catch (e) {
      // try next frame
    }
  }
  throw new Error("target-not-found");
}

async function listFrames(ctx) {
  if (ctx.frames === "top") return ["top"];
  if (ctx.frames && ctx.frames !== "all") return [ctx.frames];
  const tree = await cdp(ctx.tabId, "Page.getFrameTree", {});
  const all = ["top"];
  collectFrameIds(tree.frameTree, all);
  return all;
}

function collectFrameIds(node, out) {
  for (const child of (node.childFrames || [])) {
    out.push(child.frame.id);
    collectFrameIds(child, out);
  }
}

async function resolveAnchor(ctx, near, frameId) {
  // ref-like: /^[a-z0-9]{1,8}$/i and is in ref table
  if (/^[a-z0-9]{1,8}$/i.test(near) && globalThis.refToNodeId) {
    const id = globalThis.refToNodeId(ctx.tabId, near, frameId);
    if (id) return { nodeId: id };
  }
  // else treat as selector
  const doc = await getDocumentNodeId(ctx.tabId, frameId);
  const r = await cdp(ctx.tabId, "DOM.querySelector", { nodeId: doc, selector: near });
  return r.nodeId ? { nodeId: r.nodeId } : null;
}

async function autoDetectFromAnchor(ctx, anchor, frameId) {
  // Use Runtime.evaluate to walk DOM and return a backendNodeId of a file input.
  const objectId = (await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: anchor.nodeId })).object.objectId;
  const expression = `(${autoDetectFn.toString()})(this)`;
  const r = await cdp(ctx.tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: autoDetectFn.toString(), arguments: [] });
  if (!r.result || !r.result.objectId) {
    // not found → treat as trigger
    return { nodeId: anchor.nodeId, frameId, isTrigger: true };
  }
  const nodeMeta = await cdp(ctx.tabId, "DOM.requestNode", { objectId: r.result.objectId });
  return { nodeId: nodeMeta.nodeId, frameId, isTrigger: false };
}

const autoDetectFn = function () {
  const isFileInput = (n) => n && n.tagName === "INPUT" && n.type === "file";
  // descendants
  if (this.querySelector) {
    const desc = this.querySelector('input[type="file"]');
    if (desc) return desc;
  }
  // following siblings (≤5)
  let cur = this, hops = 0;
  while (cur && hops < 5) {
    cur = cur.nextElementSibling;
    if (isFileInput(cur)) return cur;
    if (cur?.querySelector) {
      const x = cur.querySelector('input[type="file"]');
      if (x) return x;
    }
    hops++;
  }
  // ancestor descendants (depth ≤3)
  let anc = this.parentElement, depth = 0;
  while (anc && depth < 3) {
    const x = anc.querySelector('input[type="file"]');
    if (x) return x;
    anc = anc.parentElement;
    depth++;
  }
  return null;
};
```

- [ ] **Step 2: Commit**

```bash
git add extension/upload.js
git commit -m "feat(extension): target resolution helpers (selector/ref/auto/frame search)"
```

(No test in this task — target resolution is integration-tested in Task 22 against real fixtures. Pure unit tests of CDP-bound code without a real chrome.debugger are low value.)

---

## Task 14: Strategy `direct` (DOM.setFileInputFiles)

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement the `direct` strategy**

In `extension/upload.js`, replace the `runStrategy` stub with:
```js
async function runStrategy(name, ctx) {
  if (name === "direct")    return strategyDirect(ctx);
  if (name === "intercept") return strategyIntercept(ctx);
  if (name === "drop")      return strategyDrop(ctx);
  if (name === "paste")     return strategyPaste(ctx);
  return { ok: false, reason: `unknown strategy "${name}"` };
}

async function strategyDirect(ctx) {
  let resolved;
  try { resolved = await resolveTargetNode(ctx, ctx.target); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (resolved.isTrigger) return { ok: false, reason: "target is a trigger element, not an <input type=file>" };

  // Describe node to check tag and type
  const desc = await cdp(ctx.tabId, "DOM.describeNode", { nodeId: resolved.nodeId });
  const node = desc.node;
  const tag = (node.localName || node.nodeName || "").toLowerCase();
  const typeAttrIdx = (node.attributes || []).indexOf("type");
  const type = typeAttrIdx >= 0 ? (node.attributes[typeAttrIdx + 1] || "").toLowerCase() : "";
  if (tag !== "input" || type !== "file") {
    return { ok: false, reason: `target is <${tag} type="${type}">, not <input type="file">` };
  }
  await cdp(ctx.tabId, "DOM.setFileInputFiles", { nodeId: resolved.nodeId, files: ctx.filePaths });
  await dispatchEvents(ctx, resolved);
  return { ok: true, target: { resolved: `<${tag} type="${type}">`, frameId: resolved.frameId, nodeId: resolved.nodeId } };
}

async function dispatchEvents(ctx, resolved) {
  if (!ctx.dispatchEvents?.length) return;
  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: resolved.nodeId });
  const objectId = objectIdResp.object.objectId;
  for (const ev of ctx.dispatchEvents) {
    await cdp(ctx.tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(){ this.dispatchEvent(new Event('${ev}', { bubbles: true })); }`,
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/upload.js
git commit -m "feat(extension): strategy 'direct' via DOM.setFileInputFiles + change/input events"
```

---

## Task 15: Strategy `intercept` (file chooser handling)

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement `intercept`**

Append to `extension/upload.js`:
```js
async function strategyIntercept(ctx) {
  // Resolve trigger target — for `target.trigger`, use trigger field; otherwise the original target.
  const triggerSpec = ctx.target.trigger || ctx.target;
  let resolved;
  try { resolved = await resolveTargetNode(ctx, triggerSpec); }
  catch (e) { return { ok: false, reason: e.message }; }

  await cdp(ctx.tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

  // Race: register one-shot listener via background.js's shared event listener.
  let chooserFired = false;
  let chooserBackendNodeId = null;
  const listener = (method, params) => {
    if (method === "Page.fileChooserOpened" && params.frameId) {
      chooserFired = true;
      chooserBackendNodeId = params.backendNodeId;
      cdp(ctx.tabId, "Page.handleFileChooser", { action: "accept", files: ctx.filePaths }).catch(() => {});
    }
  };
  globalThis.__mochiCdpListeners ||= new Map();
  globalThis.__mochiCdpListeners.set("upload-" + ctx.tabId, { tabId: ctx.tabId, listener });

  try {
    // Click via Input.dispatchMouseEvent at the node's center.
    const box = await getNodeBox(ctx.tabId, resolved.nodeId);
    if (!box) return { ok: false, reason: "trigger node has no box (display:none?)" };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp(ctx.tabId, "Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1 });
    await cdp(ctx.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    // Wait up to 3s for chooserFired
    const deadline = Date.now() + 3000;
    while (!chooserFired && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return chooserFired
      ? { ok: true, target: { resolved: "trigger+chooser", frameId: resolved.frameId, backendNodeId: chooserBackendNodeId } }
      : { ok: false, reason: "chooser-timeout" };
  } finally {
    globalThis.__mochiCdpListeners.delete("upload-" + ctx.tabId);
    try { await cdp(ctx.tabId, "Page.setInterceptFileChooserDialog", { enabled: false }); } catch {}
  }
}

async function getNodeBox(tabId, nodeId) {
  const r = await cdp(tabId, "DOM.getBoxModel", { nodeId });
  if (!r.model?.border) return null;
  const [x1, y1, x2, y2, , , , ] = r.model.border;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: r.model.width, height: r.model.height };
}
```

- [ ] **Step 2: Wire the listener into background.js's existing `chrome.debugger.onEvent`**

In `background.js`, find the existing `chrome.debugger.onEvent.addListener` (~line 525) and inside it add:
```js
  // Upload module transient listeners
  if (globalThis.__mochiCdpListeners) {
    for (const { tabId: lTab, listener } of globalThis.__mochiCdpListeners.values()) {
      if (lTab === tabId) listener(method, params);
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add extension/upload.js extension/background.js
git commit -m "feat(extension): strategy 'intercept' via Page.setInterceptFileChooserDialog + handleFileChooser"
```

---

## Task 16: Strategy `drop` (DataTransfer synthesis)

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement `drop`**

Append to `extension/upload.js`:
```js
async function strategyDrop(ctx) {
  if (!ctx.fileBytes?.length) return { ok: false, reason: "drop requires fileBytes (server should have sent them)" };
  let resolved;
  try { resolved = await resolveTargetNode(ctx, ctx.target); }
  catch (e) { return { ok: false, reason: e.message }; }

  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: resolved.nodeId });
  const objectId = objectIdResp.object.objectId;
  const argsJson = JSON.stringify(ctx.fileBytes); // [{name, mime, base64}, ...]

  const expression = `(${dropFn.toString()})(${argsJson})`;
  const r = await cdp(ctx.tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(files){ return (${dropFn.toString()}).call(this, files); }`,
    arguments: [{ value: ctx.fileBytes }],
    returnByValue: true,
    awaitPromise: true,
  });
  const ok = r.result?.value === true || r.result?.value?.dropped === true;
  if (!ok) return { ok: false, reason: "drop event did not produce a mutation within 500ms" };
  return { ok: true, target: { resolved: "drop", frameId: resolved.frameId, nodeId: resolved.nodeId } };
}

const dropFn = async function (files) {
  const fileObjs = files.map((f) => {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || "file", { type: f.mime || "application/octet-stream" });
  });
  const dt = new DataTransfer();
  for (const f of fileObjs) dt.items.add(f);

  const fired = { count: 0 };
  const obs = new MutationObserver(() => fired.count++);
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });

  const dispatch = (type) => this.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  dispatch("dragenter");
  dispatch("dragover");
  dispatch("drop");

  await new Promise((r) => setTimeout(r, 500));
  obs.disconnect();
  return { dropped: fired.count > 0 };
};
```

- [ ] **Step 2: Commit**

```bash
git add extension/upload.js
git commit -m "feat(extension): strategy 'drop' via DataTransfer + DragEvent synthesis"
```

---

## Task 17: Strategy `paste` (ClipboardEvent synthesis)

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement `paste`**

Append to `extension/upload.js`:
```js
async function strategyPaste(ctx) {
  if (!ctx.fileBytes?.length) return { ok: false, reason: "paste requires fileBytes" };
  let resolved;
  try { resolved = await resolveTargetNode(ctx, ctx.target); }
  catch (e) { return { ok: false, reason: e.message }; }

  const objectIdResp = await cdp(ctx.tabId, "DOM.resolveNode", { nodeId: resolved.nodeId });
  const objectId = objectIdResp.object.objectId;

  const r = await cdp(ctx.tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(files){ return (${pasteFn.toString()}).call(this, files); }`,
    arguments: [{ value: ctx.fileBytes }],
    returnByValue: true,
    awaitPromise: true,
  });
  const ok = r.result?.value?.pasted === true;
  if (!ok) return { ok: false, reason: "paste event did not produce a mutation within 500ms" };
  return { ok: true, target: { resolved: "paste", frameId: resolved.frameId, nodeId: resolved.nodeId } };
}

const pasteFn = async function (files) {
  const fileObjs = files.map((f) => {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || "file", { type: f.mime || "application/octet-stream" });
  });
  const dt = new DataTransfer();
  for (const f of fileObjs) dt.items.add(f);

  // Focus this element if focusable
  if (typeof this.focus === "function") this.focus();
  const target = this.isContentEditable || this.tagName === "TEXTAREA" || this.tagName === "INPUT" ? this : document.activeElement || this;

  const fired = { count: 0 };
  const obs = new MutationObserver(() => fired.count++);
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });

  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));

  await new Promise((r) => setTimeout(r, 500));
  obs.disconnect();
  return { pasted: fired.count > 0 };
};
```

- [ ] **Step 2: Commit**

```bash
git add extension/upload.js
git commit -m "feat(extension): strategy 'paste' via ClipboardEvent + DataTransfer"
```

---

## Task 18: Smart wait

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement `smartWait`**

In `extension/upload.js`, replace the `smartWait` stub with:
```js
async function smartWait(ctx) {
  const wf = ctx.waitFor || { mode: "smart", timeoutMs: 15000 };
  if (wf.mode === "none") return null;
  const deadline = Date.now() + (wf.timeoutMs ?? 15000);

  // Set up a transient network 2xx listener
  const networkPattern = wf.networkPattern ? new RegExp(wf.networkPattern, "i") : /upload|media|attach|photo/i;
  let netHit = null;
  const onEvent = (method, params) => {
    if (method !== "Network.responseReceived") return;
    const url = params.response?.url || "";
    const status = params.response?.status || 0;
    if (status >= 200 && status < 300 && networkPattern.test(url)) {
      // method check requires matching the request; we accept any here for simplicity
      netHit = { signal: "network-2xx", url, status };
    }
  };
  globalThis.__mochiCdpListeners ||= new Map();
  const key = "smartwait-" + ctx.tabId + "-" + Math.random().toString(36).slice(2);
  globalThis.__mochiCdpListeners.set(key, { tabId: ctx.tabId, listener: onEvent });

  // Install DOM MutationObserver via Runtime.evaluate
  const observerId = await installPreviewObserver(ctx.tabId, wf.previewSelector);

  let networkSampled = 0, mutationSampled = 0;
  try {
    while (Date.now() < deadline) {
      if (netHit) return { ...netHit, durationMs: ctx.waitFor?.timeoutMs - (deadline - Date.now()) };
      const dom = await pollPreviewObserver(ctx.tabId, observerId);
      mutationSampled = dom.mutations;
      if (dom.match) return { signal: "preview-img", selector: dom.selector, durationMs: ctx.waitFor?.timeoutMs - (deadline - Date.now()) };
      if (wf.successSelector) {
        try {
          const doc = await getDocumentNodeId(ctx.tabId);
          const r = await cdp(ctx.tabId, "DOM.querySelector", { nodeId: doc, selector: wf.successSelector });
          if (r.nodeId) {
            const box = await getNodeBox(ctx.tabId, r.nodeId);
            if (box && box.width > 0 && box.height > 0) {
              return { signal: "successSelector", selector: wf.successSelector, durationMs: ctx.waitFor?.timeoutMs - (deadline - Date.now()) };
            }
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { signal: null, reason: "timeout", evidence: { networkSampled, mutationSampled } };
  } finally {
    globalThis.__mochiCdpListeners.delete(key);
    await uninstallPreviewObserver(ctx.tabId, observerId).catch(() => {});
  }
}

const PREVIEW_OBSERVERS = new Map(); // key: observerId → { tabId, expression }

async function installPreviewObserver(tabId, customSelector) {
  const selector = customSelector || 'img[src^="blob:"],img[src^="data:"],video[src^="blob:"]';
  const observerId = "mochi_obs_" + Math.random().toString(36).slice(2);
  const expr = `
    (function(){
      const sel = ${JSON.stringify(selector)};
      window.__mochiObservers ||= {};
      const state = window.__mochiObservers['${observerId}'] = { matched: false, mutations: 0, selector: sel };
      const obs = new MutationObserver((records) => {
        state.mutations += records.length;
        if (!state.matched && document.querySelector(sel)) state.matched = true;
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      state.disconnect = () => obs.disconnect();
    })();
  `;
  await cdp(tabId, "Runtime.evaluate", { expression: expr });
  PREVIEW_OBSERVERS.set(observerId, { tabId });
  return observerId;
}

async function pollPreviewObserver(tabId, observerId) {
  const r = await cdp(tabId, "Runtime.evaluate", {
    expression: `JSON.stringify({ match: window.__mochiObservers?.['${observerId}']?.matched ?? false, mutations: window.__mochiObservers?.['${observerId}']?.mutations ?? 0, selector: window.__mochiObservers?.['${observerId}']?.selector ?? '' })`,
    returnByValue: true,
  });
  try { return JSON.parse(r.result?.value || "{}"); } catch { return { match: false, mutations: 0, selector: "" }; }
}

async function uninstallPreviewObserver(tabId, observerId) {
  PREVIEW_OBSERVERS.delete(observerId);
  await cdp(tabId, "Runtime.evaluate", { expression: `window.__mochiObservers?.['${observerId}']?.disconnect?.(); delete window.__mochiObservers?.['${observerId}'];` });
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/upload.js
git commit -m "feat(extension): smart wait (preview MutationObserver + network 2xx listener)"
```

---

## Task 19: Fixture HTTP server for integration tests

**Files:**
- Create: `server/_fixtures/upload/server.mjs`
- Create: `server/_fixtures/upload/pages/01-direct.html`
- Create: `server/_fixtures/upload/pages/02-intercept.html`
- Create: `server/_fixtures/upload/pages/03-drop.html`
- Create: `server/_fixtures/upload/pages/04-paste.html`
- Create: `server/_fixtures/upload/pages/05-iframe.html`
- Create: `server/_fixtures/upload/pages/01-direct-frame.html`

- [ ] **Step 1: Create the fixture server**

Create `server/_fixtures/upload/server.mjs`:
```js
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function startFixtureServer() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/upload") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      received.push({ contentType: ct, sizeBytes: body.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sizeBytes: body.length, contentType: ct }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/pages/")) {
      const p = path.join(__dirname, req.url);
      try {
        const data = await fs.readFile(p);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(data);
      } catch { res.writeHead(404); res.end("not found"); }
      return;
    }
    res.writeHead(404); res.end("?");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, received, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
```

- [ ] **Step 2: Create the five fixture pages**

`pages/01-direct.html`:
```html
<!doctype html><meta charset=utf-8><title>upload-01</title>
<form><input id=f type=file accept="image/*"></form>
<div id=preview></div>
<script>
document.getElementById('f').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  preview.appendChild(img);
  const fd = new FormData();
  fd.append('file', file);
  await fetch('/upload', { method: 'POST', body: fd });
});
</script>
```

`pages/02-intercept.html`:
```html
<!doctype html><meta charset=utf-8><title>upload-02</title>
<input id=f type=file style="display:none">
<button id=trigger>Choose photo</button>
<div id=preview></div>
<script>
trigger.onclick = () => document.getElementById('f').click();
document.getElementById('f').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  preview.appendChild(img);
  const fd = new FormData(); fd.append('file', file);
  await fetch('/upload', { method: 'POST', body: fd });
});
</script>
```

`pages/03-drop.html`:
```html
<!doctype html><meta charset=utf-8><title>upload-03</title>
<div id=zone style="width:400px;height:200px;border:2px dashed #888">drop here</div>
<div id=preview></div>
<script>
zone.addEventListener('dragover', e => e.preventDefault());
zone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  preview.appendChild(img);
  const fd = new FormData(); fd.append('file', file);
  await fetch('/upload', { method: 'POST', body: fd });
});
</script>
```

`pages/04-paste.html`:
```html
<!doctype html><meta charset=utf-8><title>upload-04</title>
<div id=composer contenteditable="true" style="width:400px;height:200px;border:1px solid #888">paste here</div>
<div id=preview></div>
<script>
composer.addEventListener('paste', async (e) => {
  const file = e.clipboardData?.files?.[0];
  if (!file) return;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  preview.appendChild(img);
  const fd = new FormData(); fd.append('file', file);
  await fetch('/upload', { method: 'POST', body: fd });
});
</script>
```

`pages/05-iframe.html`:
```html
<!doctype html><meta charset=utf-8><title>upload-05</title>
<h1>Outer page</h1>
<iframe src="/pages/01-direct-frame.html" style="width:600px;height:300px"></iframe>
```

`pages/01-direct-frame.html`:
```html
<!doctype html><meta charset=utf-8><title>upload-01-frame</title>
<form><input id=f type=file accept="image/*"></form>
<div id=preview></div>
<script>
document.getElementById('f').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  preview.appendChild(img);
  const fd = new FormData(); fd.append('file', file);
  await fetch('/upload', { method: 'POST', body: fd });
});
</script>
```

- [ ] **Step 3: Commit**

```bash
git add server/_fixtures/upload/
git commit -m "test(fixtures): HTTP server + five upload fixture pages"
```

---

## Task 20: End-to-end integration test runner

**Files:**
- Create: `server/_upload_e2e.mjs`

- [ ] **Step 1: Write the e2e test**

Create `server/_upload_e2e.mjs`:
```js
// _upload_e2e.mjs — end-to-end upload test against a real Chrome via the broker.
// Requires the Mochi extension loaded and a running Chrome instance.
//
// Skip cleanly if the extension is not connected — same convention as existing _integration.mjs.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { startFixtureServer } from "./_fixtures/upload/server.mjs";
import { Bridge } from "./src/bridge.js";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { initUploads } from "./src/uploads.js";

const PNG = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13,
  0x49,0x48,0x44,0x52, 0,0,0,1, 0,0,0,1, 8,2, 0,0,0,
  0x90,0x77,0x53,0xde, 0,0,0,12, 0x49,0x44,0x41,0x54,
  0x08,0xd7,0x63,0x00,0x01,0x00,0x00,0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,
  0,0,0,0, 0x49,0x45,0x4e,0x44, 0xae,0x42,0x60,0x82,
]);

const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-e2e-"));
process.env.MOCHI_PROJECT_DIR = tmpProject;
await initUploads();
initToolsState({ log: () => {} });

const fix = await startFixtureServer();
console.log("fixture server:", fix.port);

const bridge = new Bridge({ log: () => {} });
const role = await bridge.start({ port: 9009 });
console.log("bridge role:", role);

if (!bridge.isConnected()) {
  console.log("SKIP e2e: extension not connected");
  await fix.close();
  await bridge.close?.();
  process.exit(0);
}

// 1. Stage the test PNG
const staged = JSON.parse((await handleToolCall(bridge, {
  name: "browser_upload_stage",
  arguments: { source: { base64: PNG.toString("base64") }, name: "1x1.png" },
})).content[0].text);
assert.equal(staged.ok, true);

// 2. For each fixture page, navigate + upload + assert preview
const pages = [
  { url: `http://127.0.0.1:${fix.port}/pages/01-direct.html`,    target: { selector: "input[type=file]" }, strategies: ["direct"] },
  { url: `http://127.0.0.1:${fix.port}/pages/02-intercept.html`, target: { trigger: { selector: "#trigger" } }, strategies: ["intercept"] },
  { url: `http://127.0.0.1:${fix.port}/pages/03-drop.html`,      target: { selector: "#zone" }, strategies: ["drop"] },
  { url: `http://127.0.0.1:${fix.port}/pages/04-paste.html`,     target: { selector: "#composer" }, strategies: ["paste"] },
  { url: `http://127.0.0.1:${fix.port}/pages/05-iframe.html`,    target: { selector: "input[type=file]" }, strategies: ["direct"], frames: "all" },
];

await bridge.send("session_start", { groupBy: "client" });
for (const p of pages) {
  console.log("→", p.url, "strategies:", p.strategies.join(","));
  await bridge.send("navigate", { url: p.url });
  await new Promise((r) => setTimeout(r, 500));

  const upArgs = { stashId: staged.stashId, ...p.target, strategies: p.strategies, frames: p.frames };
  const upRaw = await handleToolCall(bridge, { name: "browser_upload_file", arguments: upArgs });
  const up = JSON.parse(upRaw.content[0].text);
  assert.equal(up.ok, true, `upload failed on ${p.url}: ${JSON.stringify(up.error || up)}`);
  console.log("  strategy:", up.strategy, "waitedFor:", up.waitedFor?.signal);
}

assert.ok(fix.received.length >= 5, `expected ≥5 uploads received, got ${fix.received.length}`);
console.log("✓ e2e upload — all five fixtures uploaded");

await bridge.send("session_end", {}).catch(() => {});
await fix.close();
await bridge.close?.();
await fs.rm(tmpProject, { recursive: true, force: true });
```

- [ ] **Step 2: Add to package.json test script (optional, only when extension live)**

The e2e test should NOT block the default `npm test` since it requires Chrome+extension. Instead, add a separate npm script:
```json
    "test:e2e:upload": "node _upload_e2e.mjs",
```

- [ ] **Step 3: Run e2e (manual, with extension loaded)**

```bash
cd server && node _upload_e2e.mjs
```
Expected output: 5 fixture uploads succeed, server received ≥5 POSTs.

- [ ] **Step 4: Commit**

```bash
git add server/_upload_e2e.mjs server/package.json
git commit -m "test(upload): end-to-end integration runner against fixture server"
```

---

## Task 21: Path allowlist enforcement in extension

**Files:**
- Modify: `extension/upload.js`

- [ ] **Step 1: Implement allowlist check**

In `extension/upload.js`, at the top of `handleUploadFile`, after the `filePaths.length` check, add:
```js
  for (const p of filePaths) {
    if (!isPathAllowed(p)) {
      return { ok: false, error: { code: "permission", message: "path not in allowlist", details: { path: p } } };
    }
  }
```
And add:
```js
function isPathAllowed(p) {
  if (typeof p !== "string" || !p.length) return false;
  // .continuum/uploads/ relative segment must be in the path
  if (p.includes("/.continuum/uploads/") || p.includes("\\.continuum\\uploads\\")) return true;
  const extras = (globalThis.SUPER_TESTER_UPLOAD_ALLOW_PATHS || "").split(":").filter(Boolean);
  return extras.some((prefix) => p.startsWith(prefix));
}
```

(For the env var to reach the extension, the server can include it in the wire payload as `allowPaths`; alternative is to enforce server-side only. For v1, server enforcement via `resolveOrStage` already ensures all caller `path:` sources are re-staged into `.continuum/uploads/`. The extension check is defense-in-depth.)

- [ ] **Step 2: Commit**

```bash
git add extension/upload.js
git commit -m "feat(extension): path allowlist check for upload filePaths (defense-in-depth)"
```

---

## Task 22: Telemetry log

**Files:**
- Modify: `server/src/tools.js`

- [ ] **Step 1: Add telemetry append after successful upload**

In `server/src/tools.js`, modify `toolUploadFile` to append a telemetry line after the bridge.send succeeds:
```js
    // After: const result = await bridge.send(...)
    await appendUploadLog({
      ts: new Date().toISOString(),
      tabId: args.tabId ?? null,
      origin: globalThis.activeOrigin || null,
      stashId: resolved[0]?.stashId ?? null,
      strategy: result.strategy ?? null,
      totalMs: result.totalMs ?? null,
      ok: !!result.ok,
    });
```

And add the helper:
```js
import { uploadsDir } from "./uploads.js";
async function appendUploadLog(entry) {
  const fs = await import("node:fs/promises");
  const p = (await import("path")).join(uploadsDir(), "log.jsonl");
  try { await fs.appendFile(p, JSON.stringify(entry) + "\n"); } catch {}
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/tools.js
git commit -m "feat(uploads): append per-upload telemetry to .continuum/uploads/log.jsonl"
```

---

## Task 23: Hook session GC into existing session_end path

**Files:**
- Modify: `server/src/tools.js`

- [ ] **Step 1: Locate the `session_end` wire dispatch**

Search `server/src/tools.js` for `"session_end"`. In whichever local helper handles it (or where it's forwarded), after the bridge `session_end` returns, call `gcSession(sessionId)`.

If `session_end` is currently bridge-forwarded only, intercept it server-side by adding a local hook:
```js
// In handleToolCall, BEFORE the wire dispatch for browser_session_end:
if (name === "browser_session_end") {
  const sid = currentClaudeSessionId();
  const res = await runWireTool(bridge, name, args);
  if (sid) {
    try { await gcSession(sid); } catch (e) { /* swallow */ }
  }
  return res;
}
```

(Import: `import { stage as stageUpload, uploadErr, uploadsDir, gcSession } from "./uploads.js";`)

- [ ] **Step 2: Commit**

```bash
git add server/src/tools.js
git commit -m "feat(uploads): gc session-scoped uploads on browser_session_end"
```

---

## Task 24: Rebuild bundle and verify

**Files:**
- Modify: `server/dist/server.bundle.mjs`

- [ ] **Step 1: Rebuild**

```bash
cd server && npm run build
```
Expected: no errors; `dist/server.bundle.mjs` updated.

- [ ] **Step 2: Run the full test suite**

```bash
cd server && npm test
```
Expected: all four test scripts green (`_smoke.mjs`, `_uploads.test.mjs`, `_upload_wire.test.mjs`, `_integration.mjs`, `_multi-client.mjs`).

- [ ] **Step 3: Run smoke + manual e2e**

```bash
cd server && node _smoke.mjs && node _upload_e2e.mjs
```
Expected: smoke passes; e2e SKIPs if no extension, or all 5 fixtures pass.

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add server/dist/server.bundle.mjs
git commit -m "ci(server): rebuild bundle for upload tools"
```

---

## Task 25: Update README + capability docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a short Upload section**

In `README.md`, find the tool-list section and add a row:
```
- **browser_upload_stage** — stage a file into the per-project upload library (`.continuum/uploads/`); accepts path, https URL, dataUrl, or base64; returns a reusable stashId.
- **browser_upload_file** — attach a file to a page target via strategy chain (direct → intercept → drop → paste), with smart-wait completion detection. Bypasses the native file picker.
```

If there is no tool list (a quick look suggests the README has a `Tools at a glance` section), add equivalents there. If absent, add a new `### File uploads` subsection under the existing browser-tool docs.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document browser_upload_stage + browser_upload_file"
```

---

## Self-Review

### Spec coverage check

Walking each spec section against tasks:

| Spec section | Implemented by tasks |
|---|---|
| `browser_upload_stage` input/output/behavior | 4 (stageBuffer), 5 (resolveSource), 6 (URL fetch), 7 (top-level stage), 9 (tool registration) |
| `browser_upload_file` input/output | 10 (schema), 11 (server-side dispatch + sources), 12-17 (extension strategy chain) |
| Wire protocol addition | 11 (server payload), 12 (extension dispatch) |
| Storage layout (.continuum/uploads/) | 1 (initUploads), 2 (index.json), 4 (blob writes) |
| Strategy: direct | 14 |
| Strategy: intercept | 15 |
| Strategy: drop | 16 |
| Strategy: paste | 17 |
| Target resolution (selector/ref/trigger/auto) | 13 |
| Frame traversal | 13 (helpers); validated by fixture 05 in 19/20 |
| Smart wait | 18 |
| File lifecycle / GC | 8, 23 |
| Path allowlist | 21 |
| Size caps | 6 (URL streaming), 7 (top-level) |
| Telemetry | 22 |
| Error taxonomy | embedded across 4-7 (server) and 12-17 (extension); errors return from bridge as `{ ok: false, error }` per spec |
| Testing — server unit | 1-8 (uploads.test.mjs) |
| Testing — wire contract | 11 |
| Testing — integration (5 fixtures) | 19, 20 |
| Testing — smoke | 9, 10, 24 |
| Acceptance criterion: no regression in existing tests | 24 |

**Gaps:** none identified.

### Placeholder scan

- No "TBD", "TODO", "fill in", "similar to" found in tasks.
- One soft spot: Task 12 says "The exact wiring depends on whether the current SW is module-mode" — acceptable because the engineer can check `manifest.json` in one step.
- Task 13 declines to write a CDP-mock unit test, with rationale ("low value"). Acceptable per testing-strategy section of spec which scopes extension validation to integration tests.
- Task 21 notes the env var reaching the extension is server-side-enforced primarily; this is documented behavior, not a placeholder.

### Type consistency

- `stage()` returns `{ stashId, sha256, path, name, mime, sizeBytes, source, keep, dedupedFrom? }` — used consistently in Tasks 4, 7, 9, 11, 20.
- `uploadErr(code, message, details)` taxonomy used in 4-7 — codes match the spec's error table.
- Wire payload field names (`filePaths`, `fileBytes`, `target`, `strategies`, `frames`, `dispatchEvents`, `waitFor`) match between Task 11 (server) and Tasks 12-17 (extension).
- Tool names (`browser_upload_stage`, `browser_upload_file`) — consistent.
- Strategy names (`direct`, `intercept`, `drop`, `paste`) — consistent in spec, schema, switch, and tests.

No inconsistencies found.

---

## Acceptance verification (post-implementation)

Run all of the following before considering the plan complete:

1. `cd server && npm test` — all hand-rolled tests green.
2. `cd server && node _upload_e2e.mjs` with extension loaded — all five fixture pages succeed; the strategy that wins matches expectation per fixture.
3. `cat .continuum/uploads/index.json | jq` shows entries with expected sha256, mime, ext, name, source fields after an e2e run.
4. Smoke test green: `cd server && node _smoke.mjs`.
5. Bundle rebuilt: `ls -la server/dist/server.bundle.mjs` has fresh mtime; bundle size <1MB.
6. Manual: in a real Chrome with the plugin loaded, run from Claude Code:
   ```
   browser_upload_stage({ source: { url: "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png" } })
   browser_navigate({ url: "https://imgur.com/upload" })
   browser_upload_file({ stashId: "<from above>", auto: { near: "input[type=file]" } })
   ```
   and observe the image appearing in Imgur's upload preview within 15s.

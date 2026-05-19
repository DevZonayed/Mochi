// server/src/uploads.js
// Content-addressed file staging for browser_upload_* tools.
// All file I/O lives here; the extension never reads/writes the filesystem.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { request as undiciRequest } from "undici";

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
  const e = new Error(`${code}: ${message}`);
  e.uploadError = { code, message, details };
  return e;
}

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

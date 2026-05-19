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

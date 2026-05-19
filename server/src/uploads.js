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

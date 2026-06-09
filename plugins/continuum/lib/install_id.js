// install_id.js — the anonymous, machine-scoped install id (Zone-A `iid`).
// Privacy spine (spec §2, §13.4): a SINGLE random UUID v4 per machine/user, NO
// PII, NOT per-project — lives OUTSIDE the repo at ~/.mochi/install-id. It is
// PSEUDONYMOUS and ROTATING (GDPR §13.4): rotates automatically monthly OR on a
// plugin-major bump, so it is never a forever id. Resettable (delete = rotate).
//
// On-disk record (JSON): { iid, createdAt(ms), major }.
// Dependency-free; all FS is fault-tolerant (telemetry must never crash a session).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { installIdPath } from "./paths.js";

const ROTATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // ~monthly

// Parse the plugin-major from a semver-ish string ("0.7.0" -> 0). Non-numeric
// or absent -> 0 (so a missing version never spuriously rotates).
function parseMajor(version) {
  const m = /^(\d+)/.exec(String(version ?? ""));
  return m ? Number(m[1]) : 0;
}

function readRecord(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (rec && typeof rec.iid === "string" && rec.iid.length > 0) return rec;
    return null;
  } catch {
    return null; // corrupt -> treat as absent (re-mint)
  }
}

function writeRecord(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  } catch {
    // swallow — a failed write just means we re-mint next time; never throws.
  }
}

// getInstallId({ homeDir, version, now }) -> uuid string.
// Create-once, then auto-rotate when stale (>30d) or plugin-major changed.
export function getInstallId({ homeDir, version, now } = {}) {
  const file = installIdPath(homeDir);
  const ts = typeof now === "number" ? now : Date.now();
  const major = parseMajor(version);
  const rec = readRecord(file);

  const stale = rec && (ts - (rec.createdAt ?? 0)) > ROTATE_AFTER_MS;
  const majorBumped = rec && rec.major !== major;

  if (rec && !stale && !majorBumped) return rec.iid;

  const fresh = { iid: crypto.randomUUID(), createdAt: ts, major };
  writeRecord(file, fresh);
  return fresh.iid;
}

// resetInstallId({ homeDir }) — delete the file; next getInstallId mints fresh.
export function resetInstallId({ homeDir } = {}) {
  const file = installIdPath(homeDir);
  try { fs.rmSync(file, { force: true }); } catch {}
}

// telemetry_config.js — per-user/per-machine consent state for Mochi Insight.
// config.json is GITIGNORED (spec §7/§13.7): the consent decision is NOT a repo
// artifact. Opt-IN, not opt-out — ABSENCE always means "do not share" (§13.3).
//
// Two INDEPENDENT toggles (§13.3 M4):
//   share      — share anonymous, content-free Zone-A telemetry (free).
//   reviewAuto — auto efficiency-review (spends the USER's own Claude tokens);
//                separate explicit yes, default OFF.
// killSwitch "off" disables capture AND emission. sampleN = 1-in-N auto-review.

import fs from "node:fs";
import path from "node:path";
import { telemetryConfigPath, telemetryDir } from "./paths.js";

// Baked-in transport consts (spec §13.8). INGEST_WRITE_KEY is a SOFT deterrent,
// not a secret (it ships in distributed plugin code) — set at build/release.
export const INGEST_URL = "https://mochi-insight.nexalance.cloud/v1/ingest";
export const INGEST_WRITE_KEY = "REPLACE_AT_BUILD"; // placeholder; baked at release

const DEFAULTS = {
  decided: false,    // has the user answered the consent gate at least once?
  share: false,      // ABSENCE => false (opt-in)
  reviewAuto: false, // ABSENCE => false (spends user tokens)
  killSwitch: "on",  // "off" fully disables capture + emission
  sampleN: 10,       // 1-in-N auto-review sampling
};

export function readConfig(projectDir) {
  const file = telemetryConfigPath(projectDir);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    const user = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!user || typeof user !== "object" || Array.isArray(user)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...user };
  } catch {
    return { ...DEFAULTS }; // corrupt => safe defaults (not shared)
  }
}

export function writeConfig(projectDir, cfg) {
  const dir = telemetryDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = telemetryConfigPath(projectDir);
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...DEFAULTS, ...readConfig(projectDir), ...cfg }, null, 2) + "\n");
  fs.renameSync(tmp, dest);
  return dest;
}

// isSharingEnabled — the SINGLE gated boundary, re-checked at SEND time (§13.3
// M1). TRUE only when share===true AND killSwitch!=="off" AND env not "off".
// ABSENCE = false: missing cfg/env never sends.
export function isSharingEnabled(cfg, env) {
  const c = cfg || {};
  const e = env || {};
  return c.share === true && c.killSwitch !== "off" && e.MOCHI_TELEMETRY !== "off";
}

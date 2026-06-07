// Per-repo comms intent + allowlist config. config.json is COMMITTED (no
// secrets); config.local.json is a gitignored per-user override that wins on
// merge (spec §6.1/§6.2). All reads are fault-tolerant: a missing or malformed
// file degrades to defaults rather than throwing — the init hook reads this
// fs-only and must never crash a session start.

import fs from "node:fs";
import path from "node:path";
import { commsConfigPath, commsLocalConfigPath, commsDir } from "./paths.js";

const DEFAULTS = { version: 1, decided: false, declined: false, providers: {} };

function readJsonOr(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

// readConfig: committed config.json with config.local.json merged OVER it
// (local wins, top-level shallow merge), then defaults filled for any missing
// key. `version` always defaults to 1 so older/short configs still parse.
// `providers` prefers local, else committed, else {} (deep-prefer per §6.2).
export function readConfig(projectDir) {
  const committed = readJsonOr(commsConfigPath(projectDir), {});
  const local = readJsonOr(commsLocalConfigPath(projectDir), {});
  return {
    ...DEFAULTS,
    ...committed,
    ...local,
    providers: local.providers ?? committed.providers ?? {},
  };
}

// writeConfig: atomic write of config.json (write tmp + rename — rename is
// atomic on the same filesystem, mirroring the append-only/safe-write ethos of
// archive.js). Never writes config.local.json (that's the user's to manage).
export function writeConfig(projectDir, cfg) {
  const dir = commsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = commsConfigPath(projectDir);
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, dest);
  return dest;
}

// The exact shape written when a user declines comms for this repo (spec §6.1).
export function declineConfig() {
  return { version: 1, decided: true, declined: true };
}

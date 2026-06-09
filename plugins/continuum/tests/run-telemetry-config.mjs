// plugins/continuum/tests/run-telemetry-config.mjs
// telemetry_config.js: two-toggle consent (share / reviewAuto), kill-switch,
// isSharingEnabled (ABSENCE = false), INGEST_URL/INGEST_WRITE_KEY consts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readConfig, writeConfig, isSharingEnabled,
  INGEST_URL, INGEST_WRITE_KEY,
} from "../lib/telemetry_config.js";
import { telemetryConfigPath } from "../lib/paths.js";

// 1) defaults when absent: NOT decided, NOT shared, NOT reviewAuto, killSwitch on.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-default-"));
  const cfg = readConfig(dir);
  assert.equal(cfg.decided, false);
  assert.equal(cfg.share, false, "absence => not shared (opt-in not opt-out)");
  assert.equal(cfg.reviewAuto, false, "auto-review default off (spends user tokens)");
  assert.equal(cfg.killSwitch, "on");
  assert.equal(cfg.sampleN, 10);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) writeConfig persists to the gitignored config.json and round-trips.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-rt-"));
  writeConfig(dir, { decided: true, share: true, reviewAuto: true, killSwitch: "on", sampleN: 5 });
  assert.ok(fs.existsSync(telemetryConfigPath(dir)), "config.json written under telemetry/");
  const cfg = readConfig(dir);
  assert.equal(cfg.decided, true);
  assert.equal(cfg.share, true);
  assert.equal(cfg.reviewAuto, true);
  assert.equal(cfg.sampleN, 5);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) isSharingEnabled: TRUE only when share===true && killSwitch!=="off" && env not "off".
{
  assert.equal(isSharingEnabled({ share: true, killSwitch: "on" }, {}), true);
  assert.equal(isSharingEnabled({ share: true, killSwitch: "on" }, { MOCHI_TELEMETRY: "off" }), false, "env kill wins");
  assert.equal(isSharingEnabled({ share: true, killSwitch: "off" }, {}), false, "killSwitch off wins");
  assert.equal(isSharingEnabled({ share: false, killSwitch: "on" }, {}), false, "share false => no send");
}

// 4) ABSENCE = false: undefined cfg, undefined env, empty objects all => false.
{
  assert.equal(isSharingEnabled(undefined, undefined), false);
  assert.equal(isSharingEnabled({}, {}), false);
  assert.equal(isSharingEnabled(null, null), false);
}

// 5) baked-in INGEST consts: exact public URL + a non-empty write-key string.
{
  assert.equal(INGEST_URL, "https://mochi-insight.nexalance.cloud/v1/ingest");
  assert.equal(typeof INGEST_WRITE_KEY, "string");
}

// 6) corrupt config.json degrades to defaults (never throws).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-bad-"));
  fs.mkdirSync(path.dirname(telemetryConfigPath(dir)), { recursive: true });
  fs.writeFileSync(telemetryConfigPath(dir), "{broken");
  const cfg = readConfig(dir);
  assert.equal(cfg.share, false, "corrupt config => safe defaults (not shared)");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7) partial-update merge in writeConfig() — a single-field write must preserve
//    all other previously-persisted values (the CLI on/off/review-auto subcommands
//    each flip exactly ONE toggle; a plain {...DEFAULTS,...cfg} would silently wipe).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-partial-"));
  // First write a complete, non-default config.
  writeConfig(dir, { decided: true, share: true, reviewAuto: false, killSwitch: "on", sampleN: 7 });
  // Now flip only reviewAuto.
  writeConfig(dir, { reviewAuto: true });
  const cfg = readConfig(dir);
  assert.equal(cfg.reviewAuto, true, "partial write must update the targeted field");
  assert.equal(cfg.decided, true, "partial write must NOT wipe decided");
  assert.equal(cfg.share, true, "partial write must NOT wipe share");
  assert.equal(cfg.sampleN, 7, "partial write must NOT wipe sampleN");
  assert.equal(cfg.killSwitch, "on", "partial write must NOT wipe killSwitch");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("✓ telemetry_config (two-toggle consent + killSwitch + INGEST consts)");

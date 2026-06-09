// plugins/continuum/tests/run-telemetry-install-id.mjs
// install_id.js: create-once, monthly auto-rotate, plugin-major auto-rotate, reset.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getInstallId, resetInstallId } from "../lib/install_id.js";
import { installIdPath } from "../lib/paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 86400 * 1000;

// 1) create-once: same id across calls; file is JSON {iid,createdAt,major}; uuid v4.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-create-"));
  const a = getInstallId({ homeDir: home, version: "0.7.0" });
  const b = getInstallId({ homeDir: home, version: "0.7.0" });
  assert.match(a, UUID_RE, "id is a v4 uuid");
  assert.equal(a, b, "second call returns the same id (create-once)");
  const rec = JSON.parse(fs.readFileSync(installIdPath(home), "utf8"));
  assert.equal(rec.iid, a);
  assert.equal(rec.major, 0, "major parsed from version 0.7.0");
  assert.equal(typeof rec.createdAt, "number");
  fs.rmSync(home, { recursive: true, force: true });
}

// 2) monthly auto-rotate: a createdAt > ~30 days old yields a NEW id.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-month-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0", now: 1_000_000_000_000 });
  const later = getInstallId({ homeDir: home, version: "0.7.0", now: 1_000_000_000_000 + 31 * DAY });
  assert.notEqual(later, first, "id rotates after ~30 days");
  assert.match(later, UUID_RE);
  fs.rmSync(home, { recursive: true, force: true });
}

// 3) plugin-major bump auto-rotate: same window, higher major -> NEW id.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-major-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0", now: 2_000_000_000_000 });
  const bumped = getInstallId({ homeDir: home, version: "1.0.0", now: 2_000_000_000_000 + DAY });
  assert.notEqual(bumped, first, "id rotates on plugin-major bump");
  const rec = JSON.parse(fs.readFileSync(installIdPath(home), "utf8"));
  assert.equal(rec.major, 1, "stored major updated to 1");
  fs.rmSync(home, { recursive: true, force: true });
}

// 4) no rotate within the window on same major (stability).
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-stable-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0", now: 3_000_000_000_000 });
  const same = getInstallId({ homeDir: home, version: "0.7.5", now: 3_000_000_000_000 + 5 * DAY });
  assert.equal(same, first, "no rotate within 30d on same major");
  fs.rmSync(home, { recursive: true, force: true });
}

// 5) resetInstallId deletes the file; next get mints a fresh id.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-reset-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0" });
  resetInstallId({ homeDir: home });
  assert.equal(fs.existsSync(installIdPath(home)), false, "reset removed the file");
  const fresh = getInstallId({ homeDir: home, version: "0.7.0" });
  assert.notEqual(fresh, first, "post-reset id is fresh");
  fs.rmSync(home, { recursive: true, force: true });
}

// 6) corrupt file is treated as absent (re-mint, no throw).
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-corrupt-"));
  fs.mkdirSync(path.dirname(installIdPath(home)), { recursive: true });
  fs.writeFileSync(installIdPath(home), "{not json");
  const id = getInstallId({ homeDir: home, version: "0.7.0" });
  assert.match(id, UUID_RE, "corrupt file re-mints a valid id");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("✓ telemetry install_id (create-once + rotate + reset)");

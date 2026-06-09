// plugins/continuum/tests/run-telemetry-all.mjs
// Runs every telemetry unit runner in one shot (CI entry point).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Discover every telemetry unit runner that EXISTS (excluding this aggregator),
// so phases that add runners (emit/aggregate) are picked up automatically and
// the suite never fails on a not-yet-created forward reference.
const runners = fs
  .readdirSync(here)
  .filter((f) => /^run-telemetry-.+\.mjs$/.test(f) && f !== "run-telemetry-all.mjs")
  .sort();
let failed = 0;
for (const r of runners) {
  const res = spawnSync(process.execPath, [path.join(here, r)], { stdio: "inherit" });
  if (res.status !== 0) { failed++; console.error(`✗ ${r} failed`); }
}
if (failed) { console.error(`\n${failed} telemetry runner(s) failed`); process.exit(1); }
console.log("\n✓ ALL telemetry runners passed");

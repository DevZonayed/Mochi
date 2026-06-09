// plugins/continuum/tests/run-telemetry-all.mjs
// Runs every telemetry unit runner in one shot (CI entry point).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runners = [
  "run-telemetry-paths.mjs",
  "run-telemetry-install-id.mjs",
  "run-telemetry-config.mjs",
  "run-telemetry-redact.mjs",
  "run-telemetry-log.mjs",
  "run-telemetry-emit.mjs",
  "run-telemetry-aggregate.mjs",
];
let failed = 0;
for (const r of runners) {
  const res = spawnSync(process.execPath, [path.join(here, r)], { stdio: "inherit" });
  if (res.status !== 0) { failed++; console.error(`✗ ${r} failed`); }
}
if (failed) { console.error(`\n${failed} telemetry runner(s) failed`); process.exit(1); }
console.log("\n✓ ALL telemetry runners passed");

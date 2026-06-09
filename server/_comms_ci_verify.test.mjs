// server/_comms_ci_verify.test.mjs
// Asserts the CI verify step gates on the comms bundle (spec §9.4),
// and that paths-ignore already covers server/dist/**.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const wf = fs.readFileSync(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");

// the comms bundle must be asserted in CI
assert.ok(wf.includes("test -f server/dist/comms.bundle.mjs"),
  "CI verify step must assert comms.bundle.mjs exists");
// existing browser bundle assertion must remain
assert.ok(wf.includes("test -f server/dist/server.bundle.mjs"),
  "CI verify step must still assert server.bundle.mjs exists");
// dist already ignored from rebuild triggers (no change needed, but assert it stayed)
assert.ok(wf.includes("server/dist/**"),
  "paths-ignore must still cover server/dist/**");

console.log("✓ CI build.yml verifies comms bundle (spec §9.4)");

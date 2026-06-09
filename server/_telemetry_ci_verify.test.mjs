// Asserts CI runs the telemetry plugin harness + the ingest server tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wf = fs.readFileSync(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");
assert.ok(wf.includes("run-telemetry.sh"), "CI must run the telemetry plugin harness");
assert.ok(wf.includes("telemetry-server") && /node --test/.test(wf), "CI must run telemetry-server node --test");

// plugins/continuum/tests/run-telemetry-paths.mjs
// Telemetry path helpers: dir + four files under .continuum/telemetry, plus the
// home-scoped install-id path OUTSIDE the repo (~/.mochi/install-id).
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  telemetryDir, telemetryEventsPath, telemetryConfigPath,
  telemetryQueuePath, telemetryReviewsDir, telemetryPendingReviewPath,
  installIdPath,
} from "../lib/paths.js";

const PROJ = "/tmp/fake-project";

// 1) telemetryDir is .continuum/telemetry under the project
{
  assert.equal(telemetryDir(PROJ), path.join(PROJ, ".continuum", "telemetry"));
}

// 2) the four telemetry files sit directly under telemetryDir with exact names
{
  const d = telemetryDir(PROJ);
  assert.equal(telemetryEventsPath(PROJ), path.join(d, "events.jsonl"));
  assert.equal(telemetryConfigPath(PROJ), path.join(d, "config.json"));
  assert.equal(telemetryQueuePath(PROJ), path.join(d, "queue.jsonl"));
  assert.equal(telemetryReviewsDir(PROJ), path.join(d, "reviews"));
  // pendingReviewPath is the single canonical location — both producer (session_end)
  // and consumer (session_start) must use this helper, never derive independently.
  assert.equal(telemetryPendingReviewPath(PROJ), path.join(d, ".pending-review.json"));
}

// 3) install-id lives OUTSIDE the repo, home-scoped at ~/.mochi/install-id.
//    Default uses os.homedir(); an injected homeDir overrides (for tests).
{
  assert.equal(installIdPath(), path.join(os.homedir(), ".mochi", "install-id"));
  assert.equal(installIdPath("/tmp/fakehome"), path.join("/tmp/fakehome", ".mochi", "install-id"));
}

console.log("✓ telemetry paths");

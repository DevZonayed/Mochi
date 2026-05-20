import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { parsePlaybook, serializePlaybook, playbooksDir, initPlaybooks } from "./src/playbooks.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();

assert.equal(playbooksDir(), path.join(tmp, ".continuum", "playbooks"));
const stat = await fs.stat(playbooksDir());
assert.ok(stat.isDirectory());

const md = [
  "---",
  "origin: mail.google.com",
  "feature: send-email",
  "title: Send email",
  "verifiable: true",
  "inputs:",
  "  - { name: to, type: email, required: true }",
  "outputs: []",
  "preconditions: [logged-in]",
  "composes: []",
  "next: null",
  "cron: null",
  "last_verified: 2026-05-20T10:00:00Z",
  "success_count: 0",
  "playbook_version: 1",
  "schema_version: 1",
  "---",
  "",
  "## Summary",
  "Send a gmail message.",
  "",
  "## Preconditions",
  "User logged in.",
  "",
  "## Steps",
  "1. Click compose.",
  "",
  "## Verification",
  "Toast appears.",
  "",
  "## Selectors used",
  "",
  "| intent | selector |",
  "|---|---|",
  "| compose | `[data-tooltip=Compose]` |",
  "",
  "## Recent runs",
  "",
  "- r1 (2026-05-20) — pass, 6s",
  "",
  "## Screenshots",
  "",
  "- (none yet)",
  "",
].join("\n");

const pb = parsePlaybook(md);
assert.equal(pb.meta.origin, "mail.google.com");
assert.equal(pb.meta.feature, "send-email");
assert.equal(pb.meta.verifiable, true);
assert.equal(pb.meta.inputs.length, 1);
assert.equal(pb.meta.inputs[0].name, "to");
assert.ok(pb.sections.summary.includes("Send a gmail message"));
assert.ok(pb.sections.steps.includes("Click compose"));
assert.equal(pb.sections.selectors_used.length, 1);
assert.equal(pb.sections.selectors_used[0].intent, "compose");

const round = serializePlaybook(pb);
assert.equal(round, md, "round-trip serialization should be byte-identical");

console.log("✓ Task 1 — parse + round-trip");
await fs.rm(tmp, { recursive: true, force: true });

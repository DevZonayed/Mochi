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

import { validatePlaybook, playbookErr } from "./src/playbooks.js";

{
  // missing required fields
  let err = validatePlaybook({ meta: {}, body: "" });
  assert.equal(err.code, "playbook-validation-failed");
  assert.ok(err.details.issues.some((x) => x.includes("origin")));

  // bad id shape
  err = validatePlaybook({ meta: { origin: "Bad Origin!!", feature: "send-email" }, body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n" });
  assert.equal(err.code, "playbook-validation-failed");
  assert.ok(err.details.issues.some((x) => x.toLowerCase().includes("origin")));

  // bad feature slug
  err = validatePlaybook({ meta: { origin: "mail.google.com", feature: "Send Email" }, body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n" });
  assert.equal(err.code, "playbook-validation-failed");
  assert.ok(err.details.issues.some((x) => x.toLowerCase().includes("feature")));

  // invalid input type
  err = validatePlaybook({
    meta: { origin: "mail.google.com", feature: "send-email", inputs: [{ name: "x", type: "weird-type" }] },
    body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  });
  assert.ok(err.details.issues.some((x) => x.toLowerCase().includes("type")));

  // valid playbook returns null
  const ok = validatePlaybook({
    meta: { origin: "mail.google.com", feature: "send-email", inputs: [], outputs: [] },
    body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  });
  assert.equal(ok, null);

  // playbookErr is constructible
  const e = playbookErr("playbook-not-found", "no such playbook", { id: "x" });
  assert.equal(e.playbookError.code, "playbook-not-found");

  console.log("✓ Task 2 — validation");
}

import { savePlaybook, getPlaybook, listPlaybooks, deletePlaybook, rebuildIndex } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const meta = {
    origin: "mail.google.com",
    feature: "send-email",
    title: "Send email",
    verifiable: true,
    preconditions: [],
    inputs: [{ name: "to", type: "email", required: true }],
    outputs: [],
    composes: [],
    next: null,
    cron: null,
    last_verified: "2026-05-20T10:00:00Z",
    success_count: 0,
    playbook_version: 1,
    schema_version: 1,
  };
  const body = "## Summary\nSend.\n## Preconditions\nLogged-in.\n## Steps\n1. compose.\n## Verification\nToast.\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n";
  const workflow = { playbookId: "mail.google.com/send-email", schemaVersion: 1, steps: [{ action: "navigate", url: "https://mail.google.com" }] };

  const saved = await savePlaybook({ id: "mail.google.com/send-email", meta, body, workflow });
  assert.equal(saved.ok, true);
  assert.ok(saved.path.endsWith("send-email.md"));

  const got = await getPlaybook("mail.google.com/send-email");
  assert.equal(got.meta.feature, "send-email");
  assert.equal(got.workflow.steps[0].action, "navigate");

  const list = await listPlaybooks({ verifiable: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "mail.google.com/send-email");

  // invalid playbook rejected
  await assert.rejects(savePlaybook({ id: "mail.google.com/send-email", meta: { ...meta, feature: "BAD!" }, body, workflow }), /playbook-validation-failed/);
  // id mismatch rejected
  await assert.rejects(savePlaybook({ id: "other.com/x", meta, body, workflow }), /playbook-id-mismatch/);

  await deletePlaybook("mail.google.com/send-email");
  const list2 = await listPlaybooks({});
  assert.equal(list2.length, 0);

  // rebuildIndex idempotence
  const r = await rebuildIndex();
  assert.equal(r.entries, 0);

  console.log("✓ Task 3 — CRUD");
  await fs.rm(tmp, { recursive: true, force: true });
}

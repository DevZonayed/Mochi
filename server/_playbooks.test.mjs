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

import { matchPlaybook } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  await savePlaybook({
    id: "mail.google.com/send-email",
    meta: { origin: "mail.google.com", feature: "send-email", inputs: [], outputs: [], verifiable: true, tags: ["email"] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nNavigate https://mail.google.com/mail/u/0/#inbox\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [{ action: "navigate", url: "https://mail.google.com/mail/u/0/#inbox" }] },
  });
  await savePlaybook({
    id: "twitter.com/post",
    meta: { origin: "twitter.com", feature: "post", inputs: [], outputs: [], verifiable: false, tags: ["social"] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: null,
  });

  const m1 = await matchPlaybook({ url: "https://mail.google.com/mail/u/0/#inbox", taskText: "send an email" });
  assert.ok(m1.length >= 1);
  assert.equal(m1[0].playbookId, "mail.google.com/send-email");
  assert.ok(m1[0].score >= 50);

  const m2 = await matchPlaybook({ url: "https://unrelated.com" });
  assert.equal(m2.length, 0); // below threshold

  const m3 = await matchPlaybook({ taskText: "social post on twitter", url: null });
  assert.ok(m3.some((x) => x.playbookId === "twitter.com/post"));

  console.log("✓ Task 4 — matchPlaybook");
  await fs.rm(tmp, { recursive: true, force: true });
}

import { promoteFromTrace } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const trace = [
    { tool: "browser_navigate", args: { url: "https://example.com/login" } },
    { tool: "browser_type",     args: { intent: "username-field", value: "user@example.com" } },
    { tool: "browser_type",     args: { intent: "password-field", value: "${SECRET}" } },
    { tool: "browser_click",    args: { intent: "submit-button" } },
    { tool: "browser_assert",   args: { kind: "url-contains", value: "/dashboard" } },
  ];

  const r = await promoteFromTrace({ label: "login", trace, title: "Log in via example.com" });
  assert.equal(r.created, true);
  assert.equal(r.playbookId, "example.com/login");
  const pb = await getPlaybook("example.com/login");
  assert.equal(pb.meta.origin, "example.com");
  assert.equal(pb.meta.feature, "login");
  assert.equal(pb.workflow.steps.length, 5);
  assert.equal(pb.workflow.steps[1].action, "type");
  assert.equal(pb.workflow.steps[1].intent, "username-field");
  // inputs inferred from intents
  assert.ok(pb.meta.inputs.some((i) => i.name === "username"));
  assert.ok(pb.meta.inputs.some((i) => i.name === "password"));
  assert.equal(pb.meta.inputs.find((i) => i.name === "password").type, "secret");

  // second call → updates, not create
  const trace2 = [...trace, { tool: "browser_screenshot", args: {} }];
  const r2 = await promoteFromTrace({ label: "login", trace: trace2 });
  assert.equal(r2.created, false);
  assert.match(r2.diffSummary, /added|updated/i);

  console.log("✓ Task 5 — promoter");
  await fs.rm(tmp, { recursive: true, force: true });
}

import { composeResolve } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  // single playbook
  await savePlaybook({
    id: "twitter.com/post", meta: { origin: "twitter.com", feature: "post", inputs: [{ name: "text", type: "text", required: true }], outputs: [{ name: "postUrl", type: "url" }], verifiable: false }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });
  // parent composes child
  await savePlaybook({
    id: "blog.example.com/cross-post", meta: { origin: "blog.example.com", feature: "cross-post", inputs: [{ name: "text", type: "text", required: true }], outputs: [], verifiable: false, composes: [{ id: "twitter.com/post", inputs: { text: "${input.text}" } }] }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });

  const plan = await composeResolve("blog.example.com/cross-post", { text: "hi" });
  assert.equal(plan.legs.length, 2); // self + composed
  assert.equal(plan.legs[1].playbookId, "twitter.com/post");
  assert.equal(plan.legs[1].inputs.text, "hi");

  // missing input
  await assert.rejects(composeResolve("twitter.com/post", {}), /playbook-input-missing/);

  // cycle
  await savePlaybook({
    id: "cycle.com/a", meta: { origin: "cycle.com", feature: "a", inputs: [], outputs: [], verifiable: false, composes: [{ id: "cycle.com/b", inputs: {} }] }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });
  await savePlaybook({
    id: "cycle.com/b", meta: { origin: "cycle.com", feature: "b", inputs: [], outputs: [], verifiable: false, composes: [{ id: "cycle.com/a", inputs: {} }] }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });
  await assert.rejects(composeResolve("cycle.com/a", {}), /playbook-compose-cycle/);

  console.log("✓ Task 6 — composeResolve");
  await fs.rm(tmp, { recursive: true, force: true });
}

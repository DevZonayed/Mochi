import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { initPlaybooks, savePlaybook } from "./src/playbooks.js";
import { generateDashboard } from "./src/playbook-dashboard.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-dash-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  // Empty library
  const out0 = path.join(tmp, "ui-empty.html");
  const r0 = await generateDashboard({ outputPath: out0 });
  assert.equal(r0.ok, true);
  assert.equal(r0.playbookCount, 0);
  const html0 = await fs.readFile(out0, "utf8");
  assert.ok(html0.startsWith("<!doctype html>") || html0.startsWith("<!DOCTYPE html>"));
  assert.ok(html0.includes("Mochi Playbooks"));

  // Two playbooks
  await savePlaybook({
    id: "mail.google.com/send-email",
    meta: { origin: "mail.google.com", feature: "send-email", title: "Send email", verifiable: true, inputs: [{ name: "to", type: "email", required: true }], outputs: [], success_count: 5, last_verified: "2026-05-20T00:00:00Z", tags: ["email"] },
    body: "## Summary\nSend.\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  });
  await savePlaybook({
    id: "twitter.com/post",
    meta: { origin: "twitter.com", feature: "post", title: "Post tweet", verifiable: false, inputs: [], outputs: [], success_count: 2, last_verified: "2026-05-19T00:00:00Z", tags: ["social"], playbook_version: 0 },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  });

  const out = path.join(tmp, "ui.html");
  const r = await generateDashboard({ outputPath: out });
  assert.equal(r.ok, true);
  assert.equal(r.playbookCount, 2);
  const html = await fs.readFile(out, "utf8");
  assert.ok(html.includes("mail.google.com/send-email"));
  assert.ok(html.includes("twitter.com/post"));
  assert.ok(html.includes("Send email"));
  assert.ok(html.includes("draft")); // playbook_version: 0 → "draft" badge

  // Size sanity (<500KB for a 2-playbook library with no screenshots)
  const stat = await fs.stat(out);
  assert.ok(stat.size < 500_000);

  console.log("✓ playbook dashboard");
  await fs.rm(tmp, { recursive: true, force: true });
}

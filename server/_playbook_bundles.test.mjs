import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { initPlaybooks, savePlaybook, getPlaybook, listPlaybooks } from "./src/playbooks.js";
import { exportBundle, importBundle } from "./src/playbook-bundles.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-bundle-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const meta = {
    origin: "mail.google.com", feature: "send-email", title: "Send", verifiable: true,
    preconditions: [], inputs: [{ name: "to", type: "email", required: true }], outputs: [],
    composes: [], next: null, cron: null,
    last_verified: "2026-05-20T00:00:00Z", success_count: 3, playbook_version: 1, schema_version: 1,
  };
  const body = "## Summary\nSend.\n## Preconditions\nLogged-in.\n## Steps\nclick send\n## Verification\nToast.\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n";
  await savePlaybook({ id: "mail.google.com/send-email", meta, body, workflow: { steps: [{ action: "click", intent: "send-button" }] } });

  // Export
  const out = path.join(tmp, "bundle.json");
  const exp = await exportBundle({ outputPath: out });
  assert.equal(exp.ok, true);
  assert.equal(exp.playbookCount, 1);
  const bundleRaw = JSON.parse(await fs.readFile(out, "utf8"));
  assert.equal(bundleRaw.schema, "mochi-playbook-bundle@1");
  assert.equal(bundleRaw.playbooks.length, 1);
  assert.equal(bundleRaw.playbooks[0].id, "mail.google.com/send-email");
  assert.ok(bundleRaw.playbooks[0].markdown.includes("send-email"));

  // Import into fresh project
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-bundle2-"));
  process.env.MOCHI_PROJECT_DIR = tmp2;
  await initPlaybooks();
  const imp = await importBundle({ bundlePath: out });
  assert.equal(imp.ok, true);
  assert.equal(imp.imported.length, 1);
  const pb2 = await getPlaybook("mail.google.com/send-email");
  assert.ok(pb2);
  assert.equal(pb2.meta.success_count, 3);

  // Round-trip body byte-identical
  const orig = (await fs.readFile(path.join(tmp,  ".continuum/playbooks/mail.google.com/send-email.md"), "utf8"));
  const round = (await fs.readFile(path.join(tmp2, ".continuum/playbooks/mail.google.com/send-email.md"), "utf8"));
  assert.equal(round, orig);

  // overwrite=false skip
  const skipResult = await importBundle({ bundlePath: out });
  assert.equal(skipResult.imported.length, 0);
  assert.equal(skipResult.skipped.length, 1);
  assert.equal(skipResult.skipped[0].reason, "already-exists");

  // overwrite=true replaces
  const ovResult = await importBundle({ bundlePath: out, overwrite: true });
  assert.equal(ovResult.imported.length, 1);

  // rewriteOrigin
  const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-bundle3-"));
  process.env.MOCHI_PROJECT_DIR = tmp3;
  await initPlaybooks();
  const rwResult = await importBundle({ bundlePath: out, rewriteOrigin: "staging.example.com" });
  assert.equal(rwResult.ok, true);
  assert.equal(rwResult.imported[0], "staging.example.com/send-email");
  assert.equal(rwResult.rewrittenFrom, "mail.google.com");

  // Bad schema
  const bad = path.join(tmp, "bad.json");
  await fs.writeFile(bad, JSON.stringify({ schema: "something-else" }));
  await assert.rejects(importBundle({ bundlePath: bad }), /bundle-schema-mismatch/);

  console.log("✓ playbook bundles");
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(tmp2, { recursive: true, force: true });
  await fs.rm(tmp3, { recursive: true, force: true });
}

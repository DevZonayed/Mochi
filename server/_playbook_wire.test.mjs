import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { initPlaybooks, savePlaybook } from "./src/playbooks.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-wire-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();
initToolsState({ log: () => {} });

const sent = [];
const bridge = {
  mode: "broker", isConnected: () => true, getLocalClientId: () => "mc",
  mcpClients: new Map(), extensionWs: {},
  send: async (type, params) => { sent.push({ type, params }); return { ok: true }; },
};

// save
let r = await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
  id: "example.com/login",
  meta: { origin: "example.com", feature: "login", verifiable: true, inputs: [{ name: "user", type: "text", required: true }], outputs: [] },
  body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  workflow: { steps: [{ action: "navigate", url: "https://example.com/login" }] },
}});
let p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.ok(p.path.endsWith("login.md"));

// list
r = await handleToolCall(bridge, { name: "browser_playbook_list", arguments: { verifiable: true } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(p.items.length, 1);
assert.equal(p.items[0].id, "example.com/login");

// get
r = await handleToolCall(bridge, { name: "browser_playbook_get", arguments: { id: "example.com/login" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(p.meta.feature, "login");

// match
r = await handleToolCall(bridge, { name: "browser_playbook_match", arguments: { url: "https://example.com/login", taskText: "login" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.ok(p.matches.length >= 1);
assert.equal(p.matches[0].playbookId, "example.com/login");

// run (verifies wire payload generation)
sent.length = 0;
r = await handleToolCall(bridge, { name: "browser_playbook_run", arguments: { id: "example.com/login", inputs: { user: "test" } } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(sent[0].type, "navigate");
assert.equal(sent[0].params.url, "https://example.com/login");

// propose_update
r = await handleToolCall(bridge, { name: "browser_playbook_propose_update", arguments: {
  label: "signup",
  trace: [
    { tool: "browser_navigate", args: { url: "https://example.com/signup" } },
    { tool: "browser_type",     args: { intent: "email-field",    value: "a@b.com" } },
    { tool: "browser_click",    args: { intent: "submit-button" } },
  ],
}});
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(p.created, true);
assert.equal(p.playbookId, "example.com/signup");

// delete
r = await handleToolCall(bridge, { name: "browser_playbook_delete", arguments: { id: "example.com/login" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);

// not-found
r = await handleToolCall(bridge, { name: "browser_playbook_get", arguments: { id: "missing.com/x" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, false);
assert.equal(p.error.code, "playbook-not-found");

console.log("✓ playbook wire contract");

// ---------------- v1.5 wire contracts ----------------

// secret_check
process.env.MOCHI_TEST_SECRET = "topsecret";
await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
  id: "test.example.com/secret-flow",
  meta: { origin: "test.example.com", feature: "secret-flow", verifiable: true,
    inputs: [
      { name: "password", type: "secret", required: true, ref: "${env:MOCHI_TEST_SECRET}" },
      { name: "missing",  type: "secret", required: true, ref: "${env:NOT_SET_VAR}" },
    ], outputs: [] },
  body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  workflow: { steps: [] },
}});
const sc = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_secret_check", arguments: { id: "test.example.com/secret-flow" } })).content[0].text);
assert.equal(sc.ok, true);
assert.equal(sc.secrets.length, 2);
assert.equal(sc.secrets.find((s) => s.name === "password").available, true);
assert.equal(sc.secrets.find((s) => s.name === "missing").available, false);

// seed_from_codebase against the next-app fixture
const fixtureRoot = path.join(path.dirname(import.meta.url.replace("file://", "")), "_fixtures/codebase/next-app");
const seedRaw = await handleToolCall(bridge, { name: "browser_playbook_seed_from_codebase", arguments: { projectRoot: fixtureRoot, domain: "fixture.example.com", dryRun: true } });
const seed = JSON.parse(seedRaw.content[0].text);
assert.equal(seed.ok, true);
assert.equal(seed.framework, "next-app-router");
assert.ok(seed.drafts.length >= 2);

// diff_accept: smoke-test wiring (no real run; just confirm error code on missing run)
const da = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_diff_accept", arguments: { id: "test.example.com/secret-flow", runId: "r-nonexistent" } })).content[0].text);
assert.equal(da.ok, true);
assert.equal(da.accepted?.length || 0, 0);

console.log("✓ v1.5 wire contracts");
delete process.env.MOCHI_TEST_SECRET;
await fs.rm(tmp, { recursive: true, force: true });

// v2: blocked verdict
{
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2wire-"));
  process.env.MOCHI_PROJECT_DIR = tmp2;
  await initPlaybooks();

  // Save a playbook that requires a missing secret + a missing free input
  await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
    id: "blocked.example.com/login",
    meta: { origin: "blocked.example.com", feature: "login", verifiable: true,
      inputs: [
        { name: "user",     type: "text",   required: true,  ref: null },
        { name: "password", type: "secret", required: true,  ref: "${env:NOT_DEFINED_VAR}" },
      ], outputs: [] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  }});
  const r = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_run", arguments: { id: "blocked.example.com/login" } })).content[0].text);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "blocked");
  assert.ok(r.needs.length >= 2);
  assert.ok(r.needs.find((n) => n.name === "user"));
  assert.ok(r.needs.find((n) => n.name === "password"));
  const pwd = r.needs.find((n) => n.name === "password");
  assert.match(pwd.hint, /env var/);

  await fs.rm(tmp2, { recursive: true, force: true });
}

// export → import round-trip
{
  const tmpExp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2exp-"));
  process.env.MOCHI_PROJECT_DIR = tmpExp;
  await initPlaybooks();
  await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
    id: "exp.example.com/thing",
    meta: { origin: "exp.example.com", feature: "thing", verifiable: false, inputs: [], outputs: [] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  }});
  const out = path.join(tmpExp, "bundle.json");
  const exp = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_export", arguments: { outputPath: out } })).content[0].text);
  assert.equal(exp.ok, true);
  assert.equal(exp.playbookCount, 1);

  // import into fresh dir
  const tmpImp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2imp-"));
  process.env.MOCHI_PROJECT_DIR = tmpImp;
  await initPlaybooks();
  const imp = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_import", arguments: { bundlePath: out } })).content[0].text);
  assert.equal(imp.ok, true);
  assert.equal(imp.imported.length, 1);

  await fs.rm(tmpExp, { recursive: true, force: true });
  await fs.rm(tmpImp, { recursive: true, force: true });
}

// dashboard generates with open:false
{
  const tmpDash = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2dash-"));
  process.env.MOCHI_PROJECT_DIR = tmpDash;
  await initPlaybooks();
  const outPath = path.join(tmpDash, "dash.html");
  const d = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_dashboard", arguments: { outputPath: outPath, open: false } })).content[0].text);
  assert.equal(d.ok, true);
  assert.equal(d.playbookCount, 0);
  const stat = await fs.stat(outPath);
  assert.ok(stat.size > 0);
  await fs.rm(tmpDash, { recursive: true, force: true });
}

console.log("✓ v2 wire contracts");

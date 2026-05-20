// _playbook_e2e.mjs — exercise the playbook system end-to-end against
// real Chrome via the broker + the three playbook fixture pages.
// Skips cleanly if the extension is not connected.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { startPlaybookFixtureServer } from "./_fixtures/playbooks/server.mjs";
import { Bridge } from "./src/bridge.js";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { initPlaybooks } from "./src/playbooks.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-e2e-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();
initToolsState({ log: () => {} });

const fix = await startPlaybookFixtureServer();
console.log("fixture server:", fix.port);

const bridge = new Bridge({ log: () => {} });
const role = await bridge.start({ port: 9009 });
if (!bridge.isConnected()) {
  console.log("SKIP playbook e2e: extension not connected");
  await fix.close(); await bridge.close?.();
  process.exit(0);
}

// 1. Promote a playbook from a synthetic login trace
const promoted = await handleToolCall(bridge, { name: "browser_playbook_propose_update", arguments: {
  label: "login",
  title: "Test login",
  verifiable: true,
  trace: [
    { tool: "browser_navigate", args: { url: `http://127.0.0.1:${fix.port}/pages/login-form.html` } },
    { tool: "browser_type",     args: { intent: "username-field", value: "${input.username}" } },
    { tool: "browser_type",     args: { intent: "password-field", value: "${input.password}" } },
    { tool: "browser_click",    args: { intent: "submit-button" } },
    { tool: "browser_assert",   args: { kind: "element-exists", value: { selector: "#status[data-success=true]" }, timeoutMs: 5000 } },
  ],
}});
const promotedJson = JSON.parse(promoted.content[0].text);
assert.equal(promotedJson.ok, true);
console.log("✓ promoted login playbook:", promotedJson.playbookId);

// 2. Run the playbook with explicit inputs
await bridge.send("session_start", { groupBy: "client" });
const runRaw = await handleToolCall(bridge, { name: "browser_playbook_run", arguments: { id: promotedJson.playbookId, inputs: { username: "alice", password: "secret" } } });
const run = JSON.parse(runRaw.content[0].text);
assert.equal(run.ok, true);
assert.equal(run.verdict, "pass", `expected pass, got: ${JSON.stringify(run)}`);
console.log("✓ played login playbook:", run.verdict);

// 3. Match — should find the playbook by URL
const matchRaw = await handleToolCall(bridge, { name: "browser_playbook_match", arguments: { url: `http://127.0.0.1:${fix.port}/pages/login-form.html`, taskText: "log in" } });
const match = JSON.parse(matchRaw.content[0].text);
assert.equal(match.ok, true);
assert.ok(match.matches.length >= 1, `expected ≥1 match, got ${JSON.stringify(match)}`);
console.log("✓ matched playbook");

// 4. Verify submissions on the fixture server
assert.ok(fix.submissions.length >= 1, "expected ≥1 fixture submission");

await bridge.send("session_end", {}).catch(() => {});
await fix.close();
await bridge.close?.();
await fs.rm(tmp, { recursive: true, force: true });
console.log("ALL PLAYBOOK E2E CHECKS PASSED");

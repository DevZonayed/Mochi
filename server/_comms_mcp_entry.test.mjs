// server/_comms_mcp_entry.test.mjs
// Asserts the plugin's own .mcp.json registers the comms stdio server per spec §9.3.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mcp = JSON.parse(fs.readFileSync(path.join(repoRoot, ".mcp.json"), "utf8"));

assert.ok(mcp.mcpServers, "mcpServers must exist");
// existing servers untouched
assert.ok(mcp.mcpServers.browser, "browser server must still exist");
assert.ok(mcp.mcpServers.continuum, "continuum server must still exist");

const comms = mcp.mcpServers.comms;
assert.ok(comms, "comms server entry must exist");
assert.equal(comms.type, "stdio");
assert.equal(comms.command, "node");
assert.deepEqual(comms.args, ["${CLAUDE_PLUGIN_ROOT}/server/dist/comms.bundle.mjs"]);
assert.deepEqual(comms.env, { COMMS_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}" });

console.log("✓ .mcp.json comms entry matches spec §9.3");

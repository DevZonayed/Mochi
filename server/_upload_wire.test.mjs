// _upload_wire.test.mjs — verify browser_upload_file builds correct wire payload.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { stage, initUploads } from "./src/uploads.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-wire-test-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initUploads();
initToolsState({ log: () => {} });

const staged = await stage({ source: { base64: Buffer.from([0x89,0x50,0x4e,0x47, ...Buffer.from("body")]).toString("base64") } });

const sent = [];
const bridge = {
  mode: "broker", isConnected: () => true, getLocalClientId: () => "mc-self",
  mcpClients: new Map(), extensionWs: {},
  send: async (type, params) => {
    sent.push({ type, params });
    return { ok: true, strategy: "direct", attempts: [{ strategy: "direct", ok: true, durationMs: 12 }], target: { resolved: "input", backendNodeId: 1 }, files: [{ name: staged.name, mime: staged.mime, sizeBytes: staged.sizeBytes, stashId: staged.stashId }], waitedFor: null, totalMs: 20 };
  },
};

// 1. stashId source — extension receives filePaths, NO fileBytes
sent.length = 0;
let r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: { stashId: staged.stashId, selector: "input[type=file]", strategies: ["direct"] } });
assert.equal(sent.length, 1);
assert.equal(sent[0].type, "upload_file");
assert.deepEqual(sent[0].params.filePaths, [staged.path]);
assert.equal(sent[0].params.fileBytes, undefined);
assert.deepEqual(sent[0].params.target, { selector: "input[type=file]" });
assert.deepEqual(sent[0].params.strategies, ["direct"]);

// 2. inline base64 + drop strategy → fileBytes populated
sent.length = 0;
r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: {
  base64: Buffer.from([0xff,0xd8,0xff, ...Buffer.from("jpeg")]).toString("base64"),
  selector: ".drop-zone",
  strategies: ["drop"],
}});
assert.equal(sent[0].params.fileBytes.length, 1);
assert.equal(sent[0].params.fileBytes[0].mime, "image/jpeg");
assert.ok(typeof sent[0].params.fileBytes[0].base64 === "string");

// 3. files: [] multi
sent.length = 0;
const second = await stage({ source: { base64: Buffer.from([0x47,0x49,0x46,0x38,0x39,0x61]).toString("base64") } });
r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: {
  files: [{ stashId: staged.stashId }, { stashId: second.stashId }],
  selector: "input[multiple]",
}});
assert.equal(sent[0].params.filePaths.length, 2);

// 4. source-conflict
r = await handleToolCall(bridge, { name: "browser_upload_file", arguments: { stashId: "u_x", base64: "abc" }});
const parsed = JSON.parse(r.content[0].text);
assert.equal(parsed.ok, false);
assert.equal(parsed.error.code, "source-conflict");

console.log("✓ upload_file wire contract");
await fs.rm(tmp, { recursive: true, force: true });

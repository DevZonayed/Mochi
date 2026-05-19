// _upload_e2e.mjs — end-to-end upload test against a real Chrome via the broker.
// Requires the Mochi extension loaded and a running Chrome instance.
//
// Skip cleanly if the extension is not connected — same convention as existing _integration.mjs.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { startFixtureServer } from "./_fixtures/upload/server.mjs";
import { Bridge } from "./src/bridge.js";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { initUploads } from "./src/uploads.js";

const PNG = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13,
  0x49,0x48,0x44,0x52, 0,0,0,1, 0,0,0,1, 8,2, 0,0,0,
  0x90,0x77,0x53,0xde, 0,0,0,12, 0x49,0x44,0x41,0x54,
  0x08,0xd7,0x63,0x00,0x01,0x00,0x00,0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,
  0,0,0,0, 0x49,0x45,0x4e,0x44, 0xae,0x42,0x60,0x82,
]);

const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-e2e-"));
process.env.MOCHI_PROJECT_DIR = tmpProject;
await initUploads();
initToolsState({ log: () => {} });

const fix = await startFixtureServer();
console.log("fixture server:", fix.port);

const bridge = new Bridge({ log: () => {} });
const role = await bridge.start({ port: 9009 });
console.log("bridge role:", role);

if (!bridge.isConnected()) {
  console.log("SKIP e2e: extension not connected");
  await fix.close();
  await bridge.close?.();
  process.exit(0);
}

// 1. Stage the test PNG
const staged = JSON.parse((await handleToolCall(bridge, {
  name: "browser_upload_stage",
  arguments: { source: { base64: PNG.toString("base64") }, name: "1x1.png" },
})).content[0].text);
assert.equal(staged.ok, true);

// 2. For each fixture page, navigate + upload + assert preview
const pages = [
  { url: `http://127.0.0.1:${fix.port}/pages/01-direct.html`,    target: { selector: "input[type=file]" }, strategies: ["direct"] },
  { url: `http://127.0.0.1:${fix.port}/pages/02-intercept.html`, target: { trigger: { selector: "#trigger" } }, strategies: ["intercept"] },
  { url: `http://127.0.0.1:${fix.port}/pages/03-drop.html`,      target: { selector: "#zone" }, strategies: ["drop"] },
  { url: `http://127.0.0.1:${fix.port}/pages/04-paste.html`,     target: { selector: "#composer" }, strategies: ["paste"] },
  { url: `http://127.0.0.1:${fix.port}/pages/05-iframe.html`,    target: { selector: "input[type=file]" }, strategies: ["direct"], frames: "all" },
];

await bridge.send("session_start", { groupBy: "client" });
for (const p of pages) {
  console.log("→", p.url, "strategies:", p.strategies.join(","));
  await bridge.send("navigate", { url: p.url });
  await new Promise((r) => setTimeout(r, 500));

  const upArgs = { stashId: staged.stashId, ...p.target, strategies: p.strategies, frames: p.frames };
  const upRaw = await handleToolCall(bridge, { name: "browser_upload_file", arguments: upArgs });
  const up = JSON.parse(upRaw.content[0].text);
  assert.equal(up.ok, true, `upload failed on ${p.url}: ${JSON.stringify(up.error || up)}`);
  console.log("  strategy:", up.strategy, "waitedFor:", up.waitedFor?.signal);
}

assert.ok(fix.received.length >= 5, `expected ≥5 uploads received, got ${fix.received.length}`);
console.log("✓ e2e upload — all five fixtures uploaded");

await bridge.send("session_end", {}).catch(() => {});
await fix.close();
await bridge.close?.();
await fs.rm(tmpProject, { recursive: true, force: true });

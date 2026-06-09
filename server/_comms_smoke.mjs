import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "src", "comms", "index.js");

const WANT = [
  "comms_link_account","comms_account_status","comms_unlink_account",
  "comms_list_chats","comms_list_groups","comms_set_allowlist",
  "comms_get_messages","comms_recall","comms_import_history","comms_sync_now",
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "comms-smoke-"));
const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, COMMS_PROJECT_DIR: tmp }, // empty project -> no eager reconnect work
});

let buf = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 8000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const init = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.ok(init.result, "initialize must return a result");
  assert.equal(init.result.serverInfo.name, "comms");

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc(2, "tools/list", {});
  const names = (list.result.tools || []).map((t) => t.name);
  for (const w of WANT) assert.ok(names.includes(w), `tools/list missing ${w}`);
  for (const t of list.result.tools) assert.ok(t.inputSchema.properties.project_dir, `${t.name} missing project_dir`);

  console.log("✓ comms stdio boot smoke (initialize + tools/list)", names.length, "tools");
} finally {
  child.kill("SIGTERM");
  await fs.rm(tmp, { recursive: true, force: true });
}

// server/_comms_bundle_smoke.test.mjs
// GATING (spec §12): comms.bundle.mjs builds, boots under bare node, lists tools over stdio;
// the shipped artifact is native-free (no inlined sharp.node / @img/sharp loader);
// baileys own package is pure-JS (no *.node, no native install scripts).
//
// NOTE on native-addon coverage: the bare-node boot test (steps b/c) is the primary runtime
// guarantee — it runs the bundle from a genuinely bare tmp dir (no node_modules in any parent
// of os.tmpdir()), so a successful initialize+tools/list proves the bundle needs no native
// addon at boot time. Step (d) additionally scans the actual shipped artifact
// (dist/comms.bundle.mjs) and asserts it contains zero sharp.node / @img/sharp references and
// no executed native `.node` require — sharp and jimp are marked esbuild externals in
// build:comms, so their native-binding loaders are no longer inlined. Baileys' only references
// to them survive as bare dynamic `import("sharp")` / `import("jimp")` strings wrapped in
// `.catch(()=>{})`, which resolve to nothing at runtime (v1 is media-metadata-only and never
// thumbnails). Step (e) scans baileys' own package files (~362 files under
// @whiskeysockets/baileys) for prebuilt addons / native install scripts; baileys' transitive
// deps are flat-hoisted to the top-level server/node_modules and are not walked there.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = __dirname;
const bundlePath = path.join(serverDir, "dist", "comms.bundle.mjs");

// ── (a) build the comms bundle ──────────────────────────────────────────────
{
  const r = spawnSync("npm", ["run", "build:comms"], { cwd: serverDir, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout || "", r.stderr || "");
    assert.fail("npm run build:comms must succeed");
  }
  assert.ok(fs.existsSync(bundlePath), "comms.bundle.mjs must exist after build");
  const sizeMB = fs.statSync(bundlePath).size / (1024 * 1024);
  assert.ok(sizeMB > 0.5, `bundle should be a real multi-module bundle (got ${sizeMB.toFixed(2)}MB)`);
}

// ── (b)+(c) boot under bare node (cwd=tmp so no node_modules resolves) and
//            drive JSON-RPC initialize + tools/list over stdio ───────────────
const EXPECTED_TOOLS = [
  "comms_link_account",
  "comms_account_status",
  "comms_unlink_account",
  "comms_list_chats",
  "comms_list_groups",
  "comms_set_allowlist",
  "comms_get_messages",
  "comms_recall",
  "comms_import_history",
  "comms_sync_now",
];

async function listToolsOverStdio() {
  const bareCwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "comms-smoke-"));
  const child = spawn(process.execPath, [bundlePath], {
    cwd: bareCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COMMS_PROJECT_DIR: bareCwd },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for tools/list; stderr:\n" + stderr));
    }, 20000);

    child.on("error", (e) => { clearTimeout(timer); reject(e); });

    const tryParse = () => {
      // parse newline-delimited JSON-RPC frames
      const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(msg.result.tools.map((t) => t.name));
          return true;
        }
      }
      return false;
    };

    child.stdout.on("data", () => { tryParse(); });

    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });

  await fs.promises.rm(bareCwd, { recursive: true, force: true });
  return result;
}

{
  const names = await listToolsOverStdio();
  for (const t of EXPECTED_TOOLS) {
    assert.ok(names.includes(t), `comms tool ${t} must be listed over stdio (got: ${names.join(", ")})`);
  }
}

// ── (d) the shipped artifact itself must be native-free ──────────────────────
// sharp/jimp are esbuild externals, so the bundle must NOT inline sharp's native-binding
// loader (no sharp.node / @img/sharp), and must contain no executed native `.node` require.
// Bare dynamic `import("sharp")` / `import("jimp")` strings may remain — they resolve to
// nothing at runtime and baileys catches the rejection.
{
  const src = fs.readFileSync(bundlePath, "utf8");

  const sharpNodeRefs = (src.match(/sharp\.node|@img\/sharp/g) || []).length;
  assert.equal(
    sharpNodeRefs,
    0,
    `shipped bundle must not reference sharp.node / @img/sharp (sharp must be an esbuild external); found ${sharpNodeRefs}`
  );

  // No native addon load: any string literal ending in `.node` that is required/imported.
  const nativeDotNodeRefs = (src.match(/['"][^'"]*\.node['"]/g) || []);
  assert.equal(
    nativeDotNodeRefs.length,
    0,
    `shipped bundle must contain no executed native .node require; found:\n${nativeDotNodeRefs.join("\n")}`
  );
}

// ── (e) pure-JS assertion for baileys' own package (NOT its hoisted transitive deps) ──────
// Scope: this scan covers only the files directly under @whiskeysockets/baileys (~362 files).
// Baileys' transitive deps are flat-hoisted to server/node_modules and are not walked here.
// The authoritative "no native addon needed at runtime" guarantee is the bare-node boot test
// above (steps b/c), reinforced by the shipped-artifact scan (step d) — see the file header.
{
  const baileysDir = path.join(serverDir, "node_modules", "@whiskeysockets", "baileys");
  assert.ok(fs.existsSync(baileysDir), "baileys must be installed for the pure-JS scan");

  // version pin
  const bpkg = JSON.parse(fs.readFileSync(path.join(baileysDir, "package.json"), "utf8"));
  assert.equal(bpkg.version, "6.7.23", "baileys must be pinned to 6.7.23");

  // no prebuilt native addons in baileys' own package files
  const nodeAddons = [];
  const nativeInstallScriptPkgs = [];
  // These keywords indicate native-compilation install scripts (node-gyp, binding.gyp, etc.).
  // Pure-JS engine-version checks (e.g. baileys' own engine-requirements.js) are not native.
  const NATIVE_KEYWORDS = ["node-gyp", "node-pre-gyp", "gyp", "prebuild", "binding", "addon"];
  const isNativeScript = (s) => s && NATIVE_KEYWORDS.some((kw) => s.includes(kw));
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".node")) nodeAddons.push(full);
        if (ent.name === "package.json") {
          try {
            const p = JSON.parse(fs.readFileSync(full, "utf8"));
            const s = p.scripts || {};
            // Only flag scripts that reference native-compilation tooling (gyp etc).
            // Pure-JS version checks (e.g. baileys' preinstall: "node ./engine-requirements.js")
            // are fine — they don't compile native code.
            if (isNativeScript(s.install) || isNativeScript(s.preinstall) || isNativeScript(s.postinstall)) {
              nativeInstallScriptPkgs.push(`${p.name || ent.name}: ${JSON.stringify({ install: s.install, preinstall: s.preinstall, postinstall: s.postinstall })}`);
            }
          } catch { /* ignore unparseable */ }
        }
      }
    }
  };
  walk(baileysDir);

  assert.equal(nodeAddons.length, 0, `baileys own package must contain no *.node addons; found:\n${nodeAddons.join("\n")}`);
  assert.equal(nativeInstallScriptPkgs.length, 0, `baileys own package must have no native-compilation install scripts; found:\n${nativeInstallScriptPkgs.join("\n")}`);
}

console.log("✓ comms bundle smoke: builds, boots under bare node, lists tools, shipped artifact native-free (no sharp.node), baileys pure-JS (spec §12)");

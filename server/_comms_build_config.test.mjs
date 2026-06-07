// server/_comms_build_config.test.mjs
// Dependency-free assertion that the comms build target + deps are wired exactly per spec §9.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const EXISTING_BROWSER =
  'esbuild src/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/server.bundle.mjs --legal-comments=external --banner:js="import{createRequire as ___cr}from\'node:module\';const require=___cr(import.meta.url);"';

const EXPECTED_COMMS =
  'esbuild src/comms/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/comms.bundle.mjs --legal-comments=external --log-override:indirect-require=silent --banner:js="import{createRequire as ___cr}from\'node:module\';const require=___cr(import.meta.url);"';

// 1) build orchestrates both targets, in order
assert.equal(pkg.scripts.build, "npm run build:browser && npm run build:comms", "build must run browser then comms");

// 2) build:browser is the existing browser command, verbatim
assert.equal(pkg.scripts["build:browser"], EXISTING_BROWSER, "build:browser must be the existing browser esbuild command verbatim");

// 3) build:comms is the new comms target with exact flags from §9.2
assert.equal(pkg.scripts["build:comms"], EXPECTED_COMMS, "build:comms must match spec §9.2 exactly");

// 4) deps present + pinned
assert.equal(pkg.dependencies["@whiskeysockets/baileys"], "6.7.23", "baileys must be pinned to 6.7.23");
assert.ok(typeof pkg.dependencies["qrcode"] === "string" && pkg.dependencies["qrcode"].length > 0, "qrcode dep must be present");

// 5) explicitly-forbidden deps absent (§9.1)
for (const banned of ["pino", "jimp", "sharp"]) {
  assert.ok(!("dependencies" in pkg) || !(banned in pkg.dependencies), `${banned} must NOT be a dependency`);
  assert.ok(!("devDependencies" in pkg) || !(banned in (pkg.devDependencies || {})), `${banned} must NOT be a devDependency`);
}

console.log("✓ comms build config (scripts + deps) matches spec §9");

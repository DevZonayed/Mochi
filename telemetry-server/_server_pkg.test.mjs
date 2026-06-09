import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

test("package is ESM and dependency-free (built-in http/crypto only)", () => {
  assert.equal(pkg.type, "module", "must be type:module");
  assert.ok(pkg.private === true, "must be private");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "no runtime deps — built-in http/crypto only");
});

test("test script runs colocated *.test.mjs via node --test", () => {
  assert.ok(/node --test/.test(pkg.scripts.test), "test script must use node --test");
});

test("start script launches the server", () => {
  assert.equal(pkg.scripts.start, "node server.mjs", "start must run server.mjs");
});

test("engines require node >=22", () => {
  assert.ok(/>=\s*22/.test(pkg.engines.node), "must require node >=22");
});

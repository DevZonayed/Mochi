import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { resolveRef, resolveInputs, scrubTrace, validatePlaybook, listAvailableSecrets, initSecrets, secretsDir } from "./src/secrets.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-secrets-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initSecrets();
assert.equal(secretsDir(), path.join(tmp, ".continuum", "secrets"));
const stat = await fs.stat(secretsDir());
assert.ok(stat.isDirectory());
// auto .gitignore
const gi = await fs.readFile(path.join(secretsDir(), ".gitignore"), "utf8");
assert.ok(gi.includes("*"));

// env var resolution
process.env.MOCHI_TEST_PW = "supersecret";
assert.equal(resolveRef("${env:MOCHI_TEST_PW}"), "supersecret");
assert.equal(resolveRef("${MOCHI_TEST_PW}"), "supersecret");

// bare lowercase NOT shorthand env (must be ${env:foo})
assert.equal(resolveRef("${mochi_test_pw}"), null);

// file resolution
await fs.writeFile(path.join(secretsDir(), "api-key.txt"), "tok_abc\n", { mode: 0o600 });
assert.equal(resolveRef("${secret:api-key}"), "tok_abc");

// missing file → null
assert.equal(resolveRef("${secret:missing}"), null);

// syntax errors
assert.throws(() => resolveRef("${env}"),                        /secret-ref-syntax/);
assert.throws(() => resolveRef("prefix${env:X}suffix"),          /secret-ref-syntax/);
assert.throws(() => resolveRef("${env:X}${env:Y}"),              /secret-ref-syntax/);

// resolveInputs
const pb = { meta: { inputs: [
  { name: "user",     type: "text",   required: true,  ref: null },
  { name: "password", type: "secret", required: true,  ref: "${env:MOCHI_TEST_PW}" },
  { name: "api_key",  type: "secret", required: true,  ref: "${secret:api-key}" },
  { name: "missing",  type: "secret", required: false, ref: "${env:NOT_SET}" },
] } };
const r = resolveInputs(pb, { user: "alice" });
assert.equal(r.resolved.user, "alice");
assert.equal(r.resolved.password, "supersecret");
assert.equal(r.resolved.api_key, "tok_abc");
assert.equal(r.resolved.missing, null);
assert.equal(r.missing.length, 0); // optional missing doesn't count

// validatePlaybook detects unavailable required secret
delete process.env.MOCHI_TEST_PW;
const v = validatePlaybook(pb);
assert.equal(v.ok, false);
assert.ok(v.missing.find((m) => m.name === "password"));

// scrubTrace
const trace = [
  { tool: "browser_type", args: { intent: "password-field", value: "supersecret" } },
  { tool: "browser_type", args: { intent: "name-field",     value: "alice" } },
];
const scrubbed = scrubTrace(trace, { password: "supersecret" });
assert.equal(scrubbed[0].args.value, "[REDACTED:password]");
assert.equal(scrubbed[1].args.value, "alice");

// listAvailableSecrets
process.env.GMAIL_PASSWORD = "x";
const list = await listAvailableSecrets();
assert.ok(list.some((s) => s.name === "GMAIL_PASSWORD" && s.source === "env"));
assert.ok(list.some((s) => s.name === "api-key" && s.source === "file"));
delete process.env.GMAIL_PASSWORD;

console.log("✓ secrets tests");
await fs.rm(tmp, { recursive: true, force: true });

import { resolveRef as _resolveRef, __setExecForTesting, __clearExecForTesting, listAvailableSecrets as listAvail2 } from "./src/secrets.js";

// 1Password integration tests
{
  // op installed and successful
  __setExecForTesting((cmd) => {
    if (cmd.startsWith('op read "op://Personal/Gmail/password"')) return "supersecret\n";
    if (cmd.startsWith('op read "op://Work/AWS/access_key_id"')) return "AKIA…\n";
    if (cmd.startsWith('op read')) { const e = new Error("not found"); e.status = 1; throw e; }
    if (cmd.includes("--version")) return "2.0.0\n";
    throw new Error("unknown cmd: " + cmd);
  });
  assert.equal(_resolveRef("${1password:Personal/Gmail/password}"), "supersecret");
  assert.equal(_resolveRef("${op:Work/AWS/access_key_id}"), "AKIA…");
  assert.equal(_resolveRef("${op:Personal/Nonexistent/password}"), null);

  // op not installed
  __setExecForTesting((cmd) => {
    if (cmd.includes("--version")) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
    throw new Error("op missing");
  });
  assert.equal(_resolveRef("${1password:any/thing/here}"), null);

  __clearExecForTesting();
  console.log("✓ 1Password ref resolution");
}

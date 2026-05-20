import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { seedFromCodebase, detectFramework } from "./src/codebase-seed.js";
import { initPlaybooks, getPlaybook } from "./src/playbooks.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-seed-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();

const fixturePath = path.join(__dirname, "_fixtures", "codebase", "next-app");

// detector
const fw = await detectFramework(fixturePath);
assert.equal(fw.kind, "next-app-router");

// dry run
const dry = await seedFromCodebase({ projectRoot: fixturePath, domain: "app.localhost:3000", dryRun: true });
assert.equal(dry.framework, "next-app-router");
assert.ok(dry.drafts.length >= 2);
assert.equal(dry.written, 0);
const login = dry.drafts.find((d) => d.id === "app.localhost:3000/login");
assert.ok(login);
assert.ok(login.inputs >= 2);
const settings = dry.drafts.find((d) => d.id === "app.localhost:3000/dashboard-settings");
assert.ok(settings);

// real run
const real = await seedFromCodebase({ projectRoot: fixturePath, domain: "app.localhost:3000" });
assert.equal(real.written, real.drafts.length);

// password auto-typed as secret
const pb = await getPlaybook("app.localhost:3000/login");
assert.ok(pb);
const pwInput = pb.meta.inputs.find((i) => i.name === "password");
assert.ok(pwInput);
assert.equal(pwInput.type, "secret");
const emailInput = pb.meta.inputs.find((i) => i.name === "email");
assert.equal(emailInput.type, "email");

// playbook_version: 0 marker
assert.equal(pb.meta.playbook_version, 0);
assert.equal(pb.meta.verifiable, false);

// re-seed: idempotent for drafts
const real2 = await seedFromCodebase({ projectRoot: fixturePath, domain: "app.localhost:3000" });
assert.equal(real2.written, real2.drafts.length); // updates drafts in place

// non-overwrite of non-draft playbook: manually bump version on login → re-seed should skip
const fsp = await import("node:fs/promises");
const loginPath = path.join(tmp, ".continuum", "playbooks", "app.localhost:3000", "login.md");
let md = await fsp.readFile(loginPath, "utf8");
md = md.replace("playbook_version: 0", "playbook_version: 1");
await fsp.writeFile(loginPath, md);
const real3 = await seedFromCodebase({ projectRoot: fixturePath, domain: "app.localhost:3000" });
assert.ok(real3.warnings.some((w) => w.includes("login")));
assert.ok(real3.skipped >= 1);

console.log("✓ codebase-seed tests");
await fs.rm(tmp, { recursive: true, force: true });

# Playbooks v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v2 spec — 1Password CLI integration, Vue + SvelteKit codebase detection, blocked-verdict UX for missing inputs, cross-project bundle export/import, and a self-contained HTML dashboard. Tool count rises 51 → 54.

**Architecture:** Two new pure-function modules (`playbook-bundles.js`, `playbook-dashboard.js`) plus targeted extensions to `secrets.js` (1Password resolver), `codebase-seed.js` (Vue/Svelte detectors), and `playbooks.js` (refactor `resolveRunInputs` to return missing instead of throw). Three new MCP tools surface them; `browser_playbook_run` returns `verdict: "blocked"` cleanly when inputs are unresolvable. No new deps.

**Tech Stack:** Node 22 ESM, existing `js-yaml`/`pngjs`/`pixelmatch`/`@babel/parser`. New: 1Password `op` CLI shelled out via `child_process.execSync` (no library), Vue/Svelte template parsing via regex + a tiny built-in HTML tokenizer.

**Spec:** `docs/superpowers/specs/2026-05-20-playbooks-v2-design.md`

---

## File Structure

**New files (server):**
- `server/src/playbook-bundles.js` — export/import bundle handling. ~180 lines.
- `server/src/playbook-dashboard.js` — HTML dashboard generator. ~250 lines.
- `server/_playbook_bundles.test.mjs` — unit tests. ~150 lines.
- `server/_playbook_dashboard.test.mjs` — unit tests. ~100 lines.
- `server/_fixtures/codebase/nuxt-app/nuxt.config.ts`
- `server/_fixtures/codebase/nuxt-app/pages/login.vue`
- `server/_fixtures/codebase/svelte-app/svelte.config.js`
- `server/_fixtures/codebase/svelte-app/package.json` (for detector trigger)
- `server/_fixtures/codebase/svelte-app/src/routes/login/+page.svelte`

**Modified files:**
- `server/src/secrets.js` — add `${1password:...}` / `${op:...}` resolution.
- `server/src/codebase-seed.js` — add Nuxt + SvelteKit detectors.
- `server/src/playbooks.js` — refactor `resolveRunInputs` to return `{missing}` instead of throwing.
- `server/src/tools.js` — register `browser_playbook_export`/`_import`/`_dashboard`; return `blocked` verdict cleanly; needs annotator.
- `server/_secrets.test.mjs` — extend with 1Password tests (stubbed `op`).
- `server/_codebase_seed.test.mjs` — extend with Vue + Svelte fixtures.
- `server/_playbook_wire.test.mjs` — wire tests for the 3 new tools + blocked verdict.
- `server/_smoke.mjs` — expect 54 tools; add 3 new names.
- `server/_integration.mjs` — bump 51 → 54.
- `plugins/qa/CLAUDE.md` — add "Handling blocked verdicts" section.
- `plugins/qa/commands/playbook.md` — add `export`, `import`, `ui` verbs.
- `README.md` — bump tool count 51 → 54; add v2 paragraph.
- `server/dist/server.bundle.mjs` — rebuilt via `npm run build`.

---

## Task 1: 1Password ref extension in `secrets.js`

**Files:**
- Modify: `server/src/secrets.js`
- Modify: `server/_secrets.test.mjs`

- [ ] **Step 1: Append the failing test**

Append to `server/_secrets.test.mjs`:
```js
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
```

- [ ] **Step 2: Run failing test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _secrets.test.mjs
```
Expected: error about `__setExecForTesting is not a function`.

- [ ] **Step 3: Extend `secrets.js`**

In `server/src/secrets.js`, add at the top of the file (after existing imports):
```js
import { execSync as _execSync } from "node:child_process";

let _execForTesting = null;
export function __setExecForTesting(fn)   { _execForTesting = fn; }
export function __clearExecForTesting()   { _execForTesting = null; }
function exec(cmd, opts) {
  if (_execForTesting) return _execForTesting(cmd, opts);
  return _execSync(cmd, opts);
}

let _opAvailableCache = { checkedAt: 0, available: false };
function opAvailable() {
  const now = Date.now();
  if (now - _opAvailableCache.checkedAt < 60_000) return _opAvailableCache.available;
  try {
    exec("op --version", { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
    _opAvailableCache = { checkedAt: now, available: true };
  } catch {
    _opAvailableCache = { checkedAt: now, available: false };
  }
  return _opAvailableCache.available;
}

function resolveOpRef(refPath) {
  if (!opAvailable()) return null;
  try {
    const out = exec(`op read "op://${refPath}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return String(out).replace(/\r?\n$/, "");
  } catch { return null; }
}
```

Then in `resolveRef`, locate the existing `if (kind === "env")` branch and add **before** the closing `throw` for "unknown kind":
```js
  if (kind === "1password" || kind === "op") {
    return resolveOpRef(name);
  }
```

Also extend `listAvailableSecrets` to include a `source: "1password"` entry when `op` is available:
```js
  if (opAvailable()) {
    out.push({ name: "<1password>", source: "1password" });
  }
```
(Append this right before `return out;`.)

- [ ] **Step 4: Run test to pass**

```bash
node _secrets.test.mjs
```
Expected: `✓ 1Password ref resolution` plus all prior ✓ lines.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/secrets.js server/_secrets.test.mjs && git commit -m "feat(secrets): 1Password CLI ref resolution via \`op read\`"
```

---

## Task 2: Vue / Nuxt codebase detector

**Files:**
- Modify: `server/src/codebase-seed.js`
- Modify: `server/_codebase_seed.test.mjs`
- Create: `server/_fixtures/codebase/nuxt-app/nuxt.config.ts`
- Create: `server/_fixtures/codebase/nuxt-app/pages/login.vue`

- [ ] **Step 1: Create the Nuxt fixture**

Create `server/_fixtures/codebase/nuxt-app/nuxt.config.ts`:
```ts
export default {};
```

Create `server/_fixtures/codebase/nuxt-app/pages/login.vue`:
```vue
<template>
  <form data-testid="login-form" @submit.prevent>
    <input type="email" name="email" data-testid="email-field" v-model="email" aria-label="Email" />
    <input type="password" name="password" data-testid="password-field" v-model="password" aria-label="Password" />
    <button type="submit" data-testid="submit-button">Sign in</button>
  </form>
</template>

<script setup>
import { ref } from "vue";
const email = ref("");
const password = ref("");
</script>
```

- [ ] **Step 2: Append failing test**

Append to `server/_codebase_seed.test.mjs`:
```js
{
  const fixtureRoot = path.join(__dirname, "_fixtures", "codebase", "nuxt-app");
  const fw = await detectFramework(fixtureRoot);
  assert.equal(fw.kind, "nuxt");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-seed-vue-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const r = await seedFromCodebase({ projectRoot: fixtureRoot, domain: "nuxt.example.com" });
  assert.equal(r.framework, "nuxt");
  assert.ok(r.drafts.length >= 1);
  const login = r.drafts.find((d) => d.id === "nuxt.example.com/login");
  assert.ok(login, "expected nuxt.example.com/login draft");

  const pb = await getPlaybook("nuxt.example.com/login");
  assert.ok(pb);
  const pwd = pb.meta.inputs.find((i) => i.name === "password");
  assert.ok(pwd);
  assert.equal(pwd.type, "secret");
  const email = pb.meta.inputs.find((i) => i.name === "email");
  assert.equal(email.type, "email");

  console.log("✓ Nuxt detector");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run failing test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _codebase_seed.test.mjs
```
Expected: `expected nuxt.example.com/login draft` failure (detector not implemented).

- [ ] **Step 4: Implement Nuxt detection + Vue parser**

In `server/src/codebase-seed.js`, modify `detectFramework`:
```js
export async function detectFramework(root) {
  const has = async (p) => { try { await fs.access(path.join(root, p)); return true; } catch { return false; } };
  // Nuxt: check before Next.js (some projects have both? unlikely, but be specific).
  const hasNuxtConfig = (await has("nuxt.config.js")) || (await has("nuxt.config.mjs")) || (await has("nuxt.config.ts"));
  if (hasNuxtConfig) return { kind: "nuxt", pagesDir: "pages" };
  // SvelteKit
  const hasSvelteConfig = (await has("svelte.config.js")) || (await has("svelte.config.mjs")) || (await has("svelte.config.ts"));
  if (hasSvelteConfig) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (pkg.devDependencies?.["@sveltejs/kit"] || pkg.dependencies?.["@sveltejs/kit"]) return { kind: "sveltekit", routesDir: "src/routes" };
    } catch {}
  }
  // Next.js
  const hasNextConfig = (await has("next.config.js")) || (await has("next.config.mjs")) || (await has("next.config.ts"));
  if (hasNextConfig) {
    if (await has("app")) return { kind: "next-app-router", appDir: "app" };
    if (await has("pages")) return { kind: "next-pages-router", pagesDir: "pages" };
  }
  if ((await has("vite.config.js")) || (await has("vite.config.ts"))) return { kind: "vite-react", srcDir: "src" };
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.dependencies?.["react-scripts"]) return { kind: "cra", srcDir: "src" };
  } catch {}
  return { kind: "none" };
}
```

In `seedFromCodebase`, add dispatch for the new detector:
```js
  if (fw.kind === "nuxt") drafts.push(...await scanNuxtPages(root, fw.pagesDir, domain));
  if (fw.kind === "sveltekit") drafts.push(...await scanSvelteKit(root, fw.routesDir, domain));
```

Add the `scanNuxtPages` function:
```js
async function scanNuxtPages(root, pagesDir, domain) {
  const out = [];
  const base = path.join(root, pagesDir);
  async function walk(dir, route = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const seg = e.name.startsWith("[") ? "" : e.name;
        await walk(p, route + (seg ? "/" + seg : ""));
        continue;
      }
      if (e.isFile() && e.name.endsWith(".vue")) {
        const seg = e.name.slice(0, -4);
        const sub = seg === "index" ? "" : "/" + seg;
        const draft = await buildDraftFromVueOrSvelte(p, (route || "") + sub || "/", domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}
```

Add the Vue/Svelte template parser + draft builder at the bottom of the file:
```js
async function buildDraftFromVueOrSvelte(filePath, route, domain) {
  let source;
  try { source = await fs.readFile(filePath, "utf8"); }
  catch { return null; }

  // Extract template block: Vue (<template>) or Svelte (whole top-level HTML)
  let templateHtml;
  const m = /<template[^>]*>([\s\S]*?)<\/template>/.exec(source);
  if (m) templateHtml = m[1];
  else {
    // Svelte: strip out <script> and <style> blocks; the rest is the template
    templateHtml = source.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  }
  if (!templateHtml) return null;

  const tokens = tokenizeHtml(templateHtml);
  const fields = [];
  let hasForm = false;
  let submitButton = null;
  for (const tok of tokens) {
    if (tok.tag === "form") hasForm = true;
    if (tok.tag === "input" || tok.tag === "textarea" || tok.tag === "select") {
      fields.push(htmlAttrsToField(tok));
    }
    if (tok.tag === "button") {
      const type = tok.attrs.type;
      if (type === "submit" || !submitButton) submitButton = htmlAttrsToField(tok);
    }
  }
  if (!hasForm && !fields.length) return null;

  const feature = slugFromRoute(route);
  const id = `${domain}/${feature}`;
  const inputs = uniqueInputs(fields.map(fieldToInput));
  const steps = stepsFromFields(route, fields, submitButton);

  const meta = {
    origin: domain, feature, title: `${humanize(feature)} (draft)`, verifiable: false,
    preconditions: [], inputs, outputs: [], composes: [], next: null, cron: null,
    last_verified: null, success_count: 0, playbook_version: 0, schema_version: 1, tags: ["draft", "seeded"],
  };
  const body = freshBody({ route, source: filePath, fields, submitButton, steps });
  return {
    id, source: path.relative(process.env.MOCHI_PROJECT_DIR || process.cwd(), filePath),
    meta, body, workflow: { playbookId: id, schemaVersion: 1, steps },
  };
}

// Minimal HTML tokenizer — extracts opening tags + attributes only.
function tokenizeHtml(src) {
  const tokens = [];
  const re = /<(\w+)([^>]*)>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const attrsRaw = m[2];
    const attrs = {};
    const attrRe = /([\w@:.-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\{[^}]*\})|([^\s>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrsRaw))) {
      const name = am[1];
      const value = am[2] ?? am[3] ?? am[4] ?? am[5] ?? "";
      attrs[name.toLowerCase()] = value;
    }
    tokens.push({ tag, attrs });
  }
  return tokens;
}

function htmlAttrsToField(tok) {
  // Map Vue/Svelte bindings to React-equivalent shape.
  const a = tok.attrs;
  const fieldName =
    a.name ||
    (a["v-model"]?.replace(/[{}]/g, "")) ||
    (a["bind:value"]?.replace(/[{}]/g, "")) ||
    a.id ||
    null;
  return {
    tag: tok.tag,
    type: a.type ?? null,
    name: fieldName,
    id:   a.id ?? null,
    aria: a["aria-label"] ?? null,
    testid: a["data-testid"] ?? null,
    placeholder: a.placeholder ?? null,
    accept: a.accept ?? null,
  };
}
```

Note: `slugFromRoute`, `fieldToInput`, `uniqueInputs`, `stepsFromFields`, `humanize`, `freshBody`, `describeStep`, `camelOrSnake` already exist from v1.5; they're shared.

- [ ] **Step 5: Run test to pass**

```bash
node _codebase_seed.test.mjs
```
Expected: `✓ Nuxt detector` plus prior ✓ lines.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/codebase-seed.js server/_codebase_seed.test.mjs server/_fixtures/codebase/nuxt-app/ && git commit -m "feat(codebase-seed): Nuxt + Vue template detector"
```

---

## Task 3: SvelteKit codebase detector

**Files:**
- Modify: `server/src/codebase-seed.js`
- Modify: `server/_codebase_seed.test.mjs`
- Create: `server/_fixtures/codebase/svelte-app/svelte.config.js`
- Create: `server/_fixtures/codebase/svelte-app/package.json`
- Create: `server/_fixtures/codebase/svelte-app/src/routes/login/+page.svelte`

- [ ] **Step 1: Create the SvelteKit fixture**

Create `server/_fixtures/codebase/svelte-app/svelte.config.js`:
```js
export default {};
```

Create `server/_fixtures/codebase/svelte-app/package.json`:
```json
{
  "name": "fixture-svelte-app",
  "version": "0.0.0",
  "devDependencies": { "@sveltejs/kit": "^2.0.0" }
}
```

Create `server/_fixtures/codebase/svelte-app/src/routes/login/+page.svelte`:
```svelte
<script>
  let email = "";
  let password = "";
</script>

<form data-testid="login-form" on:submit|preventDefault>
  <input type="email" name="email" data-testid="email-field" bind:value={email} aria-label="Email" />
  <input type="password" name="password" data-testid="password-field" bind:value={password} aria-label="Password" />
  <button type="submit" data-testid="submit-button">Sign in</button>
</form>
```

- [ ] **Step 2: Append failing test**

Append to `server/_codebase_seed.test.mjs`:
```js
{
  const fixtureRoot = path.join(__dirname, "_fixtures", "codebase", "svelte-app");
  const fw = await detectFramework(fixtureRoot);
  assert.equal(fw.kind, "sveltekit");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-seed-svelte-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const r = await seedFromCodebase({ projectRoot: fixtureRoot, domain: "svelte.example.com" });
  assert.equal(r.framework, "sveltekit");
  assert.ok(r.drafts.length >= 1);
  const login = r.drafts.find((d) => d.id === "svelte.example.com/login");
  assert.ok(login, "expected svelte.example.com/login draft");

  const pb = await getPlaybook("svelte.example.com/login");
  assert.ok(pb);
  const pwd = pb.meta.inputs.find((i) => i.name === "password");
  assert.equal(pwd.type, "secret");
  console.log("✓ SvelteKit detector");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run failing test**

```bash
node _codebase_seed.test.mjs
```
Expected: assertion failure on `expected svelte.example.com/login draft`.

- [ ] **Step 4: Implement `scanSvelteKit`**

In `server/src/codebase-seed.js`, add:
```js
async function scanSvelteKit(root, routesDir, domain) {
  const out = [];
  const base = path.join(root, routesDir);
  async function walk(dir, route = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith("(") || e.name.startsWith("_")) { await walk(p, route); continue; } // route groups
        const seg = e.name.startsWith("[") ? "" : e.name;
        await walk(p, route + (seg ? "/" + seg : ""));
        continue;
      }
      if (e.isFile() && e.name === "+page.svelte") {
        const draft = await buildDraftFromVueOrSvelte(p, route || "/", domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}
```

- [ ] **Step 5: Run test to pass**

```bash
node _codebase_seed.test.mjs
```
Expected: `✓ SvelteKit detector`.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/codebase-seed.js server/_codebase_seed.test.mjs server/_fixtures/codebase/svelte-app/ && git commit -m "feat(codebase-seed): SvelteKit detector with shared Vue/Svelte template parser"
```

---

## Task 4: Refactor `resolveRunInputs` to return missing instead of throw

**Files:**
- Modify: `server/src/playbooks.js`
- Modify: `server/_playbooks.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `server/_playbooks.test.mjs`:
```js
{
  // Refactored resolveRunInputs returns { playbook, resolved, missing, secretValues }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-resolve-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();
  const meta = {
    origin: "example.com", feature: "thing", title: "x", verifiable: true,
    preconditions: [],
    inputs: [
      { name: "user",     type: "text",   required: true,  ref: null },
      { name: "password", type: "secret", required: true,  ref: "${env:DEF_NOT_SET_VAR}" },
    ],
    outputs: [], composes: [], next: null, cron: null,
    last_verified: null, success_count: 0, playbook_version: 1, schema_version: 1,
  };
  const body = "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n";
  await savePlaybook({ id: "example.com/thing", meta, body, workflow: { steps: [] } });

  // No throw — returns missing[] for unresolved required inputs.
  const { resolveRunInputs } = await import("./src/playbooks.js");
  const r = await resolveRunInputs("example.com/thing", {});
  assert.ok(r.playbook);
  assert.ok(r.missing.length >= 2);
  const names = r.missing.map((m) => m.name);
  assert.ok(names.includes("user"));
  assert.ok(names.includes("password"));

  console.log("✓ resolveRunInputs returns missing");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbooks.test.mjs
```
Expected: assertion fails because `resolveRunInputs` currently throws on missing.

- [ ] **Step 3: Refactor `resolveRunInputs`**

In `server/src/playbooks.js`, replace the existing `resolveRunInputs` body. The new version does NOT throw on missing:

```js
export async function resolveRunInputs(playbookId, callerInputs) {
  const pb = await getPlaybook(playbookId);
  if (!pb) throw playbookErr("playbook-not-found", `no playbook ${playbookId}`);
  await secrets.initSecrets();
  const { resolved, missing } = secrets.resolveInputs(pb, callerInputs);
  return { playbook: pb, resolved, missing, secretValues: extractSecretValues(pb, resolved) };
}
```

(Remove the previous throw on `missing.length`.)

- [ ] **Step 4: Run test to pass**

```bash
node _playbooks.test.mjs
```
Expected: `✓ resolveRunInputs returns missing`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs && git commit -m "refactor(playbooks): resolveRunInputs returns missing[] instead of throwing"
```

---

## Task 5: `playbook-bundles.js` module + tests

**Files:**
- Create: `server/src/playbook-bundles.js`
- Create: `server/_playbook_bundles.test.mjs`
- Modify: `server/package.json` (extend test script)

- [ ] **Step 1: Write the failing test**

Create `server/_playbook_bundles.test.mjs`:
```js
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { initPlaybooks, savePlaybook, getPlaybook, listPlaybooks } from "./src/playbooks.js";
import { exportBundle, importBundle } from "./src/playbook-bundles.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-bundle-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const meta = {
    origin: "mail.google.com", feature: "send-email", title: "Send", verifiable: true,
    preconditions: [], inputs: [{ name: "to", type: "email", required: true }], outputs: [],
    composes: [], next: null, cron: null,
    last_verified: "2026-05-20T00:00:00Z", success_count: 3, playbook_version: 1, schema_version: 1,
  };
  const body = "## Summary\nSend.\n## Preconditions\nLogged-in.\n## Steps\nclick send\n## Verification\nToast.\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n";
  await savePlaybook({ id: "mail.google.com/send-email", meta, body, workflow: { steps: [{ action: "click", intent: "send-button" }] } });

  // Export
  const out = path.join(tmp, "bundle.json");
  const exp = await exportBundle({ outputPath: out });
  assert.equal(exp.ok, true);
  assert.equal(exp.playbookCount, 1);
  const bundleRaw = JSON.parse(await fs.readFile(out, "utf8"));
  assert.equal(bundleRaw.schema, "mochi-playbook-bundle@1");
  assert.equal(bundleRaw.playbooks.length, 1);
  assert.equal(bundleRaw.playbooks[0].id, "mail.google.com/send-email");
  assert.ok(bundleRaw.playbooks[0].markdown.includes("send-email"));

  // Import into fresh project
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-bundle2-"));
  process.env.MOCHI_PROJECT_DIR = tmp2;
  await initPlaybooks();
  const imp = await importBundle({ bundlePath: out });
  assert.equal(imp.ok, true);
  assert.equal(imp.imported.length, 1);
  const pb2 = await getPlaybook("mail.google.com/send-email");
  assert.ok(pb2);
  assert.equal(pb2.meta.success_count, 3);

  // Round-trip body byte-identical
  const orig = (await fs.readFile(path.join(tmp,  ".continuum/playbooks/mail.google.com/send-email.md"), "utf8"));
  const round = (await fs.readFile(path.join(tmp2, ".continuum/playbooks/mail.google.com/send-email.md"), "utf8"));
  assert.equal(round, orig);

  // overwrite=false skip
  const skipResult = await importBundle({ bundlePath: out });
  assert.equal(skipResult.imported.length, 0);
  assert.equal(skipResult.skipped.length, 1);
  assert.equal(skipResult.skipped[0].reason, "already-exists");

  // overwrite=true replaces
  const ovResult = await importBundle({ bundlePath: out, overwrite: true });
  assert.equal(ovResult.imported.length, 1);

  // rewriteOrigin
  const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-bundle3-"));
  process.env.MOCHI_PROJECT_DIR = tmp3;
  await initPlaybooks();
  const rwResult = await importBundle({ bundlePath: out, rewriteOrigin: "staging.example.com" });
  assert.equal(rwResult.ok, true);
  assert.equal(rwResult.imported[0], "staging.example.com/send-email");
  assert.equal(rwResult.rewrittenFrom, "mail.google.com");

  // Bad schema
  const bad = path.join(tmp, "bad.json");
  await fs.writeFile(bad, JSON.stringify({ schema: "something-else" }));
  await assert.rejects(importBundle({ bundlePath: bad }), /bundle-schema-mismatch/);

  console.log("✓ playbook bundles");
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(tmp2, { recursive: true, force: true });
  await fs.rm(tmp3, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbook_bundles.test.mjs
```
Expected: `Cannot find module './src/playbook-bundles.js'`.

- [ ] **Step 3: Implement the module**

Create `server/src/playbook-bundles.js`:
```js
// server/src/playbook-bundles.js
// Export/import per-feature playbooks as single-file JSON bundles.
import fs from "node:fs/promises";
import path from "node:path";
import { request as undiciRequest } from "undici";
import { playbooksDir, listPlaybooks, getPlaybook, savePlaybook, parsePlaybook } from "./playbooks.js";

const BUNDLE_SCHEMA = "mochi-playbook-bundle@1";
const VERSION = "0.4.0";

export async function exportBundle({ ids, origin, tag, outputPath, stripSecrets = true } = {}) {
  const entries = await listPlaybooks({ origin, tag });
  const subset = ids?.length ? entries.filter((e) => ids.includes(e.id)) : entries;
  const playbooks = [];
  for (const e of subset) {
    const pb = await getPlaybook(e.id);
    if (!pb) continue;
    let markdown = await fs.readFile(path.join(playbooksDir(), e.origin, `${e.feature}.md`), "utf8");
    if (stripSecrets) markdown = stripRefFromFrontmatter(markdown);
    const screenshots = await collectScreenshots(e.origin, e.feature);
    playbooks.push({
      id: e.id,
      markdown,
      workflow: pb.workflow || null,
      screenshots,
    });
  }
  const bundle = {
    schema: BUNDLE_SCHEMA,
    exportedAt: new Date().toISOString(),
    exportedBy: `mochi ${VERSION}`,
    manifest: playbooks.map((p) => ({
      id: p.id,
      version: parsePlaybook(p.markdown).meta.playbook_version,
      verifiable: !!parsePlaybook(p.markdown).meta.verifiable,
      tags: parsePlaybook(p.markdown).meta.tags || [],
    })),
    playbooks,
  };
  const finalPath = outputPath || path.join(playbooksDir(), "exports", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const json = JSON.stringify(bundle, null, 2);
  await fs.writeFile(finalPath, json);
  return { ok: true, bundlePath: finalPath, playbookCount: playbooks.length, sizeBytes: Buffer.byteLength(json) };
}

function stripRefFromFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return md;
  const frontmatter = m[1];
  const cleaned = frontmatter.split("\n").map((line) => line.replace(/^(\s+ref:).+$/, "$1 null")).join("\n");
  return md.replace(m[0], `---\n${cleaned}\n---\n`);
}

async function collectScreenshots(origin, feature) {
  const dir = path.join(playbooksDir(), origin, `${feature}.screenshots`);
  try {
    const files = await fs.readdir(dir);
    const out = {};
    for (const f of files) {
      if (!f.endsWith(".png")) continue;
      const buf = await fs.readFile(path.join(dir, f));
      out[f] = buf.toString("base64");
    }
    return out;
  } catch {
    return {};
  }
}

export async function importBundle({ bundlePath, bundleJson, url, overwrite = false, rewriteOrigin } = {}) {
  let raw;
  if (bundleJson) raw = bundleJson;
  else if (url) raw = await fetchUrl(url);
  else if (bundlePath) raw = await fs.readFile(bundlePath, "utf8");
  else throw new Error("bundle-validation-failed: provide bundlePath, bundleJson, or url");

  let bundle;
  try { bundle = JSON.parse(raw); }
  catch (e) { throw new Error("bundle-validation-failed: invalid JSON"); }
  if (bundle.schema !== BUNDLE_SCHEMA) throw new Error(`bundle-schema-mismatch: expected ${BUNDLE_SCHEMA}, got ${bundle.schema}`);
  if (!Array.isArray(bundle.playbooks)) throw new Error("bundle-validation-failed: playbooks missing");

  const imported = [];
  const skipped = [];
  let rewrittenFrom = null;
  for (const entry of bundle.playbooks) {
    let id = entry.id;
    let markdown = entry.markdown;
    if (rewriteOrigin) {
      const [oldOrigin, feature] = id.split("/");
      if (!rewrittenFrom) rewrittenFrom = oldOrigin;
      id = `${rewriteOrigin}/${feature}`;
      markdown = markdown.replace(new RegExp(`^origin:\\s*${oldOrigin}$`, "m"), `origin: ${rewriteOrigin}`);
    }
    const existing = await getPlaybook(id);
    if (existing && !overwrite) {
      skipped.push({ id, reason: "already-exists" });
      continue;
    }
    let parsed;
    try { parsed = parsePlaybook(markdown); }
    catch (e) { skipped.push({ id, reason: "bundle-playbook-validation-failed", details: String(e.message) }); continue; }
    await savePlaybook({ id, meta: parsed.meta, body: parsed.body, workflow: entry.workflow });
    if (entry.screenshots) {
      const [origin, feature] = id.split("/");
      const dir = path.join(playbooksDir(), origin, `${feature}.screenshots`);
      await fs.mkdir(dir, { recursive: true });
      for (const [name, b64] of Object.entries(entry.screenshots)) {
        await fs.writeFile(path.join(dir, name), Buffer.from(b64, "base64"));
      }
    }
    imported.push(id);
  }
  return { ok: true, imported, skipped, rewrittenFrom, rewrittenTo: rewriteOrigin || null };
}

async function fetchUrl(url) {
  if (!/^https?:\/\//.test(url)) throw new Error("bundle-fetch-failed: only http(s) URLs allowed");
  const { statusCode, body } = await undiciRequest(url, { method: "GET", bodyTimeout: 30_000 });
  if (statusCode < 200 || statusCode >= 300) throw new Error(`bundle-fetch-failed: HTTP ${statusCode}`);
  const chunks = []; for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
```

- [ ] **Step 4: Run test to pass**

```bash
node _playbook_bundles.test.mjs
```
Expected: `✓ playbook bundles`.

- [ ] **Step 5: Update package.json**

In `server/package.json`, extend the `test` script to include `_playbook_bundles.test.mjs`:
```json
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _playbooks.test.mjs && node _playbook_wire.test.mjs && node _secrets.test.mjs && node _codebase_seed.test.mjs && node _visual_diff.test.mjs && node _playbook_bundles.test.mjs && node _integration.mjs && node _multi-client.mjs",
```

- [ ] **Step 6: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbook-bundles.js server/_playbook_bundles.test.mjs server/package.json && git commit -m "feat(playbook-bundles): export/import single-file JSON bundles"
```

---

## Task 6: `playbook-dashboard.js` module + tests

**Files:**
- Create: `server/src/playbook-dashboard.js`
- Create: `server/_playbook_dashboard.test.mjs`
- Modify: `server/package.json`

- [ ] **Step 1: Write the failing test**

Create `server/_playbook_dashboard.test.mjs`:
```js
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { initPlaybooks, savePlaybook } from "./src/playbooks.js";
import { generateDashboard } from "./src/playbook-dashboard.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-dash-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  // Empty library
  const out0 = path.join(tmp, "ui-empty.html");
  const r0 = await generateDashboard({ outputPath: out0 });
  assert.equal(r0.ok, true);
  assert.equal(r0.playbookCount, 0);
  const html0 = await fs.readFile(out0, "utf8");
  assert.ok(html0.startsWith("<!doctype html>") || html0.startsWith("<!DOCTYPE html>"));
  assert.ok(html0.includes("Mochi Playbooks"));

  // Two playbooks
  await savePlaybook({
    id: "mail.google.com/send-email",
    meta: { origin: "mail.google.com", feature: "send-email", title: "Send email", verifiable: true, inputs: [{ name: "to", type: "email", required: true }], outputs: [], success_count: 5, last_verified: "2026-05-20T00:00:00Z", tags: ["email"] },
    body: "## Summary\nSend.\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  });
  await savePlaybook({
    id: "twitter.com/post",
    meta: { origin: "twitter.com", feature: "post", title: "Post tweet", verifiable: false, inputs: [], outputs: [], success_count: 2, last_verified: "2026-05-19T00:00:00Z", tags: ["social"], playbook_version: 0 },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  });

  const out = path.join(tmp, "ui.html");
  const r = await generateDashboard({ outputPath: out });
  assert.equal(r.ok, true);
  assert.equal(r.playbookCount, 2);
  const html = await fs.readFile(out, "utf8");
  assert.ok(html.includes("mail.google.com/send-email"));
  assert.ok(html.includes("twitter.com/post"));
  assert.ok(html.includes("Send email"));
  assert.ok(html.includes("draft")); // playbook_version: 0 → "draft" badge

  // Size sanity (<500KB for a 2-playbook library with no screenshots)
  const stat = await fs.stat(out);
  assert.ok(stat.size < 500_000);

  console.log("✓ playbook dashboard");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbook_dashboard.test.mjs
```
Expected: `Cannot find module './src/playbook-dashboard.js'`.

- [ ] **Step 3: Implement the module**

Create `server/src/playbook-dashboard.js`:
```js
// server/src/playbook-dashboard.js
// Generates a self-contained HTML dashboard from the playbook library.
import fs from "node:fs/promises";
import path from "node:path";
import { playbooksDir, listPlaybooks, getPlaybook } from "./playbooks.js";

export async function generateDashboard({ outputPath } = {}) {
  const finalPath = outputPath || path.join(playbooksDir(), "ui", "index.html");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const entries = await listPlaybooks({});
  const enriched = [];
  for (const e of entries) {
    const pb = await getPlaybook(e.id);
    if (!pb) continue;
    enriched.push({
      id: e.id, origin: e.origin, feature: e.feature, title: e.title,
      verifiable: !!e.verifiable,
      draft: (pb.meta.playbook_version || 0) === 0,
      success_count: e.success_count || 0,
      last_verified: e.last_verified,
      tags: e.tags || [],
      inputs: e.inputs || [],
      summary: extractSection(pb.body || "", "Summary"),
      stepsBody: extractSection(pb.body || "", "Steps"),
      recentRuns: extractSection(pb.body || "", "Recent runs"),
    });
  }
  const html = renderHtml(enriched);
  await fs.writeFile(finalPath, html);
  const stat = await fs.stat(finalPath);
  return { ok: true, path: finalPath, playbookCount: enriched.length, totalSizeBytes: stat.size };
}

function extractSection(body, name) {
  const heading = `## ${name}`;
  const idx = body.indexOf(heading);
  if (idx < 0) return "";
  const after = idx + heading.length;
  const next = body.indexOf("##", after);
  return body.slice(after, next > 0 ? next : body.length).trim();
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderHtml(entries) {
  const verifiableCount = entries.filter((e) => e.verifiable).length;
  const draftCount      = entries.filter((e) => e.draft).length;
  const totalRuns       = entries.reduce((s, e) => s + (e.success_count || 0), 0);
  const tagSet = new Set();
  for (const e of entries) for (const t of e.tags || []) tagSet.add(t);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mochi Playbooks</title>
<style>
  *{box-sizing:border-box}
  body{font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;background:#0d1117;color:#c9d1d9}
  header{padding:24px 32px;border-bottom:1px solid #21262d}
  header h1{margin:0;font-size:20px;font-weight:600}
  header .meta{color:#8b949e;font-size:13px;margin-top:4px}
  .container{max-width:1100px;margin:0 auto;padding:24px 32px}
  .search{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .search input{flex:1;min-width:200px;background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:8px 12px;border-radius:6px;font:inherit}
  .tag{display:inline-block;padding:2px 8px;background:#21262d;border-radius:10px;font-size:11px;color:#8b949e;cursor:pointer;border:1px solid transparent}
  .tag.active{background:#1f6feb;color:#fff;border-color:#1f6feb}
  .row{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:8px;cursor:pointer}
  .row:hover{border-color:#58a6ff}
  .row .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#58a6ff}
  .row .title{font-size:14px;margin-top:4px}
  .row .meta{color:#8b949e;font-size:12px;margin-top:6px;display:flex;gap:12px;flex-wrap:wrap}
  .row .badges{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
  .badge{font-size:11px;padding:2px 8px;border-radius:10px}
  .badge.verifiable{background:#238636;color:#fff}
  .badge.draft{background:#9e6a03;color:#fff}
  .badge.tag{background:#30363d;color:#c9d1d9}
  .expand{display:none;margin-top:16px;padding-top:16px;border-top:1px solid #30363d}
  .row.open .expand{display:block}
  .expand h4{margin:12px 0 4px;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}
  .expand pre{background:#0d1117;padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;white-space:pre-wrap}
  footer{padding:16px 32px;color:#8b949e;font-size:12px;border-top:1px solid #21262d;margin-top:24px}
</style>
</head>
<body>
<header>
  <h1>Mochi Playbooks</h1>
  <div class="meta">${entries.length} playbooks · ${verifiableCount} verifiable · ${draftCount} drafts · ${totalRuns} total runs</div>
</header>
<div class="container">
  <div class="search">
    <input id="q" placeholder="Search by id, title, or input…">
    <div id="tags">${[...tagSet].map((t) => `<span class="tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join("")}</div>
  </div>
  <div id="rows">
${entries.map(renderRow).join("\n")}
  </div>
</div>
<footer>generated ${escHtml(new Date().toISOString())} · mochi playbook dashboard</footer>
<script>
const rows = document.querySelectorAll(".row");
const q = document.getElementById("q");
const tags = document.querySelectorAll(".tag");
const activeTags = new Set();
function apply() {
  const term = q.value.toLowerCase();
  rows.forEach((r) => {
    const text = r.dataset.search;
    const rowTags = (r.dataset.tags || "").split(",");
    const matchTerm = !term || text.includes(term);
    const matchTags = !activeTags.size || [...activeTags].every((t) => rowTags.includes(t));
    r.style.display = (matchTerm && matchTags) ? "" : "none";
  });
}
q.addEventListener("input", apply);
tags.forEach((t) => t.addEventListener("click", () => {
  const v = t.dataset.tag;
  if (activeTags.has(v)) { activeTags.delete(v); t.classList.remove("active"); }
  else { activeTags.add(v); t.classList.add("active"); }
  apply();
}));
rows.forEach((r) => r.addEventListener("click", () => r.classList.toggle("open")));
</script>
</body>
</html>`;
}

function renderRow(e) {
  const search = [e.id, e.title, ...(e.inputs || [])].join(" ").toLowerCase();
  const lastRun = e.last_verified ? new Date(e.last_verified).toLocaleString() : "never";
  return `<div class="row" data-search="${escHtml(search)}" data-tags="${escHtml((e.tags || []).join(","))}">
  <div class="id">${escHtml(e.id)}</div>
  <div class="title">${escHtml(e.title)}</div>
  <div class="meta">
    <span>★ ${e.success_count} runs</span>
    <span>last: ${escHtml(lastRun)}</span>
    <span>inputs: ${escHtml((e.inputs || []).join(", ") || "(none)")}</span>
  </div>
  <div class="badges">
    ${e.verifiable ? '<span class="badge verifiable">verifiable</span>' : ""}
    ${e.draft ? '<span class="badge draft">draft</span>' : ""}
    ${(e.tags || []).map((t) => `<span class="badge tag">${escHtml(t)}</span>`).join("")}
  </div>
  <div class="expand">
    <h4>Summary</h4>
    <pre>${escHtml(e.summary)}</pre>
    <h4>Steps</h4>
    <pre>${escHtml(e.stepsBody)}</pre>
    <h4>Recent runs</h4>
    <pre>${escHtml(e.recentRuns)}</pre>
  </div>
</div>`;
}
```

- [ ] **Step 4: Run test to pass**

```bash
node _playbook_dashboard.test.mjs
```
Expected: `✓ playbook dashboard`.

- [ ] **Step 5: Update package.json test script**

In `server/package.json`, extend `test`:
```json
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _playbooks.test.mjs && node _playbook_wire.test.mjs && node _secrets.test.mjs && node _codebase_seed.test.mjs && node _visual_diff.test.mjs && node _playbook_bundles.test.mjs && node _playbook_dashboard.test.mjs && node _integration.mjs && node _multi-client.mjs",
```

- [ ] **Step 6: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbook-dashboard.js server/_playbook_dashboard.test.mjs server/package.json && git commit -m "feat(playbook-dashboard): self-contained HTML dashboard generator"
```

---

## Task 7: Register 3 new MCP tools + blocked verdict + smoke

**Files:**
- Modify: `server/src/tools.js`
- Modify: `server/_smoke.mjs`

- [ ] **Step 1: Add imports near other playbook imports**

In `server/src/tools.js`:
```js
import { exportBundle, importBundle } from "./playbook-bundles.js";
import { generateDashboard } from "./playbook-dashboard.js";
```

- [ ] **Step 2: Add tool definitions in the `tools` array**

After the last `browser_playbook_*` entry, add:
```js
  {
    name: "browser_playbook_export",
    description: "Export one or more playbooks (and their screenshots) to a single JSON bundle file. Useful for sharing across projects or teams.",
    inputSchema: { type: "object", properties: {
      ids:          { type: "array", items: { type: "string" } },
      origin:       { type: "string" },
      tag:          { type: "string" },
      outputPath:   { type: "string" },
      stripSecrets: { type: "boolean", default: true },
    } },
  },
  {
    name: "browser_playbook_import",
    description: "Import a playbook bundle (local file, inline JSON, or https URL). Optionally overwrite existing playbooks or rewrite their origin (e.g., staging → production).",
    inputSchema: { type: "object", properties: {
      bundlePath:    { type: "string" },
      bundleJson:    { type: "string" },
      url:           { type: "string" },
      overwrite:     { type: "boolean", default: false },
      rewriteOrigin: { type: "string" },
    } },
  },
  {
    name: "browser_playbook_dashboard",
    description: "Generate a self-contained HTML dashboard from the playbook library. Pass open:true to also navigate to it (requires an active browser session).",
    inputSchema: { type: "object", properties: {
      outputPath: { type: "string" },
      open:       { type: "boolean", default: true },
    } },
  },
```

- [ ] **Step 3: Add dispatch cases + handlers**

In `handleToolCall`'s local switch, after the existing playbook cases:
```js
    case "browser_playbook_export":             return jsonResult(await toolPlaybookExport(args));
    case "browser_playbook_import":             return jsonResult(await toolPlaybookImport(args));
    case "browser_playbook_dashboard":          return jsonResult(await toolPlaybookDashboard(bridge, args));
```

Add the handler functions alongside the other playbook tools:
```js
async function toolPlaybookExport(args = {}) {
  try { return { ok: true, ...(await exportBundle(args)) }; }
  catch (e) { return { ok: false, error: { code: "internal", message: String(e?.message ?? e) } }; }
}
async function toolPlaybookImport(args = {}) {
  try { return await importBundle(args); }
  catch (e) {
    const msg = String(e?.message ?? e);
    const code = msg.startsWith("bundle-") ? msg.split(":")[0] : "internal";
    return { ok: false, error: { code, message: msg } };
  }
}
async function toolPlaybookDashboard(bridge, args = {}) {
  try {
    const r = await generateDashboard(args);
    if (args.open !== false && bridge?.isConnected?.()) {
      try { await bridge.send("navigate", { url: "file://" + r.path }); } catch {}
    }
    return r;
  } catch (e) { return { ok: false, error: { code: "internal", message: String(e?.message ?? e) } }; }
}
```

- [ ] **Step 4: Update `toolPlaybookRun` to return `blocked` verdict for missing inputs**

Find the existing `toolPlaybookRun` and replace its body:
```js
async function toolPlaybookRun(bridge, args = {}) {
  const { id, inputs: callerInputs = {} } = args;
  try {
    const { playbook, resolved, missing, secretValues } = await playbooks.resolveRunInputs(id, callerInputs);
    if (missing.length > 0) {
      const needs = missing.map((m) => annotateNeed(m, playbook));
      return { ok: true, verdict: "blocked", reason: "missing-required-inputs", needs, runId: null };
    }
    const plan = await playbooks.composeResolve(id, resolved);
    const legs = [];
    const runId = "r" + Math.random().toString(36).slice(2, 8);
    for (const leg of plan.legs) {
      const legResult = await replayPlaybookLeg(bridge, leg, runId, secretValues);
      legs.push(legResult);
      if (legResult.verdict === "fail") break;
    }
    const overall = legs.every((l) => l.verdict === "pass") ? "pass" : (legs.some((l) => l.verdict === "warn") ? "warn" : "fail");
    return { ok: true, verdict: overall, runId, legs };
  } catch (e) { return unwrapPlaybookError(e); }
}

function annotateNeed(m, playbook) {
  const spec = (playbook?.meta?.inputs || []).find((s) => s.name === m.name);
  const need = { name: m.name, type: spec?.type || "text", ref: m.ref, source: m.source };
  if (m.source === "env" && m.ref) {
    const inner = /\$\{([^}]+)\}/.exec(m.ref)?.[1] || "";
    const ci = inner.indexOf(":");
    const varName = ci < 0 ? inner : inner.slice(ci + 1).trim();
    need.hint = `Set env var \`${varName}\``;
  } else if (m.source === "file") {
    const inner = /\$\{secret:([^}]+)\}/.exec(m.ref)?.[1] || "";
    need.hint = `Create \`.continuum/secrets/${inner}.txt\``;
  } else if (m.source === "1password") {
    need.hint = "Sign in to 1Password CLI: `op signin`";
  } else {
    need.hint = `Pass via \`inputs.${m.name}\``;
  }
  return need;
}
```

- [ ] **Step 5: Update smoke test**

In `server/_smoke.mjs`, add to the `want` array:
```js
  "browser_playbook_export",
  "browser_playbook_import",
  "browser_playbook_dashboard",
```

- [ ] **Step 6: Run smoke**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _smoke.mjs
```
Expected: green; tool count reports 54.

- [ ] **Step 7: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/tools.js server/_smoke.mjs && git commit -m "feat(tools): register 3 v2 tools + blocked-verdict for browser_playbook_run"
```

---

## Task 8: Extend wire-contract tests

**Files:**
- Modify: `server/_playbook_wire.test.mjs`

- [ ] **Step 1: Append tests**

Append to `server/_playbook_wire.test.mjs`:
```js
// v2: blocked verdict
{
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2wire-"));
  process.env.MOCHI_PROJECT_DIR = tmp2;
  await initPlaybooks();

  // Save a playbook that requires a missing secret + a missing free input
  await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
    id: "blocked.example.com/login",
    meta: { origin: "blocked.example.com", feature: "login", verifiable: true,
      inputs: [
        { name: "user",     type: "text",   required: true,  ref: null },
        { name: "password", type: "secret", required: true,  ref: "${env:NOT_DEFINED_VAR}" },
      ], outputs: [] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  }});
  const r = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_run", arguments: { id: "blocked.example.com/login" } })).content[0].text);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "blocked");
  assert.ok(r.needs.length >= 2);
  assert.ok(r.needs.find((n) => n.name === "user"));
  assert.ok(r.needs.find((n) => n.name === "password"));
  const pwd = r.needs.find((n) => n.name === "password");
  assert.match(pwd.hint, /env var/);

  await fs.rm(tmp2, { recursive: true, force: true });
}

// export → import round-trip
{
  const tmpExp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2exp-"));
  process.env.MOCHI_PROJECT_DIR = tmpExp;
  await initPlaybooks();
  await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
    id: "exp.example.com/thing",
    meta: { origin: "exp.example.com", feature: "thing", verifiable: false, inputs: [], outputs: [] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [] },
  }});
  const out = path.join(tmpExp, "bundle.json");
  const exp = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_export", arguments: { outputPath: out } })).content[0].text);
  assert.equal(exp.ok, true);
  assert.equal(exp.playbookCount, 1);

  // import into fresh dir
  const tmpImp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2imp-"));
  process.env.MOCHI_PROJECT_DIR = tmpImp;
  await initPlaybooks();
  const imp = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_import", arguments: { bundlePath: out } })).content[0].text);
  assert.equal(imp.ok, true);
  assert.equal(imp.imported.length, 1);

  await fs.rm(tmpExp, { recursive: true, force: true });
  await fs.rm(tmpImp, { recursive: true, force: true });
}

// dashboard generates with open:false
{
  const tmpDash = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-v2dash-"));
  process.env.MOCHI_PROJECT_DIR = tmpDash;
  await initPlaybooks();
  const outPath = path.join(tmpDash, "dash.html");
  const d = JSON.parse((await handleToolCall(bridge, { name: "browser_playbook_dashboard", arguments: { outputPath: outPath, open: false } })).content[0].text);
  assert.equal(d.ok, true);
  assert.equal(d.playbookCount, 0);
  const stat = await fs.stat(outPath);
  assert.ok(stat.size > 0);
  await fs.rm(tmpDash, { recursive: true, force: true });
}

console.log("✓ v2 wire contracts");
```

- [ ] **Step 2: Run test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbook_wire.test.mjs
```
Expected: existing test plus `✓ v2 wire contracts`.

- [ ] **Step 3: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/_playbook_wire.test.mjs && git commit -m "test(playbooks): wire contracts for v2 tools + blocked verdict"
```

---

## Task 9: Slash command verbs + smart-router CLAUDE.md

**Files:**
- Modify: `plugins/qa/commands/playbook.md`
- Modify: `plugins/qa/CLAUDE.md`

- [ ] **Step 1: Extend `/mochi:playbook` verb list**

In `plugins/qa/commands/playbook.md`, append:
```markdown
- `export [--ids=<id1,id2>] [--origin=<host>] [--tag=<tag>] [--out=<path>]` → call `browser_playbook_export`; report bundle path + size.
- `import <path-or-url> [--overwrite] [--rewrite-origin=<host>]` → call `browser_playbook_import`; render the imported/skipped lists.
- `ui` → call `browser_playbook_dashboard` (default `open: true`); the dashboard opens in the user's active browser session.
```

- [ ] **Step 2: Add "Handling blocked verdicts" to CLAUDE.md**

Append to `plugins/qa/CLAUDE.md`:
```markdown

## Handling `blocked` verdicts from `browser_playbook_run`

If the tool returns `{ ok: true, verdict: "blocked", needs: [...] }`, do NOT call the tool again until you've handled each entry in `needs[]`:

- `source: "env"` — tell the user the env var to set (the `hint` field contains the exact name), then wait for confirmation before retrying.
- `source: "1password"` — tell the user to ensure `op` is signed in (`op signin`). If they have multiple accounts: `op signin --account=<acct>`.
- `source: "file"` — instruct the user to create the secret file (path in `hint`); never offer to write secret values via `Write` yourself.
- `source: null` — ask the user for the value directly and pass it via `inputs.<name>` on retry.

Once the missing values are resolvable, re-invoke `browser_playbook_run` with the now-available inputs.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add plugins/qa/commands/playbook.md plugins/qa/CLAUDE.md && git commit -m "docs(qa): /mochi:playbook export/import/ui verbs + blocked-verdict handling rule"
```

---

## Task 10: Bump integration count, run full suite, rebuild bundle, update README

**Files:**
- Modify: `server/_integration.mjs`
- Modify: `server/dist/server.bundle.mjs`
- Modify: `README.md`

- [ ] **Step 1: Bump tool count**

In `server/_integration.mjs`, find the tool-count assertion currently `51` and update to `54`. Use:
```bash
grep -n "51\|tools:" /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server/_integration.mjs | head -5
```
Edit the matching assertion accordingly.

- [ ] **Step 2: Run full suite**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && npm test
```
Expected: all green; smoke reports 54 tools.

- [ ] **Step 3: Rebuild bundle**

```bash
npm run build
```
Expected: no errors.

- [ ] **Step 4: Update README**

In `README.md`, change `51 tools` to `54 tools`. In the `### Playbooks (personal ops memory)` table, append three rows:
```
| `browser_playbook_export` | Export one or more playbooks to a single JSON bundle file. Includes embedded screenshots. |
| `browser_playbook_import` | Import a playbook bundle (file/inline JSON/https URL). Supports overwrite + origin rewrite. |
| `browser_playbook_dashboard` | Generate a self-contained HTML dashboard from the library and (optionally) open it in the browser. |
```

After the existing "v1.5 capabilities" block, append:
```markdown

**v2 capabilities (Sharing & Polish):**
- **1Password integration:** `inputs[].type: secret` refs accept `${1password:vault/item/field}` (alias `${op:...}`). When the `op` CLI is installed and signed in, values are resolved via `op read` and never logged.
- **Vue + SvelteKit codebase seeding:** Nuxt projects (`nuxt.config.*`) and SvelteKit projects (`svelte.config.*` + `@sveltejs/kit`) are detected by `browser_playbook_seed_from_codebase` in addition to Next.js / Vite / CRA.
- **Blocked-verdict UX:** `browser_playbook_run` returns `verdict: "blocked"` with `needs[]` when required inputs are missing, instead of throwing. The main agent uses `hint` per entry to ask the user (or fix the env) and then retries.
- **Cross-project playbook bundles:** `browser_playbook_export` writes a single JSON containing markdown + workflow + base64 screenshots; `browser_playbook_import` restores them anywhere. Supports overwrite + `rewriteOrigin` (e.g., staging → production).
- **HTML dashboard:** `/mochi:playbook ui` generates a self-contained dashboard with search, tag filters, and inline drill-down per playbook.

See [`docs/superpowers/specs/2026-05-20-playbooks-v2-design.md`](docs/superpowers/specs/2026-05-20-playbooks-v2-design.md).
```

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/_integration.mjs server/dist/server.bundle.mjs server/dist/server.bundle.mjs.LEGAL.txt README.md && git commit -m "ci(server): bump integration count 54, rebuild bundle, README + v2 capabilities"
```

---

## Self-Review

### Spec coverage

| Spec section | Implemented by |
|---|---|
| sp1 1Password `${1password:...}` / `${op:...}` | Task 1 |
| sp1 `op` availability check + cache | Task 1 |
| sp1 `listAvailableSecrets` extension | Task 1 |
| sp2 Nuxt detector + Vue template parser | Task 2 |
| sp2 SvelteKit detector | Task 3 |
| sp3 `resolveRunInputs` refactor | Task 4 |
| sp3 blocked verdict + needs annotator | Task 7 |
| sp3 CLAUDE.md handling rule | Task 9 |
| sp4 bundle export | Task 5 |
| sp4 bundle import + rewriteOrigin | Task 5 |
| sp4 export/import tools | Task 7 |
| sp4 slash command verbs | Task 9 |
| sp5 dashboard generator | Task 6 |
| sp5 dashboard tool | Task 7 |
| sp5 `/mochi:playbook ui` verb | Task 9 |
| Integration: smoke 54 + integration 54 + bundle + README | Task 10 |
| Wire tests cover blocked + export/import + dashboard | Task 8 |

### Placeholder scan

- No "TBD" / "TODO" / "implement later" tokens.
- Vue/Svelte parser is a documented heuristic (extracts opening tags, falls back to React extractor's downstream functions). Limitations are stated in the spec.
- `op read` shells out via `child_process.execSync` with a `__setExecForTesting` hook for unit tests.
- Bundle URL fetcher reuses `undici` (already a dep).

### Type consistency

- `resolveRunInputs` returns `{ playbook, resolved, missing, secretValues }` — used consistently in Tasks 4 and 7.
- Bundle schema `mochi-playbook-bundle@1` referenced in spec, Task 5, and Task 8 tests.
- `verdict` values: `"pass"`, `"fail"`, `"warn"`, `"blocked"` consistent in tests + handlers.
- Tool names match across schemas, dispatch, smoke, and tests.

---

## Acceptance verification

1. `cd server && npm test` — every script green; smoke reports 54 tools.
2. The Nuxt fixture produces ≥1 draft playbook with `password` auto-typed as `secret`.
3. The SvelteKit fixture produces ≥1 draft.
4. `browser_playbook_run` against a playbook with a missing required secret returns `verdict: "blocked"` and a populated `needs[]` array.
5. Export → fresh-dir import preserves a playbook byte-identically.
6. `browser_playbook_dashboard` writes a `<!doctype html>` file ≤500KB for a 2-playbook library and ≤2 MB for a 10-playbook library with 5 screenshots each.
7. Bundle rebuilds; size noted in commit.
8. No regression in existing tests.

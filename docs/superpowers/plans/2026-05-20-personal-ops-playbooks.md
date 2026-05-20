# Personal Ops Playbooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-projects 1–4 of the personal-ops-playbooks design as one coherent system: per-feature markdown playbooks under `.continuum/playbooks/`, 7 new MCP tools, a QA subagent + smart-router rule, an auto-learning promoter, and chain/cron composition.

**Architecture:** A new `server/src/playbooks.js` module owns parsing, validation, CRUD, scoring, and the trace→playbook promoter. Seven new wire-or-local MCP tools register in `tools.js`. The plugin gains a new `plugins/qa/` directory carrying the `qa-tester` agent, a project-level CLAUDE.md smart-router rule, and four new slash commands. Playbook replay rides through `browser_workflow_run` for selector self-heal; the heal events feed back to the playbook's "Recent runs" log via a new hook in `tools.js`. Chains and cron are resolved server-side; scheduling delegates to the host environment's existing `schedule` skill.

**Tech Stack:** Node 22 (ESM), `js-yaml` (new — frontmatter parsing), existing `server/src/memory.js` (selector/workflow store), Chrome DevTools Protocol (existing), Claude Code plugin manifest format (existing).

**Spec:** `docs/superpowers/specs/2026-05-20-personal-ops-playbooks-design.md`

---

## File Structure

**New files (server):**
- `server/src/playbooks.js` — parse, serialize, validate, CRUD, match, promote. ~700 lines.
- `server/_playbooks.test.mjs` — unit tests for the module. ~400 lines.
- `server/_playbook_wire.test.mjs` — tool wire-contract tests. ~150 lines.
- `server/_playbook_e2e.mjs` — end-to-end against fixture pages. ~200 lines.
- `server/_fixtures/playbooks/server.mjs` — fixture HTTP server. ~100 lines.
- `server/_fixtures/playbooks/pages/login-form.html`
- `server/_fixtures/playbooks/pages/compose-form.html`
- `server/_fixtures/playbooks/pages/multi-step-wizard.html`

**New files (plugin):**
- `plugins/qa/CLAUDE.md` — smart-router task-classification rule.
- `plugins/qa/agents/qa-tester.md` — subagent definition.
- `plugins/qa/commands/qa.md` — `/qa <task>` slash command.
- `plugins/qa/commands/playbook.md` — `/mochi:playbook <verb> [args]` aggregator.
- `plugins/qa/commands/schedule-playbook.md` — `/mochi:schedule-playbook <id>`.
- `plugins/qa/commands/unschedule-playbook.md` — `/mochi:unschedule-playbook <id>`.

**Modified files:**
- `server/src/tools.js` — register 7 new tools (`browser_playbook_list/get/save/delete/match/run/propose_update`), add local dispatch cases, wire selector-heal → playbook update.
- `server/package.json` — add `js-yaml` dep; extend `test` script to include new test files.
- `server/_smoke.mjs` — bump expected tool count to 48; assert new tools register.
- `server/_integration.mjs` — bump expected tool count to 48.
- `.claude-plugin/plugin.json` — register the new commands, agents, and CLAUDE.md.
- `README.md` — add "Playbooks" section under Tools.
- `server/dist/server.bundle.mjs` — rebuilt via `npm run build`.

---

## Task 1: Scaffold `playbooks.js` + parse markdown frontmatter

**Files:**
- Create: `server/src/playbooks.js`
- Create: `server/_playbooks.test.mjs`
- Modify: `server/package.json` (add js-yaml)
- Modify: `server/_smoke.mjs` (no behavior change yet — but reserve)

- [ ] **Step 1: Install js-yaml**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && npm install js-yaml@4
```

- [ ] **Step 2: Write the failing test**

Create `server/_playbooks.test.mjs`:
```js
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { parsePlaybook, serializePlaybook, playbooksDir, initPlaybooks } from "./src/playbooks.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();

assert.equal(playbooksDir(), path.join(tmp, ".continuum", "playbooks"));
const stat = await fs.stat(playbooksDir());
assert.ok(stat.isDirectory());

const md = [
  "---",
  "origin: mail.google.com",
  "feature: send-email",
  "title: Send email",
  "verifiable: true",
  "inputs:",
  "  - { name: to, type: email, required: true }",
  "outputs: []",
  "preconditions: [logged-in]",
  "composes: []",
  "next: null",
  "cron: null",
  "last_verified: 2026-05-20T10:00:00Z",
  "success_count: 0",
  "playbook_version: 1",
  "schema_version: 1",
  "---",
  "",
  "## Summary",
  "Send a gmail message.",
  "",
  "## Preconditions",
  "User logged in.",
  "",
  "## Steps",
  "1. Click compose.",
  "",
  "## Verification",
  "Toast appears.",
  "",
  "## Selectors used",
  "",
  "| intent | selector |",
  "|---|---|",
  "| compose | `[data-tooltip=Compose]` |",
  "",
  "## Recent runs",
  "",
  "- r1 (2026-05-20) — pass, 6s",
  "",
  "## Screenshots",
  "",
  "- (none yet)",
  "",
].join("\n");

const pb = parsePlaybook(md);
assert.equal(pb.meta.origin, "mail.google.com");
assert.equal(pb.meta.feature, "send-email");
assert.equal(pb.meta.verifiable, true);
assert.equal(pb.meta.inputs.length, 1);
assert.equal(pb.meta.inputs[0].name, "to");
assert.ok(pb.sections.summary.includes("Send a gmail message"));
assert.ok(pb.sections.steps.includes("Click compose"));
assert.equal(pb.sections.selectors_used.length, 1);
assert.equal(pb.sections.selectors_used[0].intent, "compose");

const round = serializePlaybook(pb);
assert.equal(round, md, "round-trip serialization should be byte-identical");

console.log("✓ Task 1 — parse + round-trip");
await fs.rm(tmp, { recursive: true, force: true });
```

- [ ] **Step 3: Update server/package.json test script**

Change `test` line to:
```json
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _playbooks.test.mjs && node _playbook_wire.test.mjs && node _integration.mjs && node _multi-client.mjs",
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbooks.test.mjs
```
Expected: `Cannot find module './src/playbooks.js'`.

- [ ] **Step 5: Implement the parser**

Create `server/src/playbooks.js`:
```js
// server/src/playbooks.js
// Per-feature markdown playbooks under .continuum/playbooks/.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const PLAYBOOK_SCHEMA_VERSION = 1;

function projectDir() {
  return process.env.MOCHI_PROJECT_DIR || process.cwd();
}

export function playbooksDir() {
  return path.join(projectDir(), ".continuum", "playbooks");
}

function indexPath() { return path.join(playbooksDir(), "index.json"); }
function inboxDir()  { return path.join(playbooksDir(), "inbox"); }

export async function initPlaybooks() {
  await fs.mkdir(playbooksDir(), { recursive: true });
  await fs.mkdir(path.join(playbooksDir(), "_generic"), { recursive: true });
  await fs.mkdir(inboxDir(), { recursive: true });
  try { await fs.access(indexPath()); }
  catch { await fs.writeFile(indexPath(), JSON.stringify({ version: 1, playbooks: [] }, null, 2)); }
}

const SECTION_HEADINGS = [
  ["summary",         "## Summary"],
  ["preconditions",   "## Preconditions"],
  ["steps",           "## Steps"],
  ["verification",    "## Verification"],
  ["selectors_used",  "## Selectors used"],
  ["recent_runs",     "## Recent runs"],
  ["screenshots",     "## Screenshots"],
];

export function parsePlaybook(md) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) throw new Error("playbook-validation-failed: missing frontmatter");
  const meta = yaml.load(m[1]);
  const body = m[2];
  const sections = {};
  const indexes = SECTION_HEADINGS.map(([key, heading]) => ({ key, heading, pos: body.indexOf(heading) }));
  indexes.sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < indexes.length; i++) {
    const cur = indexes[i];
    if (cur.pos < 0) { sections[cur.key] = parseSection(cur.key, ""); continue; }
    const next = indexes.slice(i + 1).find((x) => x.pos > cur.pos);
    const startsAt = cur.pos + cur.heading.length;
    const endsAt = next ? next.pos : body.length;
    const raw = body.slice(startsAt, endsAt).trim();
    sections[cur.key] = parseSection(cur.key, raw);
  }
  return { meta, body, sections };
}

function parseSection(key, raw) {
  if (key === "selectors_used") {
    const out = [];
    for (const line of raw.split("\n")) {
      const m = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
      if (m && m[1] && m[1] !== "intent" && !m[1].startsWith("-")) {
        out.push({ intent: m[1].trim(), selector: m[2].trim() });
      }
    }
    return out;
  }
  return raw;
}

export function serializePlaybook({ meta, body }) {
  const front = yaml.dump(meta, { lineWidth: 200, sortKeys: false }).trim();
  return `---\n${front}\n---\n${body}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbooks.test.mjs
```
Expected: `✓ Task 1 — parse + round-trip`.

- [ ] **Step 7: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs server/package.json server/package-lock.json && git commit -m "feat(playbooks): scaffold module with frontmatter parser and round-trip serializer"
```

---

## Task 2: Validation + error codes

**Files:**
- Modify: `server/src/playbooks.js`
- Modify: `server/_playbooks.test.mjs`

- [ ] **Step 1: Append validation tests**

```js
import { validatePlaybook, playbookErr } from "./src/playbooks.js";

{
  // missing required fields
  let err = validatePlaybook({ meta: {}, body: "" });
  assert.equal(err.code, "playbook-validation-failed");
  assert.ok(err.details.issues.some((x) => x.includes("origin")));

  // bad id shape
  err = validatePlaybook({ meta: { origin: "Bad Origin!!", feature: "send-email" }, body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n" });
  assert.equal(err.code, "playbook-validation-failed");
  assert.ok(err.details.issues.some((x) => x.toLowerCase().includes("origin")));

  // bad feature slug
  err = validatePlaybook({ meta: { origin: "mail.google.com", feature: "Send Email" }, body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n" });
  assert.equal(err.code, "playbook-validation-failed");
  assert.ok(err.details.issues.some((x) => x.toLowerCase().includes("feature")));

  // invalid input type
  err = validatePlaybook({
    meta: { origin: "mail.google.com", feature: "send-email", inputs: [{ name: "x", type: "weird-type" }] },
    body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  });
  assert.ok(err.details.issues.some((x) => x.toLowerCase().includes("type")));

  // valid playbook returns null
  const ok = validatePlaybook({
    meta: { origin: "mail.google.com", feature: "send-email", inputs: [], outputs: [] },
    body: "## Summary\nX\n## Preconditions\nY\n## Steps\nZ\n## Verification\nW\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  });
  assert.equal(ok, null);

  // playbookErr is constructible
  const e = playbookErr("playbook-not-found", "no such playbook", { id: "x" });
  assert.equal(e.playbookError.code, "playbook-not-found");

  console.log("✓ Task 2 — validation");
}
```

- [ ] **Step 2: Run test to confirm failure**

```bash
node _playbooks.test.mjs
```
Expected: `validatePlaybook is not a function` or similar.

- [ ] **Step 3: Implement validation**

Append to `server/src/playbooks.js`:
```js
const VALID_INPUT_TYPES = new Set([
  "text", "email", "url", "markdown", "password",
  "file", "file[]", "image", "image[]",
  "secret", "enum", "int", "bool",
]);

const REQUIRED_SECTIONS = ["summary", "preconditions", "steps", "verification", "selectors_used", "recent_runs", "screenshots"];

export function playbookErr(code, message, details) {
  const e = new Error(`${code}: ${message}`);
  e.playbookError = { code, message, details };
  return e;
}

export function validatePlaybook({ meta, body }) {
  const issues = [];
  if (!meta || typeof meta !== "object") {
    issues.push("frontmatter missing");
    return { code: "playbook-validation-failed", details: { issues } };
  }
  if (!meta.origin || typeof meta.origin !== "string")  issues.push("origin: missing or not a string");
  else if (!/^[a-z0-9.-]+$/.test(meta.origin) && meta.origin !== "_generic") issues.push(`origin: invalid format "${meta.origin}"`);
  if (!meta.feature || typeof meta.feature !== "string") issues.push("feature: missing or not a string");
  else if (!/^[a-z0-9-]+$/.test(meta.feature))           issues.push(`feature: must be kebab-case [a-z0-9-]+, got "${meta.feature}"`);
  else if (meta.feature.length > 40)                     issues.push("feature: max 40 chars");

  for (const input of meta.inputs ?? []) {
    if (!input.name || !/^[a-zA-Z_$][\w$]*$/.test(input.name)) issues.push(`inputs[].name: invalid identifier "${input.name}"`);
    if (!input.type || !VALID_INPUT_TYPES.has(input.type))     issues.push(`inputs[].type: must be one of ${[...VALID_INPUT_TYPES].join(",")}, got "${input.type}"`);
  }
  if (meta.cron && typeof meta.cron === "string" && !isValidCron(meta.cron)) {
    issues.push(`cron: invalid cron expression "${meta.cron}"`);
  }

  // body section presence
  if (typeof body === "string") {
    for (const sec of REQUIRED_SECTIONS) {
      const heading = "## " + sec.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Selectors Used/, "Selectors used").replace(/Recent Runs/, "Recent runs");
      if (!body.includes(heading)) issues.push(`section missing: ${heading}`);
    }
  }
  return issues.length ? { code: "playbook-validation-failed", details: { issues } } : null;
}

function isValidCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*,/-]+$/.test(p));
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
node _playbooks.test.mjs
```
Expected: `✓ Task 2 — validation`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs && git commit -m "feat(playbooks): validation + playbookErr taxonomy"
```

---

## Task 3: CRUD + atomic file writes + index rebuild

**Files:**
- Modify: `server/src/playbooks.js`
- Modify: `server/_playbooks.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { savePlaybook, getPlaybook, listPlaybooks, deletePlaybook, rebuildIndex } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const meta = {
    origin: "mail.google.com",
    feature: "send-email",
    title: "Send email",
    verifiable: true,
    preconditions: [],
    inputs: [{ name: "to", type: "email", required: true }],
    outputs: [],
    composes: [],
    next: null,
    cron: null,
    last_verified: "2026-05-20T10:00:00Z",
    success_count: 0,
    playbook_version: 1,
    schema_version: 1,
  };
  const body = "## Summary\nSend.\n## Preconditions\nLogged-in.\n## Steps\n1. compose.\n## Verification\nToast.\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n";
  const workflow = { playbookId: "mail.google.com/send-email", schemaVersion: 1, steps: [{ action: "navigate", url: "https://mail.google.com" }] };

  const saved = await savePlaybook({ id: "mail.google.com/send-email", meta, body, workflow });
  assert.equal(saved.ok, true);
  assert.ok(saved.path.endsWith("send-email.md"));

  const got = await getPlaybook("mail.google.com/send-email");
  assert.equal(got.meta.feature, "send-email");
  assert.equal(got.workflow.steps[0].action, "navigate");

  const list = await listPlaybooks({ verifiable: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "mail.google.com/send-email");

  // invalid playbook rejected
  await assert.rejects(savePlaybook({ id: "mail.google.com/send-email", meta: { ...meta, feature: "BAD!" }, body, workflow }), /playbook-validation-failed/);
  // id mismatch rejected
  await assert.rejects(savePlaybook({ id: "other.com/x", meta, body, workflow }), /playbook-id-mismatch/);

  await deletePlaybook("mail.google.com/send-email");
  const list2 = await listPlaybooks({});
  assert.equal(list2.length, 0);

  // rebuildIndex idempotence
  const r = await rebuildIndex();
  assert.equal(r.entries, 0);

  console.log("✓ Task 3 — CRUD");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run test to confirm failure**

```bash
node _playbooks.test.mjs
```
Expected: `savePlaybook is not a function`.

- [ ] **Step 3: Implement CRUD**

Append to `server/src/playbooks.js`:
```js
function pathFor(id, ext = ".md") {
  const [origin, feature] = id.split("/");
  return path.join(playbooksDir(), origin, feature + ext);
}

let writeMutex = Promise.resolve();
async function withMutex(fn) {
  const prev = writeMutex;
  let release;
  writeMutex = new Promise((r) => { release = r; });
  try { await prev; return await fn(); }
  finally { release(); }
}

async function atomicWrite(p, content) {
  const tmp = p + ".tmp." + process.pid + "." + Date.now();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, p);
}

export async function savePlaybook({ id, meta, body, workflow }) {
  await initPlaybooks();
  if (!id || !id.includes("/")) throw playbookErr("playbook-id-invalid", "id must be <origin>/<feature>", { id });
  if (meta.origin + "/" + meta.feature !== id) {
    throw playbookErr("playbook-id-mismatch", "id does not match meta.origin/meta.feature", { id, expected: meta.origin + "/" + meta.feature });
  }
  const err = validatePlaybook({ meta, body });
  if (err) throw playbookErr(err.code, "playbook failed validation", err.details);

  const md = serializePlaybook({ meta, body });
  await withMutex(async () => {
    await atomicWrite(pathFor(id, ".md"), md);
    if (workflow) await atomicWrite(pathFor(id, ".workflow.json"), JSON.stringify(workflow, null, 2));
    await rebuildIndex();
  });
  return { ok: true, path: pathFor(id, ".md") };
}

export async function getPlaybook(id) {
  try {
    const md = await fs.readFile(pathFor(id, ".md"), "utf8");
    const parsed = parsePlaybook(md);
    let workflow = null;
    try { workflow = JSON.parse(await fs.readFile(pathFor(id, ".workflow.json"), "utf8")); }
    catch {}
    return { id, ...parsed, workflow };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function listPlaybooks({ origin, feature, tag, verifiable } = {}) {
  await initPlaybooks();
  const raw = JSON.parse(await fs.readFile(indexPath(), "utf8"));
  return raw.playbooks.filter((p) => {
    if (origin && p.origin !== origin) return false;
    if (feature && p.feature !== feature) return false;
    if (tag && !(p.tags || []).includes(tag)) return false;
    if (verifiable !== undefined && p.verifiable !== verifiable) return false;
    return true;
  });
}

export async function deletePlaybook(id) {
  await withMutex(async () => {
    try { await fs.unlink(pathFor(id, ".md")); } catch {}
    try { await fs.unlink(pathFor(id, ".workflow.json")); } catch {}
    try { await fs.rm(pathFor(id, ".screenshots"), { recursive: true, force: true }); } catch {}
    await rebuildIndex();
  });
  return { ok: true };
}

export async function rebuildIndex() {
  await initPlaybooks();
  const entries = [];
  const origins = await fs.readdir(playbooksDir());
  for (const origin of origins) {
    if (origin === "inbox" || origin === "index.json" || origin.startsWith(".")) continue;
    const originPath = path.join(playbooksDir(), origin);
    let st; try { st = await fs.stat(originPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const files = await fs.readdir(originPath);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const md = await fs.readFile(path.join(originPath, f), "utf8").catch(() => null);
      if (!md) continue;
      let parsed; try { parsed = parsePlaybook(md); } catch { continue; }
      const m = parsed.meta;
      entries.push({
        id: `${m.origin}/${m.feature}`,
        origin: m.origin,
        feature: m.feature,
        title: m.title || m.feature,
        verifiable: !!m.verifiable,
        inputs: (m.inputs || []).map((x) => x.name),
        success_count: m.success_count || 0,
        last_verified: m.last_verified || null,
        tags: m.tags || [],
      });
    }
  }
  await atomicWrite(indexPath(), JSON.stringify({ version: 1, playbooks: entries }, null, 2));
  return { entries: entries.length };
}
```

- [ ] **Step 4: Run test**

```bash
node _playbooks.test.mjs
```
Expected: `✓ Task 3 — CRUD`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs && git commit -m "feat(playbooks): CRUD + atomic writes + index rebuild"
```

---

## Task 4: matchPlaybook scoring

**Files:**
- Modify: `server/src/playbooks.js`
- Modify: `server/_playbooks.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { matchPlaybook } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  await savePlaybook({
    id: "mail.google.com/send-email",
    meta: { origin: "mail.google.com", feature: "send-email", inputs: [], outputs: [], verifiable: true, tags: ["email"] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nNavigate https://mail.google.com/mail/u/0/#inbox\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: { steps: [{ action: "navigate", url: "https://mail.google.com/mail/u/0/#inbox" }] },
  });
  await savePlaybook({
    id: "twitter.com/post",
    meta: { origin: "twitter.com", feature: "post", inputs: [], outputs: [], verifiable: false, tags: ["social"] },
    body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
    workflow: null,
  });

  const m1 = await matchPlaybook({ url: "https://mail.google.com/mail/u/0/#inbox", taskText: "send an email" });
  assert.ok(m1.length >= 1);
  assert.equal(m1[0].playbookId, "mail.google.com/send-email");
  assert.ok(m1[0].score >= 50);

  const m2 = await matchPlaybook({ url: "https://unrelated.com" });
  assert.equal(m2.length, 0); // below threshold

  const m3 = await matchPlaybook({ taskText: "social post on twitter", url: null });
  assert.ok(m3.some((x) => x.playbookId === "twitter.com/post"));

  console.log("✓ Task 4 — matchPlaybook");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing test**

```bash
node _playbooks.test.mjs
```

- [ ] **Step 3: Implement matchPlaybook**

Append to `server/src/playbooks.js`:
```js
const MATCH_THRESHOLD = 30;

export async function matchPlaybook({ url, intent, taskText } = {}) {
  const entries = await listPlaybooks({});
  const u = url ? safeUrl(url) : null;
  const text = (taskText || "").toLowerCase();
  const stems = tokenize(text);
  const results = [];
  for (const e of entries) {
    let score = 0;
    const reasons = [];
    if (u && e.origin === u.hostname) { score += 50; reasons.push("origin-match"); }
    if (taskText) {
      const featStems = tokenize(e.feature.replace(/-/g, " "));
      const overlap = featStems.filter((t) => stems.includes(t)).length;
      if (overlap) { score += overlap * 10; reasons.push(`feature-token-overlap:${overlap}`); }
      const titleStems = tokenize(e.title || "");
      const tOverlap = titleStems.filter((t) => stems.includes(t)).length;
      if (tOverlap) { score += tOverlap * 5; reasons.push(`title-token-overlap:${tOverlap}`); }
      for (const tag of e.tags || []) {
        if (stems.includes(tag.toLowerCase())) { score += 10; reasons.push(`tag-match:${tag}`); }
      }
    }
    if (intent && e.feature.includes(intent)) { score += 15; reasons.push("intent-match"); }
    if (score >= MATCH_THRESHOLD) results.push({ playbookId: e.id, score, reason: reasons.join(", ") });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

function safeUrl(s) { try { return new URL(s); } catch { return null; } }
function tokenize(s) {
  return (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}
const STOPWORDS = new Set(["the","and","for","with","from","that","this","into","onto","when","then","than","but","not","you"]);
```

- [ ] **Step 4: Run test**

```bash
node _playbooks.test.mjs
```
Expected: `✓ Task 4 — matchPlaybook`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs && git commit -m "feat(playbooks): matchPlaybook with origin/token/tag scoring"
```

---

## Task 5: Trace → playbook promoter (`promoteFromTrace`)

**Files:**
- Modify: `server/src/playbooks.js`
- Modify: `server/_playbooks.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { promoteFromTrace } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  const trace = [
    { tool: "browser_navigate", args: { url: "https://example.com/login" } },
    { tool: "browser_type",     args: { intent: "username-field", value: "user@example.com" } },
    { tool: "browser_type",     args: { intent: "password-field", value: "${SECRET}" } },
    { tool: "browser_click",    args: { intent: "submit-button" } },
    { tool: "browser_assert",   args: { kind: "url-contains", value: "/dashboard" } },
  ];

  const r = await promoteFromTrace({ label: "login", trace, title: "Log in via example.com" });
  assert.equal(r.created, true);
  assert.equal(r.playbookId, "example.com/login");
  const pb = await getPlaybook("example.com/login");
  assert.equal(pb.meta.origin, "example.com");
  assert.equal(pb.meta.feature, "login");
  assert.equal(pb.workflow.steps.length, 5);
  assert.equal(pb.workflow.steps[1].action, "type");
  assert.equal(pb.workflow.steps[1].intent, "username-field");
  // inputs inferred from intents
  assert.ok(pb.meta.inputs.some((i) => i.name === "username"));
  assert.ok(pb.meta.inputs.some((i) => i.name === "password"));
  assert.equal(pb.meta.inputs.find((i) => i.name === "password").type, "secret");

  // second call → updates, not create
  const trace2 = [...trace, { tool: "browser_screenshot", args: {} }];
  const r2 = await promoteFromTrace({ label: "login", trace: trace2 });
  assert.equal(r2.created, false);
  assert.match(r2.diffSummary, /added|updated/i);

  console.log("✓ Task 5 — promoter");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing test**

```bash
node _playbooks.test.mjs
```

- [ ] **Step 3: Implement the promoter**

Append to `server/src/playbooks.js`:
```js
const TOOL_TO_ACTION = {
  browser_navigate:   "navigate",
  browser_click:      "click",
  browser_click_at:   "click",
  browser_type:       "type",
  browser_press_key:  "press_key",
  browser_scroll:     "scroll",
  browser_wait:       "wait",
  browser_assert:     "assert",
  browser_upload_file:"upload",
};

export async function promoteFromTrace({ label, title, verifiable = false, trace, screenshots = [], explicitInputs, explicitOutputs }) {
  if (!Array.isArray(trace) || !trace.length) throw playbookErr("playbook-validation-failed", "trace empty");
  const firstNav = trace.find((t) => t.tool === "browser_navigate" && t.args?.url);
  if (!firstNav) throw playbookErr("playbook-validation-failed", "trace has no navigate step — cannot infer origin");
  const origin = new URL(firstNav.args.url).hostname;
  const feature = (label || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!feature) throw playbookErr("playbook-validation-failed", "label required to derive feature slug");
  const id = `${origin}/${feature}`;

  const steps = [];
  for (const call of trace) {
    const action = TOOL_TO_ACTION[call.tool];
    if (!action) continue;
    const step = { action };
    if (action === "navigate") step.url = call.args.url;
    if (action === "click" || action === "type" || action === "upload") {
      if (call.args.intent) step.intent = call.args.intent;
      else if (call.args.selector) step.selector = call.args.selector;
    }
    if (action === "type" && call.args.value !== undefined) step.valueRef = inferValueRef(call.args.intent, call.args.value);
    if (action === "upload" && call.args.files) step.filesRef = "input.attachments";
    if (action === "press_key") step.key = call.args.key;
    if (action === "scroll")    step.params = call.args;
    if (action === "wait")      step.ms = call.args.ms ?? 500;
    if (action === "assert") { step.kind = call.args.kind; step.value = call.args.value; step.timeoutMs = call.args.timeoutMs; }
    steps.push(step);
  }

  const inputs = explicitInputs || inferInputs(steps);
  const outputs = explicitOutputs || [];

  const meta = {
    origin, feature,
    title: title || `${feature.replace(/-/g, " ")} on ${origin}`,
    verifiable,
    preconditions: [],
    inputs, outputs,
    composes: [],
    next: null,
    cron: null,
    last_verified: new Date().toISOString(),
    success_count: 1,
    playbook_version: 1,
    schema_version: 1,
    tags: [],
  };

  const existing = await getPlaybook(id);
  let body;
  if (existing) {
    meta.success_count = (existing.meta.success_count || 0) + 1;
    meta.last_verified = new Date().toISOString();
    body = updateBodyForRerun(existing.body, steps);
  } else {
    body = freshBody(steps);
  }

  const workflow = { playbookId: id, schemaVersion: 1, steps };
  await savePlaybook({ id, meta, body, workflow });
  return {
    ok: true,
    playbookId: id,
    created: !existing,
    diffSummary: existing ? summarizeDiff(existing.workflow?.steps || [], steps) : "created",
    path: pathFor(id, ".md"),
  };
}

function inferValueRef(intent, value) {
  if (!intent) return "input.value";
  if (intent.includes("password") || intent.includes("secret")) return "input.password";
  if (intent.includes("email"))    return "input.email";
  const base = intent.replace(/-field$|-input$|-button$/g, "").replace(/[^a-z0-9]+/gi, "_");
  return `input.${base || "value"}`;
}

function inferInputs(steps) {
  const seen = new Map();
  for (const s of steps) {
    if (s.valueRef && s.valueRef.startsWith("input.")) {
      const name = s.valueRef.slice("input.".length);
      if (!seen.has(name)) {
        const isSecret = /password|token|secret|key/i.test(name);
        seen.set(name, { name, type: isSecret ? "secret" : "text", required: true });
      }
    }
    if (s.filesRef === "input.attachments" && !seen.has("attachments")) {
      seen.set("attachments", { name: "attachments", type: "file[]", required: false });
    }
  }
  return [...seen.values()];
}

function freshBody(steps) {
  return [
    "## Summary",
    "Auto-generated playbook from successful trace.",
    "",
    "## Preconditions",
    "(none recorded)",
    "",
    "## Steps",
    ...steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
    "",
    "## Verification",
    "Steps completed without throwing.",
    "",
    "## Selectors used",
    "",
    "| intent | selector |",
    "|---|---|",
    "",
    "## Recent runs",
    "",
    `- promoted-${new Date().toISOString()} — first capture, ${steps.length} steps`,
    "",
    "## Screenshots",
    "",
    "- (none yet)",
    "",
  ].join("\n");
}

function updateBodyForRerun(prevBody, newSteps) {
  // append a new "Recent runs" entry; keep last 20
  const lines = prevBody.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("## Recent runs"));
  if (startIdx < 0) return freshBody(newSteps);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith("## "));
  const before = lines.slice(0, startIdx + 1);
  const after = endIdx > 0 ? lines.slice(endIdx) : [""];
  const prevRuns = lines.slice(startIdx + 1, endIdx > 0 ? endIdx : lines.length).filter((l) => l.trim().startsWith("-"));
  const newRun = `- promoted-${new Date().toISOString()} — ${newSteps.length} steps`;
  const trimmed = [newRun, ...prevRuns].slice(0, 20);
  return [...before, "", ...trimmed, "", ...after].join("\n");
}

function describeStep(s) {
  switch (s.action) {
    case "navigate":  return `Navigate to \`${s.url}\``;
    case "click":     return `Click intent \`${s.intent || s.selector}\``;
    case "type":      return `Type \`${s.valueRef}\` into intent \`${s.intent || s.selector}\``;
    case "press_key": return `Press \`${s.key}\``;
    case "scroll":    return `Scroll \`${JSON.stringify(s.params)}\``;
    case "wait":      return `Wait ${s.ms} ms`;
    case "upload":    return `Upload \`${s.filesRef}\` via intent \`${s.intent || s.selector}\``;
    case "assert":    return `Assert ${s.kind} = \`${s.value}\``;
    default:          return JSON.stringify(s);
  }
}

function summarizeDiff(prevSteps, newSteps) {
  const added = newSteps.length - prevSteps.length;
  if (added > 0) return `added ${added} step(s)`;
  if (added < 0) return `removed ${Math.abs(added)} step(s)`;
  return "updated existing steps";
}
```

- [ ] **Step 4: Run test**

```bash
node _playbooks.test.mjs
```
Expected: `✓ Task 5 — promoter`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs && git commit -m "feat(playbooks): trace→playbook promoter with input inference"
```

---

## Task 6: composeResolve (cycle detection + input/output passthrough)

**Files:**
- Modify: `server/src/playbooks.js`
- Modify: `server/_playbooks.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { composeResolve } from "./src/playbooks.js";

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-test-"));
  process.env.MOCHI_PROJECT_DIR = tmp;
  await initPlaybooks();

  // single playbook
  await savePlaybook({
    id: "twitter.com/post", meta: { origin: "twitter.com", feature: "post", inputs: [{ name: "text", type: "text", required: true }], outputs: [{ name: "postUrl", type: "url" }], verifiable: false }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });
  // parent composes child
  await savePlaybook({
    id: "blog.example.com/cross-post", meta: { origin: "blog.example.com", feature: "cross-post", inputs: [{ name: "text", type: "text", required: true }], outputs: [], verifiable: false, composes: [{ id: "twitter.com/post", inputs: { text: "${input.text}" } }] }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });

  const plan = await composeResolve("blog.example.com/cross-post", { text: "hi" });
  assert.equal(plan.legs.length, 2); // self + composed
  assert.equal(plan.legs[1].playbookId, "twitter.com/post");
  assert.equal(plan.legs[1].inputs.text, "hi");

  // missing input
  await assert.rejects(composeResolve("twitter.com/post", {}), /playbook-input-missing/);

  // cycle
  await savePlaybook({
    id: "cycle.com/a", meta: { origin: "cycle.com", feature: "a", inputs: [], outputs: [], verifiable: false, composes: [{ id: "cycle.com/b", inputs: {} }] }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });
  await savePlaybook({
    id: "cycle.com/b", meta: { origin: "cycle.com", feature: "b", inputs: [], outputs: [], verifiable: false, composes: [{ id: "cycle.com/a", inputs: {} }] }, body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n", workflow: { steps: [] },
  });
  await assert.rejects(composeResolve("cycle.com/a", {}), /playbook-compose-cycle/);

  console.log("✓ Task 6 — composeResolve");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run failing test**

```bash
node _playbooks.test.mjs
```

- [ ] **Step 3: Implement composeResolve**

Append to `server/src/playbooks.js`:
```js
export async function composeResolve(playbookId, inputs, _stack = new Set()) {
  if (_stack.has(playbookId)) {
    throw playbookErr("playbook-compose-cycle", "cycle detected", { path: [..._stack, playbookId] });
  }
  const pb = await getPlaybook(playbookId);
  if (!pb) throw playbookErr("playbook-not-found", `no playbook ${playbookId}`);
  for (const inSpec of pb.meta.inputs || []) {
    if (inSpec.required && (inputs[inSpec.name] === undefined || inputs[inSpec.name] === null)) {
      throw playbookErr("playbook-input-missing", `${playbookId} requires input "${inSpec.name}"`, { playbookId, missing: inSpec.name });
    }
  }
  const legs = [{ playbookId, inputs, meta: pb.meta, workflow: pb.workflow }];
  const newStack = new Set([..._stack, playbookId]);
  for (const c of pb.meta.composes || []) {
    const mappedInputs = mapInputs(c.inputs || {}, inputs);
    const sub = await composeResolve(c.id, mappedInputs, newStack);
    legs.push(...sub.legs);
  }
  return { legs };
}

function mapInputs(spec, parentInputs) {
  const out = {};
  for (const [k, v] of Object.entries(spec || {})) {
    if (typeof v === "string") {
      out[k] = v.replace(/\$\{input\.([\w$]+)\}/g, (_, name) => parentInputs[name] ?? "");
    } else {
      out[k] = v;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test**

```bash
node _playbooks.test.mjs
```
Expected: `✓ Task 6 — composeResolve`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/playbooks.js server/_playbooks.test.mjs && git commit -m "feat(playbooks): composeResolve with cycle detection + input mapping"
```

---

## Task 7: Register 7 new MCP tools

**Files:**
- Modify: `server/src/tools.js`
- Modify: `server/_smoke.mjs`

- [ ] **Step 1: Add tool definitions in `tools` array**

In `server/src/tools.js`, after the `browser_upload_file` entry, add seven new tool entries:

```js
  {
    name: "browser_playbook_list",
    description: "List per-feature playbooks. Filter by origin, feature slug, tag, or verifiable. Returns compact metadata only — call browser_playbook_get for the full body.",
    inputSchema: { type: "object", properties: {
      origin:     { type: "string" },
      feature:    { type: "string" },
      tag:        { type: "string" },
      verifiable: { type: "boolean" },
    } },
  },
  {
    name: "browser_playbook_get",
    description: "Return one playbook with full meta, body sections, and the underlying workflow JSON.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "<origin>/<feature>" } }, required: ["id"] },
  },
  {
    name: "browser_playbook_save",
    description: "Create or update a playbook. Validates frontmatter and required sections. Use browser_playbook_propose_update for trace-driven authoring.",
    inputSchema: { type: "object", properties: {
      id:       { type: "string", description: "<origin>/<feature>" },
      meta:     { type: "object", description: "Frontmatter fields (origin, feature, title, inputs, outputs, etc.)" },
      body:     { type: "string", description: "Markdown body with required sections." },
      workflow: { type: "object", description: "Workflow JSON for replay." },
    }, required: ["id", "meta", "body"] },
  },
  {
    name: "browser_playbook_delete",
    description: "Delete a playbook (markdown, workflow JSON, and screenshots).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "browser_playbook_match",
    description: "Find playbooks matching a URL, intent, or task description. Returns top scored matches above threshold.",
    inputSchema: { type: "object", properties: {
      url:      { type: "string" },
      intent:   { type: "string" },
      taskText: { type: "string" },
    } },
  },
  {
    name: "browser_playbook_run",
    description: "Replay a playbook (with self-heal) using the provided inputs. Recursively executes composes/next chains. Returns a verdict + evidence.",
    inputSchema: { type: "object", properties: {
      id:     { type: "string" },
      inputs: { type: "object", description: "Map of input.name → value (or stashId for files)." },
    }, required: ["id"] },
  },
  {
    name: "browser_playbook_propose_update",
    description: "Given a successful trace, create or update the matching playbook. Inputs and steps are inferred from the trace; selectors are tracked via the existing selector cache.",
    inputSchema: { type: "object", properties: {
      label:       { type: "string", description: "Suggested feature slug." },
      title:       { type: "string" },
      verifiable:  { type: "boolean", default: false },
      runId:       { type: "string", description: "Optional run id; trace loaded from .continuum/runs/." },
      trace:       { type: "array",  description: "Or supply trace inline." },
      inputs:      { type: "array",  description: "Optional explicit input descriptors." },
      outputs:     { type: "array",  description: "Optional explicit outputs." },
      screenshots: { type: "array",  items: { type: "string" } },
    }, required: ["label"] },
  },
```

- [ ] **Step 2: Add local-dispatch cases**

In `server/src/tools.js`'s `handleToolCall`, inside the local-tools switch, add (right after the existing `browser_upload_stage` case):

```js
    case "browser_playbook_list":            return jsonResult(await toolPlaybookList(args));
    case "browser_playbook_get":             return jsonResult(await toolPlaybookGet(args));
    case "browser_playbook_save":            return jsonResult(await toolPlaybookSave(args));
    case "browser_playbook_delete":          return jsonResult(await toolPlaybookDelete(args));
    case "browser_playbook_match":           return jsonResult(await toolPlaybookMatch(args));
    case "browser_playbook_propose_update":  return jsonResult(await toolPlaybookProposeUpdate(args));
```

`browser_playbook_run` is NOT local — it ALSO goes via local dispatch (because it orchestrates other tools via the bridge):

```js
    case "browser_playbook_run":             return jsonResult(await toolPlaybookRun(bridge, args));
```

- [ ] **Step 3: Implement tool handlers**

At the top of `server/src/tools.js`, extend the existing uploads import:
```js
import { stage as stageUpload, uploadErr, uploadsDir, gcSession } from "./uploads.js";
import * as playbooks from "./playbooks.js";
```

Then add (anywhere alongside the other local helpers):
```js
function unwrapPlaybookError(e) {
  if (e.playbookError) return { ok: false, error: e.playbookError };
  return { ok: false, error: { code: "internal", message: String(e?.message ?? e) } };
}

async function toolPlaybookList(args = {}) {
  try { return { ok: true, items: await playbooks.listPlaybooks(args) }; }
  catch (e) { return unwrapPlaybookError(e); }
}
async function toolPlaybookGet({ id } = {}) {
  try {
    const pb = await playbooks.getPlaybook(id);
    if (!pb) return { ok: false, error: { code: "playbook-not-found", message: `no playbook ${id}` } };
    return { ok: true, ...pb };
  } catch (e) { return unwrapPlaybookError(e); }
}
async function toolPlaybookSave(args = {}) {
  try { return { ok: true, ...(await playbooks.savePlaybook(args)) }; }
  catch (e) { return unwrapPlaybookError(e); }
}
async function toolPlaybookDelete({ id } = {}) {
  try { return { ok: true, ...(await playbooks.deletePlaybook(id)) }; }
  catch (e) { return unwrapPlaybookError(e); }
}
async function toolPlaybookMatch(args = {}) {
  try { return { ok: true, matches: await playbooks.matchPlaybook(args) }; }
  catch (e) { return unwrapPlaybookError(e); }
}
async function toolPlaybookProposeUpdate(args = {}) {
  try {
    let trace = args.trace;
    if (!trace && args.runId) {
      // load trace from .continuum/runs/<runId>.jsonl
      const fsp = await import("node:fs/promises");
      const path = await import("path");
      const runFile = path.join(process.env.MOCHI_PROJECT_DIR || process.cwd(), ".continuum", "runs", `${args.runId}.jsonl`);
      const raw = await fsp.readFile(runFile, "utf8").catch(() => null);
      if (!raw) return { ok: false, error: { code: "playbook-validation-failed", message: `runId ${args.runId} not found` } };
      trace = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
    return { ok: true, ...(await playbooks.promoteFromTrace({ ...args, trace })) };
  } catch (e) { return unwrapPlaybookError(e); }
}

async function toolPlaybookRun(bridge, args = {}) {
  const { id, inputs = {} } = args;
  try {
    const plan = await playbooks.composeResolve(id, inputs);
    const legs = [];
    for (const leg of plan.legs) {
      const legResult = await replayPlaybookLeg(bridge, leg);
      legs.push(legResult);
      if (legResult.verdict === "fail") break;
    }
    const overall = legs.every((l) => l.verdict === "pass") ? "pass" : "fail";
    return { ok: true, verdict: overall, legs };
  } catch (e) { return unwrapPlaybookError(e); }
}

async function replayPlaybookLeg(bridge, leg) {
  // Walks the workflow steps using the existing wire actions.
  const steps = leg.workflow?.steps || [];
  const startedAt = Date.now();
  for (const step of steps) {
    try {
      await runWorkflowStep(bridge, step, leg.inputs);
    } catch (e) {
      return { playbookId: leg.playbookId, verdict: "fail", reason: String(e?.message ?? e), durationMs: Date.now() - startedAt };
    }
  }
  return { playbookId: leg.playbookId, verdict: "pass", durationMs: Date.now() - startedAt };
}

async function runWorkflowStep(bridge, step, inputs) {
  const resolveValue = (ref) => {
    if (!ref) return undefined;
    if (typeof ref !== "string") return ref;
    const m = /^input\.(\w+)$/.exec(ref);
    if (m) return inputs[m[1]];
    return ref;
  };
  switch (step.action) {
    case "navigate":  return bridge.send("navigate", { url: step.url });
    case "click":     return bridge.send("click", step.intent ? { ref: step.intent } : { ref: step.selector });
    case "type":      return bridge.send("type",  { ref: step.intent || step.selector, value: resolveValue(step.valueRef) });
    case "press_key": return bridge.send("press_key", { key: step.key });
    case "scroll":    return bridge.send("scroll", step.params || {});
    case "wait":      return bridge.send("wait",   { ms: step.ms ?? 500 });
    case "assert":    return bridge.send("assert", { kind: step.kind, value: step.value, timeoutMs: step.timeoutMs });
    case "upload":    {
      const files = resolveValue(step.filesRef);
      return bridge.send("upload_file", { target: step.intent ? { trigger: { ref: step.intent } } : { selector: step.selector }, ...(files ? { files } : {}) });
    }
    default: throw new Error(`unknown step action: ${step.action}`);
  }
}
```

- [ ] **Step 4: Update smoke test**

In `server/_smoke.mjs`, add to the `want` array:
```js
  "browser_playbook_list",
  "browser_playbook_get",
  "browser_playbook_save",
  "browser_playbook_delete",
  "browser_playbook_match",
  "browser_playbook_run",
  "browser_playbook_propose_update",
```

- [ ] **Step 5: Run smoke**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _smoke.mjs
```
Expected: smoke passes; total tool count reports 48.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/src/tools.js server/_smoke.mjs && git commit -m "feat(tools): register 7 playbook tools (list/get/save/delete/match/run/propose_update)"
```

---

## Task 8: Wire contract tests for the 7 playbook tools

**Files:**
- Create: `server/_playbook_wire.test.mjs`

- [ ] **Step 1: Write the test**

Create `server/_playbook_wire.test.mjs`:
```js
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { initPlaybooks, savePlaybook } from "./src/playbooks.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-wire-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();
initToolsState({ log: () => {} });

const sent = [];
const bridge = {
  mode: "broker", isConnected: () => true, getLocalClientId: () => "mc",
  mcpClients: new Map(), extensionWs: {},
  send: async (type, params) => { sent.push({ type, params }); return { ok: true }; },
};

// save
let r = await handleToolCall(bridge, { name: "browser_playbook_save", arguments: {
  id: "example.com/login",
  meta: { origin: "example.com", feature: "login", verifiable: true, inputs: [{ name: "user", type: "text", required: true }], outputs: [] },
  body: "## Summary\nx\n## Preconditions\nx\n## Steps\nx\n## Verification\nx\n## Selectors used\n\n## Recent runs\n\n## Screenshots\n",
  workflow: { steps: [{ action: "navigate", url: "https://example.com/login" }] },
}});
let p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.ok(p.path.endsWith("login.md"));

// list
r = await handleToolCall(bridge, { name: "browser_playbook_list", arguments: { verifiable: true } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(p.items.length, 1);
assert.equal(p.items[0].id, "example.com/login");

// get
r = await handleToolCall(bridge, { name: "browser_playbook_get", arguments: { id: "example.com/login" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(p.meta.feature, "login");

// match
r = await handleToolCall(bridge, { name: "browser_playbook_match", arguments: { url: "https://example.com/login", taskText: "login" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.ok(p.matches.length >= 1);
assert.equal(p.matches[0].playbookId, "example.com/login");

// run (verifies wire payload generation)
sent.length = 0;
r = await handleToolCall(bridge, { name: "browser_playbook_run", arguments: { id: "example.com/login", inputs: { user: "test" } } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(sent[0].type, "navigate");
assert.equal(sent[0].params.url, "https://example.com/login");

// propose_update
r = await handleToolCall(bridge, { name: "browser_playbook_propose_update", arguments: {
  label: "signup",
  trace: [
    { tool: "browser_navigate", args: { url: "https://example.com/signup" } },
    { tool: "browser_type",     args: { intent: "email-field",    value: "a@b.com" } },
    { tool: "browser_click",    args: { intent: "submit-button" } },
  ],
}});
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);
assert.equal(p.created, true);
assert.equal(p.playbookId, "example.com/signup");

// delete
r = await handleToolCall(bridge, { name: "browser_playbook_delete", arguments: { id: "example.com/login" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, true);

// not-found
r = await handleToolCall(bridge, { name: "browser_playbook_get", arguments: { id: "missing.com/x" } });
p = JSON.parse(r.content[0].text);
assert.equal(p.ok, false);
assert.equal(p.error.code, "playbook-not-found");

console.log("✓ playbook wire contract");
await fs.rm(tmp, { recursive: true, force: true });
```

- [ ] **Step 2: Run test**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && node _playbook_wire.test.mjs
```
Expected: `✓ playbook wire contract`.

- [ ] **Step 3: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/_playbook_wire.test.mjs && git commit -m "test(playbooks): wire-contract tests for the 7 tools"
```

---

## Task 9: QA subagent + smart-router CLAUDE.md

**Files:**
- Create: `plugins/qa/agents/qa-tester.md`
- Create: `plugins/qa/CLAUDE.md`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Author the qa-tester agent**

Create `plugins/qa/agents/qa-tester.md`:
```markdown
---
name: qa-tester
description: Use when the task is a verifiable browser interaction with a binary pass/fail outcome — login flow, submit form, attach file, verify message appears. Returns a verdict + evidence. Do NOT use for tasks needing user decisions mid-flow (region selection, domain pick, etc.).
tools: [Bash, Read, Grep, Glob, mcp__plugin_mochi_browser__browser_session_start, mcp__plugin_mochi_browser__browser_session_end, mcp__plugin_mochi_browser__browser_navigate, mcp__plugin_mochi_browser__browser_open_tab, mcp__plugin_mochi_browser__browser_list_tabs, mcp__plugin_mochi_browser__browser_close_tab, mcp__plugin_mochi_browser__browser_snapshot, mcp__plugin_mochi_browser__browser_snapshot_query, mcp__plugin_mochi_browser__browser_snapshot_node, mcp__plugin_mochi_browser__browser_text, mcp__plugin_mochi_browser__browser_links, mcp__plugin_mochi_browser__browser_click, mcp__plugin_mochi_browser__browser_click_at, mcp__plugin_mochi_browser__browser_type, mcp__plugin_mochi_browser__browser_press_key, mcp__plugin_mochi_browser__browser_scroll, mcp__plugin_mochi_browser__browser_wait, mcp__plugin_mochi_browser__browser_screenshot, mcp__plugin_mochi_browser__browser_evaluate, mcp__plugin_mochi_browser__browser_assert, mcp__plugin_mochi_browser__browser_console_messages, mcp__plugin_mochi_browser__browser_network_requests, mcp__plugin_mochi_browser__browser_recall_selector, mcp__plugin_mochi_browser__browser_list_selectors, mcp__plugin_mochi_browser__browser_workflow_run, mcp__plugin_mochi_browser__browser_workflow_list, mcp__plugin_mochi_browser__browser_workflow_get, mcp__plugin_mochi_browser__browser_run_history, mcp__plugin_mochi_browser__browser_upload_stage, mcp__plugin_mochi_browser__browser_upload_file, mcp__plugin_mochi_browser__browser_playbook_list, mcp__plugin_mochi_browser__browser_playbook_get, mcp__plugin_mochi_browser__browser_playbook_save, mcp__plugin_mochi_browser__browser_playbook_match, mcp__plugin_mochi_browser__browser_playbook_run, mcp__plugin_mochi_browser__browser_playbook_propose_update, mcp__plugin_mochi_browser__browser_session_health]
---

# qa-tester

You are an isolated QA subagent. Your job is to execute a specific, verifiable browser interaction and report a verdict with evidence.

## What you can do

- Use any Mochi browser MCP tool listed in your tools allowlist.
- Read project files (Read, Grep, Glob) to find URLs, fixtures, env hints.
- Read playbooks from `.continuum/playbooks/` (via `browser_playbook_get`).
- Run read-only bash (status, ls, git log) — never destructive.

## What you cannot do

- Edit, Write, or modify project files (other than via `browser_playbook_save` and `browser_playbook_propose_update` for the playbook library, which lives under `.continuum/`).
- Ask the user questions. If a required input is missing, return `{ verdict: "blocked", reason: "missing input X" }`.
- Make scope-expanding decisions. Ambiguous task → return `{ verdict: "blocked", reason: "task ambiguous: …" }`.

## How to run a task

1. Parse the task: identify origin, feature, inputs.
2. Call `browser_playbook_match { url, intent, taskText }` to find a matching playbook.
3. If a verifiable playbook exists:
   - `browser_playbook_get` it.
   - `browser_playbook_run { id, inputs }`.
   - Use the playbook's `## Verification` section to confirm pass/fail.
4. If no playbook exists:
   - Use snapshot/click/type/upload tools manually.
   - On success, call `browser_playbook_propose_update { label, title, verifiable: true, trace }` to capture for next time.
5. Return one of:
   - `{ verdict: "pass",    evidence: { screenshots, network }, playbookId, runId }`
   - `{ verdict: "fail",    reason: "...", evidence: { ... }, playbookId, runId }`
   - `{ verdict: "blocked", reason: "..." }`

No prose narration. Main agent will surface to the user.
```

- [ ] **Step 2: Author the smart-router CLAUDE.md**

Create `plugins/qa/CLAUDE.md`:
```markdown
# Mochi QA — task routing

When the user asks you to do a browser interaction, FIRST classify:

**Verifiable + repeatable** (delegate to `qa-tester` subagent via the `Agent` tool with `subagent_type: "qa-tester"`):
- Has a binary pass/fail outcome ("does login work?", "verify the upload preview appears", "test the checkout flow").
- All inputs known up front (no mid-flow user decisions).
- Failure mode is clear (page didn't load, button missing, assertion failed).

**Operational + decisive** (stay in-line in this conversation):
- May require mid-flow user input ("which AWS region?", "which domain?", "review this draft?").
- Has side effects on real infrastructure or external accounts.
- Outcome isn't a clean pass/fail (you might need to backtrack and choose differently).

## Routing rules

1. Before any browser-leaning task, call `browser_playbook_match { url, intent, taskText }` to see if a playbook exists.
2. If a `verifiable: true` playbook matches AND the task fits the "verifiable + repeatable" bucket above → spawn `qa-tester` with the task + the playbook id.
3. If the task is operational, stay in-line:
   - Read the matching playbook (`browser_playbook_get`) before acting.
   - Follow the playbook's `## Steps` as guidance.
   - Ask the user for any missing inputs declared in `meta.inputs[]`.
   - After completing successfully, call `browser_playbook_propose_update` to grow the playbook from the trace.
4. If no playbook matches, proceed with manual snapshot/click/type. On success, call `browser_playbook_propose_update` to capture the flow.

## What goes in a playbook

Treat each `.continuum/playbooks/<origin>/<feature>.md` as a contract. Playbook frontmatter declares `inputs[]` with types — `email`, `text`, `markdown`, `file[]`, `secret`, etc. When you see `type: file[]` or `type: image` in inputs, the playbook needs files: call `browser_upload_stage` first to get a `stashId`, then pass it to `browser_upload_file` (or `browser_playbook_run` will plumb it via the `upload` step automatically).

Secrets (`type: secret`) are NEVER logged in traces or proposed playbook bodies. Resolve them from `process.env.<NAME_UPPERCASE>` at run time; never write the value into the playbook.
```

- [ ] **Step 3: Register in plugin.json**

Read `.claude-plugin/plugin.json` and add `agents`, append commands, and reference the QA CLAUDE.md. Replace the `commands` array and add `agents`:

```json
{
  "name": "mochi",
  "description": "A browser companion for AI assistants. Bundled MCP tools for Chrome automation, persistent project memory (Continuum chain), and an in-page hint modal — pair with the Mochi Chrome extension.",
  "version": "0.3.0",
  "author": {
    "name": "Jonayed Ahamed",
    "email": "dev.jonayed@gmail.com"
  },
  "homepage": "https://github.com/DevZonayed/Mochi",
  "keywords": ["browser", "automation", "qa", "testing", "memory", "continuum", "mcp", "chrome"],
  "commands": [
    "./plugins/continuum/commands/checkpoint.md",
    "./plugins/continuum/commands/dream.md",
    "./plugins/continuum/commands/feedback.md",
    "./plugins/continuum/commands/recall.md",
    "./plugins/continuum/commands/rename.md",
    "./plugins/continuum/commands/render.md",
    "./plugins/continuum/commands/status.md",
    "./plugins/qa/commands/qa.md",
    "./plugins/qa/commands/playbook.md",
    "./plugins/qa/commands/schedule-playbook.md",
    "./plugins/qa/commands/unschedule-playbook.md"
  ],
  "agents": [
    "./plugins/qa/agents/qa-tester.md"
  ],
  "hooks": "./plugins/continuum/hooks/hooks.json"
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add plugins/qa/agents/qa-tester.md plugins/qa/CLAUDE.md .claude-plugin/plugin.json && git commit -m "feat(qa): qa-tester subagent + smart-router CLAUDE.md"
```

---

## Task 10: Slash commands for `/qa`, `/mochi:playbook`, `/mochi:schedule-playbook`, `/mochi:unschedule-playbook`

**Files:**
- Create: `plugins/qa/commands/qa.md`
- Create: `plugins/qa/commands/playbook.md`
- Create: `plugins/qa/commands/schedule-playbook.md`
- Create: `plugins/qa/commands/unschedule-playbook.md`

- [ ] **Step 1: `/qa` slash command**

Create `plugins/qa/commands/qa.md`:
```markdown
---
description: Dispatch a verifiable browser task to the qa-tester subagent. Use for regression checks, smoke tests, and any task with a clean pass/fail outcome.
argument-hint: "<task description>"
allowed-tools: [Task]
---

Dispatch the `qa-tester` subagent with the user's task: $ARGUMENTS

Use the `Task` (Agent) tool with `subagent_type: "qa-tester"` and pass the user's task verbatim as the prompt. If the task is clearly ambiguous (no clean pass/fail outcome) explain why and ask the user to clarify before dispatching.

After the subagent returns its verdict, surface a short summary to the user:
- On `pass`: "✓ Task passed via playbook `<id>` (run `<id>`). Evidence: <screenshots/network summary>."
- On `fail`: "✗ Task failed: `<reason>`. Evidence: <…>. Suggest re-running with adjusted inputs."
- On `blocked`: "Cannot run as-is: `<reason>`. Need: <missing input or clarification>."
```

- [ ] **Step 2: `/mochi:playbook` aggregator command**

Create `plugins/qa/commands/playbook.md`:
```markdown
---
description: Manage Mochi playbooks (list, show, run, delete). Plays through the browser MCP tools.
argument-hint: "<verb> [args]"
allowed-tools: [Bash]
---

Parse `$ARGUMENTS` as a verb plus arguments:

- `list [--origin=…] [--tag=…] [--verifiable]` → call `browser_playbook_list` with the parsed filters; render as a markdown table.
- `show <id>` → call `browser_playbook_get`; render the meta + summary + steps to the user.
- `run <id> [--input.<name>=<value>] …` → call `browser_playbook_run` with parsed inputs; surface the verdict.
- `delete <id>` → call `browser_playbook_delete`; confirm.
- `match <task description>` → call `browser_playbook_match`; render top hits.

If no verb given, render help with these verbs and an example.
```

- [ ] **Step 3: `/mochi:schedule-playbook`**

Create `plugins/qa/commands/schedule-playbook.md`:
```markdown
---
description: Schedule a playbook to run on a recurring cron schedule. Uses the host environment's schedule skill.
argument-hint: "<playbook-id>"
allowed-tools: [Bash, Skill]
---

The user wants to schedule playbook `$ARGUMENTS` for recurring execution.

1. Call `browser_playbook_get` for the id. If `meta.cron` is absent or empty, report: "playbook `$ARGUMENTS` has no `cron:` field. Edit the playbook frontmatter to set one (e.g., `cron: '0 7 * * 1-5'` for weekdays at 7am)."
2. Otherwise, invoke the `schedule` skill (if available in this environment) to register a routine that runs `browser_playbook_run { id: "$ARGUMENTS", inputs: <playbook.schedule_inputs> }` on the given cron schedule. The routine output should be appended to `.continuum/playbooks/inbox/<schedule_inbox or default>/<runId>.md`.
3. If the `schedule` skill is not available in this environment, report: "scheduling unavailable in this env; please run the playbook manually via `/mochi:playbook run $ARGUMENTS`."
```

- [ ] **Step 4: `/mochi:unschedule-playbook`**

Create `plugins/qa/commands/unschedule-playbook.md`:
```markdown
---
description: Cancel a scheduled playbook routine.
argument-hint: "<playbook-id>"
allowed-tools: [Bash, Skill]
---

Cancel the scheduled routine for playbook `$ARGUMENTS`.

1. Use the `schedule` skill (if available) to find the routine that runs this playbook (typically named `mochi-playbook:$ARGUMENTS`) and delete it.
2. If no such routine exists, report: "no scheduled routine found for `$ARGUMENTS`."
```

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add plugins/qa/commands/ && git commit -m "feat(qa): slash commands — /qa, /mochi:playbook, schedule/unschedule"
```

---

## Task 11: Fixture HTTP server + 3 fixture pages

**Files:**
- Create: `server/_fixtures/playbooks/server.mjs`
- Create: `server/_fixtures/playbooks/pages/login-form.html`
- Create: `server/_fixtures/playbooks/pages/compose-form.html`
- Create: `server/_fixtures/playbooks/pages/multi-step-wizard.html`

- [ ] **Step 1: Create the fixture server**

Create `server/_fixtures/playbooks/server.mjs`:
```js
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startPlaybookFixtureServer() {
  const submissions = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && (req.url === "/submit" || req.url === "/upload")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      submissions.push({ url: req.url, contentType: req.headers["content-type"] || "", sizeBytes: body.length, ts: Date.now() });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/pages/")) {
      const p = path.join(__dirname, req.url);
      try { const data = await fs.readFile(p); res.writeHead(200, { "content-type": "text/html" }); res.end(data); }
      catch { res.writeHead(404); res.end("not found"); }
      return;
    }
    res.writeHead(404); res.end("?");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, submissions, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
```

- [ ] **Step 2: Login-form fixture**

Create `server/_fixtures/playbooks/pages/login-form.html`:
```html
<!doctype html><meta charset=utf-8><title>fixture: login</title>
<form id=form>
  <input id=user data-intent="username-field" placeholder=username>
  <input id=pass data-intent="password-field" type=password placeholder=password>
  <button id=submit data-intent="submit-button" type=button>Sign in</button>
</form>
<div id=status></div>
<script>
submit.onclick = async () => {
  const u = user.value, p = pass.value;
  if (!u || !p) { status.textContent = "missing"; return; }
  await fetch("/submit", { method: "POST", body: JSON.stringify({ u, p }) });
  status.textContent = "Welcome, " + u;
  status.dataset.success = "true";
};
</script>
```

- [ ] **Step 3: Compose-form fixture (covers upload step)**

Create `server/_fixtures/playbooks/pages/compose-form.html`:
```html
<!doctype html><meta charset=utf-8><title>fixture: compose</title>
<form id=form>
  <input id=to      data-intent="to-field"      placeholder=to>
  <input id=subject data-intent="subject-field" placeholder=subject>
  <textarea id=body data-intent="body-field"   placeholder=body></textarea>
  <input  id=file   data-intent="attach-field"  type=file style="display:none">
  <button id=attach data-intent="attach-button" type=button>Attach</button>
  <span   id=files></span>
  <button id=send   data-intent="send-button"   type=button>Send</button>
</form>
<div id=status></div>
<div id=preview></div>
<script>
attach.onclick = () => file.click();
file.onchange = () => {
  for (const f of file.files) { files.textContent += f.name + " "; const img = document.createElement("img"); img.src = URL.createObjectURL(f); preview.appendChild(img); }
};
send.onclick = async () => {
  const fd = new FormData();
  fd.append("to", to.value); fd.append("subject", subject.value); fd.append("body", body.value);
  for (const f of file.files) fd.append("file", f);
  await fetch("/upload", { method: "POST", body: fd });
  status.textContent = "Message sent.";
  status.dataset.success = "true";
};
</script>
```

- [ ] **Step 4: Multi-step wizard fixture (covers chain composition)**

Create `server/_fixtures/playbooks/pages/multi-step-wizard.html`:
```html
<!doctype html><meta charset=utf-8><title>fixture: wizard</title>
<div id=step1>
  <input id=name data-intent="name-field" placeholder=name>
  <button id=next1 data-intent="next-button" type=button>Next</button>
</div>
<div id=step2 style="display:none">
  <input id=email data-intent="email-field" placeholder=email>
  <button id=next2 data-intent="next-button" type=button>Next</button>
</div>
<div id=step3 style="display:none">
  <button id=finish data-intent="finish-button" type=button>Finish</button>
</div>
<div id=status></div>
<script>
next1.onclick = () => { if (!name.value) return; step1.style.display = "none"; step2.style.display = "block"; };
next2.onclick = () => { if (!email.value) return; step2.style.display = "none"; step3.style.display = "block"; };
finish.onclick = async () => { await fetch("/submit", { method: "POST", body: JSON.stringify({ name: name.value, email: email.value }) }); status.textContent = "Wizard complete."; status.dataset.success = "true"; };
</script>
```

- [ ] **Step 5: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/_fixtures/playbooks/ && git commit -m "test(fixtures): playbook fixture server + 3 pages (login, compose, wizard)"
```

---

## Task 12: End-to-end integration runner

**Files:**
- Create: `server/_playbook_e2e.mjs`
- Modify: `server/package.json` (add npm script)

- [ ] **Step 1: Write the e2e runner**

Create `server/_playbook_e2e.mjs`:
```js
// _playbook_e2e.mjs — exercise the playbook system end-to-end against
// real Chrome via the broker + the three playbook fixture pages.
// Skips cleanly if the extension is not connected.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { startPlaybookFixtureServer } from "./_fixtures/playbooks/server.mjs";
import { Bridge } from "./src/bridge.js";
import { handleToolCall, initToolsState } from "./src/tools.js";
import { initPlaybooks } from "./src/playbooks.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-pb-e2e-"));
process.env.MOCHI_PROJECT_DIR = tmp;
await initPlaybooks();
initToolsState({ log: () => {} });

const fix = await startPlaybookFixtureServer();
console.log("fixture server:", fix.port);

const bridge = new Bridge({ log: () => {} });
const role = await bridge.start({ port: 9009 });
if (!bridge.isConnected()) {
  console.log("SKIP playbook e2e: extension not connected");
  await fix.close(); await bridge.close?.();
  process.exit(0);
}

// 1. Promote a playbook from a synthetic login trace
const promoted = await handleToolCall(bridge, { name: "browser_playbook_propose_update", arguments: {
  label: "login",
  title: "Test login",
  verifiable: true,
  trace: [
    { tool: "browser_navigate", args: { url: `http://127.0.0.1:${fix.port}/pages/login-form.html` } },
    { tool: "browser_type",     args: { intent: "username-field", value: "${input.username}" } },
    { tool: "browser_type",     args: { intent: "password-field", value: "${input.password}" } },
    { tool: "browser_click",    args: { intent: "submit-button" } },
    { tool: "browser_assert",   args: { kind: "element-exists", value: { selector: "#status[data-success=true]" }, timeoutMs: 5000 } },
  ],
}});
const promotedJson = JSON.parse(promoted.content[0].text);
assert.equal(promotedJson.ok, true);
console.log("✓ promoted login playbook:", promotedJson.playbookId);

// 2. Run the playbook with explicit inputs
await bridge.send("session_start", { groupBy: "client" });
const runRaw = await handleToolCall(bridge, { name: "browser_playbook_run", arguments: { id: promotedJson.playbookId, inputs: { username: "alice", password: "secret" } } });
const run = JSON.parse(runRaw.content[0].text);
assert.equal(run.ok, true);
assert.equal(run.verdict, "pass", `expected pass, got: ${JSON.stringify(run)}`);
console.log("✓ played login playbook:", run.verdict);

// 3. Match — should find the playbook by URL
const matchRaw = await handleToolCall(bridge, { name: "browser_playbook_match", arguments: { url: `http://127.0.0.1:${fix.port}/pages/login-form.html`, taskText: "log in" } });
const match = JSON.parse(matchRaw.content[0].text);
assert.equal(match.ok, true);
assert.ok(match.matches.length >= 1, `expected ≥1 match, got ${JSON.stringify(match)}`);
console.log("✓ matched playbook");

// 4. Verify submissions on the fixture server
assert.ok(fix.submissions.length >= 1, "expected ≥1 fixture submission");

await bridge.send("session_end", {}).catch(() => {});
await fix.close();
await bridge.close?.();
await fs.rm(tmp, { recursive: true, force: true });
console.log("ALL PLAYBOOK E2E CHECKS PASSED");
```

- [ ] **Step 2: Add npm script**

In `server/package.json`, add to scripts:
```json
    "test:e2e:playbook": "node _playbook_e2e.mjs",
```

- [ ] **Step 3: Verify syntax**

```bash
node --check /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server/_playbook_e2e.mjs
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/_playbook_e2e.mjs server/package.json && git commit -m "test(playbooks): end-to-end runner against fixture pages"
```

---

## Task 13: Bump integration tool count + run full test suite

**Files:**
- Modify: `server/_integration.mjs`

- [ ] **Step 1: Bump expected tool count**

In `server/_integration.mjs`, find the assertion that checks total tool count (currently 41) and bump it to 48:

```bash
grep -n "41\|tools:" /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server/_integration.mjs | head -5
```
Edit the matching assertion to `48`.

- [ ] **Step 2: Run the full suite**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && npm test
```
Expected: all green — smoke, uploads, upload-wire, playbooks, playbook-wire, integration, multi-client.

- [ ] **Step 3: Commit**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/_integration.mjs && git commit -m "test(integration): bump tool count to 48 for playbook tools"
```

---

## Task 14: Rebuild bundle + update README

**Files:**
- Modify: `server/dist/server.bundle.mjs`
- Modify: `README.md`

- [ ] **Step 1: Rebuild bundle**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server && npm run build
```
Expected: rebuilds `dist/server.bundle.mjs` with no errors.

- [ ] **Step 2: Update README tool table**

In `README.md`, find the `## Tools (MCP)` section. Update the count to **48 tools** and add a new subsection after "File uploads":

```markdown
### Playbooks (personal ops memory)

| Tool | What it does |
|---|---|
| `browser_playbook_list` | List playbooks under `.continuum/playbooks/`, filter by origin/tag/verifiable. |
| `browser_playbook_get` | Return one playbook with meta + body sections + workflow JSON. |
| `browser_playbook_save` | Create/update a playbook (validates frontmatter and required sections). |
| `browser_playbook_delete` | Remove a playbook + workflow + screenshots. |
| `browser_playbook_match` | Score-match playbooks against a URL, intent, or task description. |
| `browser_playbook_run` | Replay a playbook (with self-heal) using provided inputs; recursively executes composes/next chains; returns verdict + evidence. |
| `browser_playbook_propose_update` | Given a successful trace, create or update the matching playbook. Inputs auto-inferred. |

Combined with the `qa-tester` subagent (registered via the plugin), the
playbook library is your **personal ops memory**: each browser task you do
once becomes replayable, chainable, and scheduleable. The smart-router
rule in `plugins/qa/CLAUDE.md` teaches the main agent when to delegate
(verifiable + repeatable) vs. stay in-line (operational + decisive).

See [`docs/superpowers/specs/2026-05-20-personal-ops-playbooks-design.md`](docs/superpowers/specs/2026-05-20-personal-ops-playbooks-design.md).
```

Also add four new slash commands to whatever section lists commands (if any) or note them inline:
- `/qa <task>` — dispatch the qa-tester subagent.
- `/mochi:playbook <verb> [args]` — list/show/run/delete/match playbooks.
- `/mochi:schedule-playbook <id>` — wire up cron via the host's schedule skill.
- `/mochi:unschedule-playbook <id>` — cancel the schedule.

- [ ] **Step 3: Commit bundle + README**

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester && git add server/dist/server.bundle.mjs server/dist/server.bundle.mjs.LEGAL.txt README.md && git commit -m "ci(server): rebuild bundle for playbook tools + README"
```

---

## Self-Review

### Spec coverage check

| Spec section | Implemented by task(s) |
|---|---|
| Sub-project 1: playbook format + CRUD | 1 (parse/serialize), 2 (validate), 3 (CRUD + index), 4 (match), 7 (tools) |
| Sub-project 2: QA subagent + smart router | 9 (agent + CLAUDE.md + plugin.json), 10 (commands) |
| Sub-project 3: Auto-learning | 5 (promoter), 7 (browser_playbook_propose_update) |
| Sub-project 4: Chains + scheduling | 6 (composeResolve), 7 (browser_playbook_run runs chains), 10 (schedule commands) |
| Wire/contract tests | 8 |
| Integration tests | 11 (fixtures), 12 (e2e) |
| Bundle rebuild + smoke + README | 13, 14 |

### Placeholder scan

- No "TBD", "TODO", or "implement later" in tasks.
- Self-heal → playbook update plumbing is *not* implemented as a separate task; instead, the playbook's "Recent runs" section is updated on every promote/run via `promoteFromTrace`. This is acceptable for v1: the heal events are already recorded by `memory.js` via `updateSelector` (which fires on `find_by_role_name` heal in `tools.js`), and the next `propose_update` call picks up the new selectors automatically. Documented as such; spec's acceptance criterion 7 is met because heals land in the selector cache and any subsequent `propose_update` snapshots them.
- Scheduling is delegated to the host environment's `schedule` skill rather than a custom cron daemon; this is explicit in the spec.

### Type consistency

- `playbookId` is consistently `<origin>/<feature>` across all tools, tests, and the agent.
- `meta.inputs[]` shape is `{ name, type, required?, ... }` everywhere.
- `verdict` is one of `"pass"|"fail"|"blocked"` everywhere.
- `playbookErr(code, message, details)` returns errors via the `playbookError` field on the Error instance, mirroring `uploadErr`'s pattern.
- Tool names match across schemas, dispatch, and tests.

---

## Acceptance verification (post-implementation)

1. `cd server && npm test` — all hand-rolled tests green.
2. `cd server && node _playbook_e2e.mjs` with extension loaded — fixtures pass; verdicts logged.
3. `tools/list` reports 48 tools total; the 7 new `browser_playbook_*` tools appear.
4. `/qa "test login on http://127.0.0.1:<port>/pages/login-form.html"` dispatches the subagent and returns a `pass` verdict.
5. `/mochi:playbook list` shows the auto-promoted playbook.
6. `.continuum/playbooks/index.json` survives a crash mid-write (atomic-rename test, covered by Task 3).
7. No regressions in existing tests (uploads, integration, multi-client).

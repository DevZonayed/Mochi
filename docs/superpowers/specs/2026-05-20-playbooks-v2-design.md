# Playbooks v2 — design spec (Sharing & Polish)

**Status:** Approved direction, ready for implementation plan.
**Date:** 2026-05-20
**Builds on:** v1 (`2026-05-20-personal-ops-playbooks-design.md`) and v1.5 (`2026-05-20-playbooks-v1-5-design.md`).
**Scope:** Five additive features grouped under one release:

1. **1Password CLI integration** — `${1password:...}` ref resolution via `op read`.
2. **Vue + SvelteKit codebase detection** — two new detectors in `codebase-seed.js`.
3. **Blocked verdict for missing inputs** — `browser_playbook_run` returns a clean `blocked` verdict + `needs[]` instead of throwing, so the main agent can prompt the user.
4. **Cross-project playbook bundles** — export a playbook (or set) to a single `.json` bundle, import elsewhere. Enables sharing canonical playbooks across teams / projects.
5. **Playbook HTML dashboard** — `/mochi:playbook ui` generates a self-contained dashboard from `.continuum/playbooks/index.json` and opens it in the browser. Recent runs, success rates, screenshots, drill-down.

**Out of scope (YAGNI'd):**
- Angular detection (too niche for the effort).
- OCR / perceptual visual diff (pixelmatch is good enough).
- OOPIF cross-origin iframe traversal in `browser_upload_file` (no real-world ask yet).
- Multi-tab playbooks for OAuth popups (deferred until needed).
- Bitwarden / Doppler / Vault / AWS Secrets Manager (1Password covers ~80% of users; add others on demand).

---

## Motivation

After v1.5 the system is daily-usable but three friction points remain for serious adoption:

1. **Real secrets live in 1Password, not env vars.** Hardcoding `${env:GMAIL_PASSWORD}` works for testing but isn't how real users manage credentials. 1Password CLI (`op`) is the de-facto standard and shells out cleanly.
2. **No way to share a playbook.** If you build a `gmail.com/send-email` playbook on one machine, it stays there. No sharing primitive means no community library, no team standardization.
3. **Playbook library is invisible.** All knowledge of what's been captured lives in `.continuum/playbooks/index.json` — readable only via tools. A small HTML dashboard makes the library tangible and turns it into a marketing/onboarding surface.

The other two items (Vue/SvelteKit detection, blocked verdict) are obvious extensions of v1.5 that didn't fit there.

---

## Sub-project 1 · 1Password CLI integration

### Ref syntax extension

`secrets.js`'s `resolveRef` gains a fourth form:

| Form | Resolves via |
|---|---|
| `${1password:vault/item/field}` | `op read "op://vault/item/field"` |
| `${op:vault/item/field}` | Shorthand alias |

Examples:
- `${1password:Personal/Gmail/password}` → reads the password field of "Gmail" in "Personal" vault.
- `${op:Work/AWS Console/access_key_id}` → same form, shorter.

### Resolution mechanics

`secrets.resolveRef` synchronously invokes `op read "op://<path>"`. If `op` is not on PATH, returns `null` (treated same as missing). If `op` is signed in (session token in env), the read succeeds. Otherwise `op` exits non-zero and we return `null`.

```js
function resolveOpRef(path) {
  if (!hasCommand("op")) return null;
  try {
    const out = execSync(`op read "op://${path}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return out.replace(/\r?\n$/, "");
  } catch { return null; }
}
```

The `op read` operation is **read-only** — no credentials cached, no values logged. `op` itself handles session lifetime (typically 30 min via `OP_SESSION_*` env vars or the desktop integration).

### `listAvailableSecrets` extension

When `op` is available, `listAvailableSecrets()` also returns:
```js
{ name: "vault/item/field", source: "1password", available: true }
```

We don't enumerate every 1Password item (that would require `op item list` which is slow and credential-revealing). Instead we list the unique refs found in `.continuum/playbooks/**/*.md` frontmatter that use the `${1password:...}` form, then call `op read` on each to test availability. Cached per process for 60s.

### `browser_playbook_secret_check` integration

Already exists; the new ref form is detected by the existing inner-parser:
```js
const ci = inner.indexOf(":");
const kind = inner.slice(0, ci).trim();
if (kind === "1password" || kind === "op") return { available: opAvailableNow(), source: "1password", hint: opAvailableNow() ? null : "install 1Password CLI + sign in (op signin)" };
```

### Bundle impact

Zero deps added. `op` is shelled out via `child_process.execSync`. We add no library code beyond ~30 lines of branches in `secrets.js`.

---

## Sub-project 2 · Vue + SvelteKit codebase detection

### Detector chain extension

`detectFramework()` (in `codebase-seed.js`) gains two new detectors, slotted before `vite-react`:

| Detector | Triggered by | Output |
|---|---|---|
| `nuxt` | `nuxt.config.{js,ts}` OR `nuxt` in `package.json` dependencies | Pages from `pages/**/*.vue` (Nuxt 3) |
| `sveltekit` | `svelte.config.{js,ts}` AND `@sveltejs/kit` in `package.json` | Routes from `src/routes/**/+page.svelte` |

### Vue parsing

Vue Single-File Components have three top-level blocks: `<template>`, `<script>`, `<style>`. We extract the `<template>` block via regex (`/<template[^>]*>([\s\S]*?)<\/template>/`), then parse it as HTML via a lightweight built-in tokenizer:

```js
function extractVueTemplate(source) {
  const m = /<template[^>]*>([\s\S]*?)<\/template>/.exec(source);
  return m ? m[1] : null;
}
function parseVueTemplate(html) {
  // Returns [{ tag, attrs: {name: value}, isSelfClosing }, ...]
  // Just enough to find <input>, <button>, <form>.
}
```

For attrs, we recognize the Vue-specific shorthand:
- `:name="foo"` (v-bind shorthand) — treated as attribute `name` with dynamic value (placeholder)
- `v-model="foo"` — treated as 2-way binding; field name = the variable
- `@click="onSubmit"` — treated as click handler

This is a heuristic parser. It misses fancy directives but handles 80% of forms.

### SvelteKit parsing

Svelte components have `<script>`, `<style>`, and HTML at the top level. Forms are typically:
```svelte
<form on:submit={handler}>
  <input bind:value={email} name="email" type="email" />
  <button type="submit">Sign in</button>
</form>
```

Same template extraction approach. Attribute shorthand:
- `bind:value={x}` — 2-way binding; field name = `x`
- `on:click={fn}` — click handler

### Common output

Both produce the same `field` shape (`{tag, type, name, id, aria, testid, placeholder, accept}`) as the React extractor. The rest of `buildDraftFromFile` is reused untouched.

### Slugging

- Nuxt: `pages/login.vue` → `/login` → slug `login`. `pages/users/[id].vue` → strip dynamic → `users`. `pages/dashboard/settings.vue` → `dashboard-settings`.
- SvelteKit: `src/routes/login/+page.svelte` → `/login` → `login`. `src/routes/dashboard/settings/+page.svelte` → `dashboard-settings`. Route groups `(auth)` ignored.

### Fixture additions

Three new fixtures under `server/_fixtures/codebase/`:
- `nuxt-app/nuxt.config.ts`, `nuxt-app/pages/login.vue`
- `svelte-app/svelte.config.js`, `svelte-app/src/routes/login/+page.svelte`

Tests assert each detector triggers, drafts are produced, password fields auto-typed as `secret`.

---

## Sub-project 3 · Blocked verdict for missing inputs

### Behavior change

Currently `browser_playbook_run` throws `playbook-input-missing` when a required `type: secret` input has no resolvable ref. The throw propagates as an error response to the MCP client.

New behavior: on missing required inputs, the tool returns a **structured `blocked` verdict** that the main agent can handle conversationally:

```json
{
  "ok": true,
  "verdict": "blocked",
  "reason": "missing-required-inputs",
  "needs": [
    { "name": "password", "type": "secret", "ref": "${1password:Personal/Gmail/password}", "source": "1password", "hint": "Sign in to 1Password CLI: `op signin`" },
    { "name": "to",       "type": "email",  "ref": null,                                    "source": null,        "hint": "Pass via inputs.to" }
  ],
  "runId": null
}
```

The main agent reads `needs[]` and can:
- For env-based refs: instruct the user to set the env var.
- For 1password refs: instruct the user to sign in to `op` or check the vault/item path.
- For unrefed inputs: ask the user for the value directly.

After the user provides what's needed, the agent re-invokes `browser_playbook_run` with the now-resolvable inputs.

### Implementation footprint

`playbooks.js`:`resolveRunInputs` already throws on missing required. Refactor it to **return** `{ resolved, missing }` and let the caller decide:

```js
export async function resolveRunInputs(playbookId, callerInputs) {
  const pb = await getPlaybook(playbookId);
  if (!pb) throw playbookErr("playbook-not-found", `no playbook ${playbookId}`);
  await secrets.initSecrets();
  const { resolved, missing } = secrets.resolveInputs(pb, callerInputs);
  return { playbook: pb, resolved, missing, secretValues: extractSecretValues(pb, resolved) };
}
```

Then `toolPlaybookRun` checks `missing.length`:
```js
if (missing.length > 0) {
  const needs = missing.map((m) => annotateNeed(m, pb));
  return { ok: true, verdict: "blocked", reason: "missing-required-inputs", needs, runId: null };
}
```

`annotateNeed` adds `hint` per ref kind.

### Smart-router CLAUDE.md update

`plugins/qa/CLAUDE.md` gets a new section:

```markdown
## Handling `blocked` verdicts

If `browser_playbook_run` returns `verdict: "blocked"`, look at `needs[]`:
- For each missing input, do NOT call the tool again until you have the value.
- If `source: "env"` — tell the user the env var to set, then wait for confirmation.
- If `source: "1password"` — check if `op` is signed in; if not, tell the user to run `op signin` (and `op signin --account=<acct>` if multi-account).
- If `source: null` — ask the user for the value directly.
- Then re-invoke `browser_playbook_run` with the now-resolved values passed in `inputs`.
```

### Backwards compat

`browser_playbook_secret_check` already returns structured availability. No change to its API. The change is purely in `_run`'s error path → result path.

---

## Sub-project 4 · Cross-project playbook bundles

### Bundle format

A bundle is a single JSON file with version + manifest + embedded files:

```json
{
  "schema": "mochi-playbook-bundle@1",
  "exportedAt": "2026-05-20T12:00:00Z",
  "exportedBy": "mochi 0.4.0",
  "manifest": [
    { "id": "mail.google.com/send-email", "version": 3, "verifiable": true, "tags": ["email"] }
  ],
  "playbooks": [
    {
      "id": "mail.google.com/send-email",
      "markdown": "---\norigin: mail.google.com\n...\n",
      "workflow": { "playbookId": "mail.google.com/send-email", "schemaVersion": 1, "steps": [...] },
      "screenshots": {
        "step-02.png": "<base64>",
        "step-05.png": "<base64>"
      }
    }
  ]
}
```

Why JSON not zip:
- Single file, no archive parser needed.
- Human-readable headers (manifest visible without decoding).
- Trivial to publish (gist, GitHub repo, slack DM, email attachment).
- Screenshots base64'd inline keeps everything in one artifact.

Trade-off: bundle size doubles vs binary zip. Acceptable for typical playbook sets (<1 MB).

### Export

New tool `browser_playbook_export`:
```json
{
  "name": "browser_playbook_export",
  "inputSchema": {
    "type": "object",
    "properties": {
      "ids":          { "type": "array", "items": { "type": "string" }, "description": "Specific playbook ids; omit for all." },
      "origin":       { "type": "string", "description": "Export all playbooks under this origin." },
      "tag":          { "type": "string", "description": "Export all playbooks tagged with this." },
      "outputPath":   { "type": "string", "description": "Where to write the bundle file; defaults to .continuum/playbooks/exports/<ts>.json." },
      "stripSecrets": { "type": "boolean", "default": true, "description": "Remove `ref:` fields from frontmatter (defense-in-depth — refs are already non-secret pointers, but stripping makes shareable bundles totally inert)." }
    }
  }
}
```

Returns:
```json
{
  "ok": true,
  "bundlePath": "/abs/.continuum/playbooks/exports/2026-05-20T120000.json",
  "playbookCount": 3,
  "sizeBytes": 184523
}
```

### Import

New tool `browser_playbook_import`:
```json
{
  "name": "browser_playbook_import",
  "inputSchema": {
    "type": "object",
    "properties": {
      "bundlePath":      { "type": "string", "description": "Path to a previously exported bundle JSON." },
      "bundleJson":      { "type": "string", "description": "Or the bundle content inline (for piping)." },
      "url":             { "type": "string", "description": "Or fetch the bundle from this URL (https only)." },
      "overwrite":       { "type": "boolean", "default": false, "description": "If true, replace existing playbooks with same id; if false, skip them." },
      "rewriteOrigin":   { "type": "string", "description": "Optionally rewrite all playbook origins to this hostname (useful when sharing across staging vs prod)." }
    }
  }
}
```

Returns:
```json
{
  "ok": true,
  "imported":      ["mail.google.com/send-email"],
  "skipped":       [{ "id": "twitter.com/post", "reason": "already-exists" }],
  "rewrittenFrom": "staging.example.com",
  "rewrittenTo":   "production.example.com"
}
```

### Security

- **No code execution.** Bundles contain only data (markdown, JSON, base64 PNGs). The importer validates each playbook through the existing `validatePlaybook` before saving.
- **Bundle URL fetcher** uses the existing `undici` (already in deps from `uploads.js`). Refuses `file://`, applies the same private-network guard as `browser_upload_stage`.
- **Origin rewrite is opt-in.** Without `rewriteOrigin`, a bundle's `mail.google.com/send-email` lands at the same id locally. Users can't accidentally remap to their domain without intent.
- **Bundle import dry-run:** `--dry-run` flag returns the manifest + diff (what would land, what would be skipped) without writing. Not in v2 input schema; users can read the bundle file directly to inspect — it's just JSON.

### Slash commands

Added to the `/mochi:playbook` aggregator:
- `/mochi:playbook export [--ids=<ids>] [--origin=<host>] [--tag=<tag>] [--out=<path>]`
- `/mochi:playbook import <path-or-url> [--overwrite] [--rewrite-origin=<host>]`

---

## Sub-project 5 · Playbook HTML dashboard

### `/mochi:playbook ui`

New verb in the aggregator. Behavior:
1. Reads `.continuum/playbooks/index.json` + walks `.continuum/playbooks/**` to gather meta + recent run logs + screenshots.
2. Generates a single self-contained `.continuum/playbooks/ui/index.html` with embedded CSS + a tiny JS for interactivity (no build step, no external deps).
3. Opens it in the browser via `browser_navigate({ url: "file://<abs path>" })`.

The dashboard is regenerated on every invocation — fast (just templating from JSON).

### Dashboard layout

```
┌─ Mochi Playbooks ────────────────────────────────────────────┐
│ Search [_____________________]  Tags: [email] [auth] [...]   │
│                                                              │
│ ┌────────────────────────────────────────────────────────┐   │
│ │ mail.google.com / send-email                  ★ 14 runs│   │
│ │ Send an email via Gmail web    last: 2 hours ago • PASS│   │
│ │ inputs: to, subject, body, attachments                 │   │
│ │ [verifiable] [visual-refs:3]              [Open ▾]     │   │
│ └────────────────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────────────────┐   │
│ │ twitter.com / post                            ★ 8 runs │   │
│ │ Post a tweet                  last: yesterday • PASS   │   │
│ │ inputs: text, media                                    │   │
│ │ [draft]                                  [Open ▾]      │   │
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ Footer: 14 playbooks · 7 verifiable · 3 drafts · 47 runs     │
└──────────────────────────────────────────────────────────────┘
```

Each row expands inline (no client-side routing) to show:
- Summary + preconditions text from the markdown body
- Step list
- Recent runs table (last 10)
- Step screenshots (clickable to enlarge)
- "Copy `browser_playbook_run` JSON" button (puts the invocation in clipboard)

Search filters by id/title/inputs. Tag chips toggle filters.

### Implementation

New module `server/src/playbook-dashboard.js`:
```js
export async function generateDashboard({ outputPath } = {})
// Reads playbooks, screenshots (base64 inline), renders HTML, writes to outputPath.
// Returns { ok: true, path: outputPath, playbookCount, totalSizeBytes }
```

The template is a single ES-string concatenation — no template engine. Embedded CSS is ~200 lines, JS ~80 lines. Total dashboard HTML ~80–200KB depending on screenshots.

### New tool

```json
{
  "name": "browser_playbook_dashboard",
  "inputSchema": {
    "type": "object",
    "properties": {
      "outputPath": { "type": "string", "description": "Defaults to .continuum/playbooks/ui/index.html." },
      "open":       { "type": "boolean", "default": true, "description": "Open in browser after generating." }
    }
  }
}
```

Returns `{ ok: true, path, playbookCount, totalSizeBytes }`.

When `open: true` AND there's an active browser session, the tool calls `bridge.send("navigate", { url: "file://" + outputPath })` to open it. If no session, returns the path and the user navigates manually.

---

## Errors

| Code | Where |
|---|---|
| `secret-ref-1password-unavailable` | `secrets.js` (when `op` is missing AND a `${1password:...}` ref is required) |
| `bundle-validation-failed` | `playbook-bundles.js` (malformed bundle JSON) |
| `bundle-schema-mismatch` | bundle schema field unexpected (e.g. user passed a non-bundle JSON) |
| `bundle-fetch-failed` | URL import failed (HTTP error, timeout) |
| `bundle-playbook-validation-failed` | one of the bundled playbooks fails `validatePlaybook` on import |
| `bundle-conflict` | overwrite=false and playbook already exists (returned per-id in `skipped[]`, not a hard error) |
| `dashboard-write-failed` | filesystem error writing the HTML |
| `dashboard-no-playbooks` | nothing to render; UI still generates (empty state), no error |

---

## Testing

### Unit

- `_secrets.test.mjs` extension:
  - `${1password:vault/item/field}` syntax accepted.
  - `${op:...}` alias works.
  - When `op` not installed → returns `null` and `listAvailableSecrets` doesn't include 1password entries.
  - When `op` exits non-zero → returns `null`.
  - Stub `execSync` via `secrets.__setExecForTesting(fn)` test hook.

- `_codebase_seed.test.mjs` extension:
  - Nuxt fixture → detected as `nuxt`, drafts produced, password fields auto-typed.
  - SvelteKit fixture → detected as `sveltekit`, drafts produced.
  - Vue template attributes extracted (`bind:value`, `v-model`, `name`).

- `_playbook_bundles.test.mjs` (new):
  - Export → returns bundle JSON with manifest + playbooks + screenshots base64.
  - Import → restores playbooks + screenshots; index updated.
  - Round-trip: export → import in fresh dir → playbook identical.
  - Overwrite vs skip behavior.
  - `rewriteOrigin` flips id correctly.
  - Bad schema → `bundle-schema-mismatch`.

- `_playbook_dashboard.test.mjs` (new):
  - Empty library → renders empty HTML; valid `<!doctype html>`.
  - Library with 2 playbooks → HTML contains both ids.
  - Screenshots base64-embedded in HTML.

- `_playbooks.test.mjs` extension:
  - `resolveRunInputs` returns `{missing}` instead of throwing.
  - Blocked-verdict integration covered in wire test.

### Wire

Extend `_playbook_wire.test.mjs`:
- `browser_playbook_run` with a playbook requiring a missing secret → `verdict: "blocked"`, `needs[]` populated.
- `browser_playbook_export` writes a bundle file.
- `browser_playbook_import` restores in a fresh dir.
- `browser_playbook_dashboard` writes HTML with `open: false` (to avoid needing a real browser).

### Smoke

Bump expected tool count: **51 → 54** (+3 tools: `export`, `import`, `dashboard`). `browser_playbook_secret_check` already exists from v1.5; the 1password ref extension is invisible to the tool list.

---

## Acceptance criteria

1. `secrets.resolveRef("${1password:vault/item/field}")` returns the value when `op` is installed + signed in (mocked in unit tests).
2. Nuxt fixture seeds at least one draft playbook with `email` auto-typed.
3. SvelteKit fixture seeds at least one draft.
4. `browser_playbook_run` against a playbook with a required-but-unresolvable secret returns `verdict: "blocked"` with `needs[]`; does NOT throw.
5. Export → import round-trip preserves a playbook byte-identically (verified by serialized comparison).
6. `browser_playbook_dashboard` writes a valid self-contained HTML file ≤500KB for a 10-playbook library with 5 screenshots each.
7. Total tool count 54; smoke green; no regressions.
8. Bundle rebuilds; v2 stays under 4 MB.

---

## Out of scope (post-v2)

- Bitwarden, AWS Secrets Manager, Doppler, Vault integrations.
- Angular framework detector.
- Perceptual/OCR visual diff.
- Cross-origin iframe (OOPIF) traversal in upload.
- Multi-tab playbooks for OAuth popups.
- A "marketplace" of published playbook bundles with discovery + ratings.
- Continuous regression mode (auto-rerun playbooks on git commit).

---

## Open threads

- **Op CLI session vs desktop integration:** on macOS, the 1Password desktop app provides session tokens automatically. On Linux/CI, users must `op signin` interactively. Our docs note both paths.
- **Bundle JSON size:** for ~20 playbooks with screenshots, expect ~5 MB. Not zipped. If size becomes a real problem, add gzip-base64 (still single-file).
- **Dashboard auto-open with `file://`:** Chrome 116+ blocks some `file://` features. The dashboard is read-only HTML with no `fetch()`, so it works fine. Noted in README.
- **Dashboard refresh on file change:** v2 regenerates on demand only. A future enhancement: file-watch and live-reload.

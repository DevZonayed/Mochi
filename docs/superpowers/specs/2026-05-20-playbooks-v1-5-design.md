# Playbooks v1.5 — design spec

**Status:** Approved direction, ready for implementation plan.
**Date:** 2026-05-20
**Builds on:** `docs/superpowers/specs/2026-05-20-personal-ops-playbooks-design.md`
**Scope:** Three independently-shippable additions to the playbook system:
1. **Secrets store** — typed `secret` inputs resolved from env / file at runtime, never logged or promoted into playbook bodies.
2. **Codebase-derived seeding** — static analyzer over the project's frontend that emits draft playbooks per route + form, solving the cold-start problem for in-house apps.
3. **Visual diff regression** — per-step screenshot capture + pixelmatch comparison against the playbook's reference shot; flag drift, block on hard breakage.

YAGNI choices for v1.5 (defer to later if needed):
- Secrets: env-var + plaintext file resolution only. 1Password / Bitwarden / cloud secret managers deferred to v2.
- Codebase seeding: Next.js (App Router + Pages Router) + generic Vite/CRA. Vue / Svelte / Angular deferred.
- Visual diff: pixelmatch with PNG-only references; no perceptual / OCR comparison.

---

## Motivation

After v1 shipped, three concrete gaps block daily use:

1. **Login flows can't be safely captured.** When the agent records "type password into field," the trace contains the literal password. v1's promoter would write it into the playbook body. Until secrets are *typed* and resolved at runtime, no real login playbook is safe to commit.
2. **Cold-start on in-house apps is slow.** Every project's UI is unfamiliar to the agent. It has to explore selectors, find form fields, and figure out routes by clicking around. The agent's own *codebase* contains exactly the answers — routes, form components, `data-testid`s — they just need extraction.
3. **Selector self-heal hides UX regressions.** When a button's label or position changes but the selector still matches, v1 happily replays. But the *user* might be looking at a broken page (icon gone, form overflows, dialog cut off). Visual diff is a cheap-to-add early-warning signal.

All three are additive to the playbook format — no breaking changes to v1 playbooks.

---

## Architecture overview

```
┌─ Playbook YAML frontmatter ─────────────────────────────────┐
│  inputs:                                                    │
│    - { name: password, type: secret, ref: "${env:GMAIL_PW}" } # NEW (sp1)
│  outputs: [...]                                             │
│  visual_refs:                                               │
│    - { step: 2, sha: "8a91…", ref: "send-email.shots/02.png" } # NEW (sp3)
└─────────────────────────────────────────────────────────────┘
                    ▲                              ▲
                    │ resolved at runtime           │ compared per step
                    │                              │
┌─ server/src/secrets.js (sp1) ────┐  ┌─ server/src/visual-diff.js (sp3) ─┐
│  resolve(ref) → value             │  │  compareSteps(actual, ref)        │
│  scrub(trace) → trace             │  │  acceptStep(playbookId, step)     │
│  validate(playbook) → missing[]   │  │  thresholds: warn 5% / fail 20%   │
└───────────────────────────────────┘  └───────────────────────────────────┘
                    ▲                              ▲
                    └──────────┬───────────────────┘
                               │ used by browser_playbook_run
                               │
              ┌─ server/src/playbooks.js ─┐
              │  runWorkflowStep:         │
              │   - resolve secrets       │
              │   - capture screenshot    │
              │   - diff vs ref           │
              │   - scrub traces          │
              └───────────────────────────┘
                               ▲
                               │ codebase-derived drafts feed in here
                               │ as new files under .continuum/playbooks/<project-domain>/
              ┌─ server/src/codebase-seed.js (sp2) ─┐
              │  scanProject(root) → [draft]        │
              │   - detect framework (next/vite/cra)│
              │   - enumerate routes                │
              │   - find form components            │
              │   - extract testids/aria-labels     │
              │   - emit playbook_version: 0 drafts │
              └─────────────────────────────────────┘
```

---

## Sub-project 1 · Secrets store

### Frontmatter extension

`inputs[]` already supports `type: secret`. v1.5 adds an optional `ref` field:

```yaml
inputs:
  - { name: password, type: secret, required: true, ref: "${env:GMAIL_PASSWORD}" }
  - { name: api_key,  type: secret, required: true, ref: "${secret:gmail-api-key}" }
```

If `ref` is absent, the secret must be supplied at run-time via the caller's `inputs` map (as before).
If `ref` is present, the resolver runs `at start of replay` and provides the value — `inputs.password` is never written explicitly by the caller.

### Reference syntax

| Form | Resolves via |
|---|---|
| `${env:VAR_NAME}` | `process.env.VAR_NAME` |
| `${secret:NAME}` | Contents of `.continuum/secrets/<NAME>.txt`, trimmed of trailing newline |
| `${ENV_VAR}` (bare) | `process.env.ENV_VAR` (shorthand for the env form when name is all-uppercase) |

Multiple refs in one string are *not* supported (would invite leakage). One ref per input value. Whitespace inside `${…}` is stripped.

### `.continuum/secrets/` layout

```
.continuum/
  secrets/
    gmail-api-key.txt      # 0600 perms; gitignored
    aws-access-key.txt
    .gitignore             # contains `*` so nothing is ever staged
```

Created on first `secrets.read()` call. The `.gitignore` is written automatically with content `*\n!.gitignore` to keep itself in the index but exclude everything else.

### `server/src/secrets.js` API

```js
export function resolveRef(ref)               // -> string | null; throws on syntax error
export function resolveInputs(playbook, inputs) // -> { resolved: {...}, missing: [...] }
export function scrubTrace(trace, secrets)    // -> trace with secret values replaced by `[REDACTED:name]`
export function validatePlaybook(playbook)    // -> { ok: bool, missing: [{name, ref}] }
export function listAvailableSecrets()        // -> [name, ...] (env vars and file names; values never returned)
```

### Integration with `playbooks.js`

`runWorkflowStep` (existing) gets a small wrapper:
1. Before each step, resolve any `valueRef` ending in a secret-typed input via `secrets.resolveRef`.
2. The resolved value is passed to `bridge.send` but never written to the trace stored under `.continuum/runs/`.
3. The trace as written replaces secret values with `[REDACTED:<name>]`.

`promoteFromTrace` (existing) gets a scrubber pre-pass:
1. Walk inputs. Any input marked `type: secret` has its value replaced with `[REDACTED]` before writing the playbook body.
2. If the trace contains literal values that *also* appear in `listAvailableSecrets()` env vars, scrub those too (defensive — catches the case where a user typed a password value directly into a `text` field by mistake).

### New tool: `browser_playbook_secret_check`

```json
{
  "name": "browser_playbook_secret_check",
  "inputSchema": {
    "type": "object",
    "properties": { "id": { "type": "string" } },
    "required": ["id"]
  }
}
```

Returns:
```json
{
  "ok": true,
  "id": "mail.google.com/send-email",
  "secrets": [
    { "name": "password", "ref": "${env:GMAIL_PASSWORD}", "available": true,  "source": "env" },
    { "name": "api_key",  "ref": "${secret:gmail-api-key}", "available": false, "source": "secret-file", "hint": "create .continuum/secrets/gmail-api-key.txt" }
  ]
}
```

This lets `/qa <task>` pre-flight the secrets before dispatching. Never returns the values.

### Security guarantees

- Secret values are never written to:
  - `.continuum/runs/<id>.jsonl` (scrubbed by `scrubTrace`)
  - `.continuum/playbooks/<origin>/<feature>.md` (scrubbed by promoter)
  - `.continuum/uploads/log.jsonl` (no change needed; that log only stores file metadata)
  - `.continuum/playbooks/inbox/` reports (scrubbed by report writer)
- `.continuum/secrets/` is `chmod 0700` on the directory (best-effort; warn on Windows where permissions are weaker), files `chmod 0600`.
- The auto-generated `.gitignore` inside `secrets/` prevents accidental commits.
- `browser_playbook_secret_check` returns *availability*, not values.
- The QA subagent's tools allowlist already excludes `Read` of arbitrary files — it can't read secret files directly. Resolution happens entirely server-side.

---

## Sub-project 2 · Codebase-derived seeding

### Detector chain

A single entry point: `seedFromCodebase({ projectRoot, domain, dryRun })` returns an array of draft playbooks. It runs detectors in order; the first match wins.

| Detector | Triggered by | Output |
|---|---|---|
| `next-app-router` | `app/` dir + `next.config.{js,mjs,ts}` | Routes from `app/**/page.tsx`, form components from `app/**/*.tsx` |
| `next-pages-router` | `pages/` dir + `next.config.{js,mjs,ts}` (no `app/`) | Routes from `pages/**/*.tsx` excluding `_*.tsx` |
| `vite-react` | `vite.config.{js,ts}` + `*.jsx/*.tsx` files | Routes from `<Route>` JSX scans (best-effort), forms from same |
| `cra` | `react-scripts` in `package.json` | Same as vite-react |
| `none` | No frontend detected | Returns empty; logs a hint |

`domain` is required (e.g., `app.localhost:3000` or `staging.acme.com`); used as the playbook's `origin`. If omitted, defaults to `localhost:3000`.

### Route → draft playbook mapping

For each detected route file:

1. **Parse the file** as TS/JS using `@babel/parser` (already a transitive dep via esbuild, but pin explicitly).
2. **Walk the AST** looking for:
   - `<form>` elements (HTML JSX) or `<Form>` components (heuristic: any imported component named `Form` or `*Form`)
   - `<input>`, `<textarea>`, `<select>` elements with `id`, `name`, `aria-label`, `data-testid`, or `placeholder` attributes
   - `<button>` elements (especially `type="submit"` or text content like "Submit", "Save", "Send")
   - Server actions (`'use server'`) or `onSubmit` handlers — signals what the form does
3. **Synthesize a feature slug** from the route path:
   - `/login` → `login`
   - `/dashboard/settings` → `dashboard-settings`
   - `/users/[id]/edit` → `users-edit` (parameter stripped)
4. **Generate inputs** from form fields:
   - `<input type="email">` → `{ name: email, type: email, required: true }`
   - `<input type="password">` → `{ name: password, type: secret, required: true }` (auto-typed!)
   - `<input type="file" accept="image/*">` → `{ name: file, type: image }`
   - Other → `{ name: <id|name|kebab(aria-label)>, type: text }`
5. **Generate steps** as a best-effort guess:
   - `Navigate to ${baseUrl}/<route>`
   - For each input: `Type \${input.<name>} into intent <slug>-field`
   - `Click intent submit-button`
6. **Mark as draft**: `playbook_version: 0`, `verifiable: false`, `last_verified: null`, body's `## Summary` says "Draft — generated from <source-file>:<line>. Verify by running the playbook."

### New tool: `browser_playbook_seed_from_codebase`

```json
{
  "name": "browser_playbook_seed_from_codebase",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectRoot": { "type": "string", "description": "Absolute path to project root (defaults to MOCHI_PROJECT_DIR)." },
      "domain":      { "type": "string", "description": "Origin to assign to generated playbooks (e.g. 'app.localhost:3000')." },
      "dryRun":      { "type": "boolean", "description": "If true, return drafts without writing them." }
    }
  }
}
```

Returns:
```json
{
  "ok": true,
  "framework": "next-app-router",
  "drafts": [
    { "id": "app.localhost:3000/login",            "source": "app/login/page.tsx:5",       "inputs": 2, "steps": 4 },
    { "id": "app.localhost:3000/dashboard-settings","source": "app/dashboard/settings/page.tsx:42", "inputs": 6, "steps": 8 }
  ],
  "written": 2,
  "skipped": 0,
  "warnings": []
}
```

### Slash command

`/mochi:playbook seed [--domain=<url>] [--dry-run]` — thin wrapper around the tool. Added to the existing `/mochi:playbook` aggregator (sp1-v1's `plugins/qa/commands/playbook.md`).

### Conflict handling

If a non-draft playbook already exists for the same id (i.e. the agent learned it the hard way), seeding **does not overwrite**. The draft is skipped, written to `warnings[]`, and the user can manually merge.

If a draft (playbook_version: 0) exists, seeding refreshes it.

### Limitations stated up-front in the README

- Best-effort heuristics. Drafts are starting points, not ground truth.
- Multi-file routing (layouts, nested routes) isn't fully resolved.
- Custom form libraries (react-hook-form, formik) with abstracted field components may miss field inference.

---

## Sub-project 3 · Visual diff regression

### Per-step screenshot capture

`browser_playbook_run` (existing) gets a new param `captureScreenshots` (default `true` for `verifiable: true` playbooks, `false` otherwise). When `true`:

1. After each step that mutates the DOM (click, type, upload, scroll, wait), take a viewport screenshot via the existing `browser_screenshot` wire op.
2. Write to `.continuum/runs/<runId>/step-NN.png` (PNG).
3. If the playbook has a `visual_refs[]` entry for step N, compare via pixelmatch.

### Frontmatter

```yaml
visual_refs:
  - { step: 2,  sha: "8a91d2f1", path: "send-email.screenshots/step-02.png" }
  - { step: 5,  sha: "c01a3b87", path: "send-email.screenshots/step-05.png" }
visual_diff:
  warn_threshold: 0.05   # >5% diff → warn
  fail_threshold: 0.20   # >20% diff → run verdict = "fail"
  enabled: true
```

`sha` is a sha256 of the reference PNG bytes — lets us detect that the reference was edited outside the playbook flow.

### Comparison

`server/src/visual-diff.js`:
```js
export async function diffStep({ actualPath, refPath, warnThreshold = 0.05, failThreshold = 0.20 })
// -> { diff: 0.0..1.0, verdict: "match" | "warn" | "fail", diffImagePath?: "..." }
```

Uses [`pixelmatch`](https://www.npmjs.com/package/pixelmatch) (pinned to 5.x) for pixel-level comparison and `pngjs` to read/write PNGs.

Diff result:
- `diff < warn_threshold` → `match` (silent pass)
- `warn_threshold ≤ diff < fail_threshold` → `warn` (continue but flag in verdict)
- `diff ≥ fail_threshold` → `fail` (abort the run, save diff image to `.continuum/runs/<runId>/step-NN-diff.png`)

### New tool: `browser_playbook_diff_accept`

When the user reviewed a `warn` or `fail` and decides the change is correct (UI was intentionally redesigned), bless the new screenshots as the new reference:

```json
{
  "name": "browser_playbook_diff_accept",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id":    { "type": "string" },
      "steps": { "type": "array", "items": { "type": "number" }, "description": "Step numbers to accept; omit for all." },
      "runId": { "type": "string", "description": "Run whose screenshots become the new ref." }
    },
    "required": ["id", "runId"]
  }
}
```

Effects:
1. Copy `.continuum/runs/<runId>/step-NN.png` → `<feature>.screenshots/step-NN.png`.
2. Update `visual_refs[]` with new sha256 hashes.
3. Bump `playbook_version` by 1.
4. Append a `## Recent runs` entry: `accepted-${runId} — visual refs updated for steps [2, 5]`.

### Slash command

`/mochi:playbook diff accept <id> --run=<runId> [--step=N --step=M]` — added to the aggregator.

### Edge cases

- **No reference image** (first run): the run is treated as the reference. After the run, the user can `accept` to commit the screenshots, or the next run will treat *those* as references implicitly. To prevent silent commits, the first run's screenshots are written to `.continuum/runs/<runId>/` but NOT to `<feature>.screenshots/` — explicit `accept` required.
- **Dimension mismatch** (viewport size changed): if actual and reference differ in dimensions by >5%, fail-fast with `dimension-mismatch` — likely a viewport-size drift, not a UI change. The user can either rerun with matching viewport (`browser_emulate_viewport`) or accept-and-resize.
- **Animations / time-based UI** (clocks, spinners): `step-NN.skip-diff: true` in `visual_refs[]` per-step exempts that step from comparison.

---

## Errors

| Code | When | Where |
|---|---|---|
| `secret-ref-syntax` | `${…}` form is malformed (no closing brace, multiple refs, etc.) | secrets.js |
| `secret-not-found` | env var unset or file missing for a required secret | secrets.js (or during `secret_check`) |
| `secret-file-permission` | secret file has world-readable mode | secrets.js (warn only on Windows) |
| `seed-framework-unknown` | no detector matched the project root | codebase-seed.js |
| `seed-domain-missing` | required `domain` arg absent (only when project's framework needs it) | codebase-seed.js |
| `seed-parse-failed` | Babel parser threw on a route file; details include path + line | codebase-seed.js (warning, not fatal) |
| `diff-no-reference` | step has no reference image yet (first run) | visual-diff.js (warn, not fatal) |
| `diff-dimension-mismatch` | actual vs reference differ in dimensions | visual-diff.js |
| `diff-failure` | diff ≥ fail_threshold | visual-diff.js (causes `verdict: "fail"`) |

---

## Testing

### Unit tests

- `_secrets.test.mjs`:
  - resolveRef for each form (`${env:…}`, `${secret:…}`, bare uppercase).
  - Multiple refs rejected.
  - secret file with 0600 perms vs world-readable (warn).
  - scrubTrace replaces values with `[REDACTED:name]`.
  - validatePlaybook returns missing names.

- `_codebase_seed.test.mjs`:
  - Synthetic Next.js app router fixture with a login page and a settings page.
  - Synthetic Vite app fixture.
  - Asserts correct feature slugs, inputs (with `password` → `secret` auto-type), and step generation.
  - Non-overwrite of existing non-draft playbook.

- `_visual_diff.test.mjs`:
  - Two identical PNGs → diff = 0, verdict `match`.
  - 3% diff → `warn`.
  - 30% diff → `fail` + diff-image written.
  - Dimension mismatch fails fast.
  - Accept flow copies images and bumps `playbook_version`.

### Wire-contract tests

Extend `_playbook_wire.test.mjs` to cover the new tools:
- `browser_playbook_secret_check`: hits an env-var ref (set in test setup) → `available: true`. Hits a file ref where file missing → `available: false`.
- `browser_playbook_seed_from_codebase`: against fixture project → returns drafts.
- `browser_playbook_diff_accept`: copies, updates frontmatter.

### Integration

Extend `_playbook_e2e.mjs`:
- The login fixture's password field is now `type: secret` with `ref: "${env:E2E_FIXTURE_PASSWORD}"`. E2E sets the env var before run; asserts the run passes and the trace contains `[REDACTED:password]`, never `s3cretp4ss`.
- A second pass triggers visual diff: rerun against the same fixture (no UI change) → `match`. Then deliberately tweak the fixture (change `<button>Sign in</button>` to `<button>Log in</button>`) and rerun → expect `warn` or `fail` depending on text-area proportion. Verify accept flow.

### Smoke

Bump `_smoke.mjs` expected tool count to **51** (was 48; +3 new tools: `secret_check`, `seed_from_codebase`, `diff_accept`).

---

## Acceptance criteria

1. All three new tools register and surface; tool count 51; smoke green.
2. A playbook with `inputs[].type: secret, ref: "${env:FOO}"` runs without ever writing the resolved value into `.continuum/runs/` traces or future promoted playbooks.
3. `browser_playbook_seed_from_codebase` on a Next.js fixture produces ≥1 valid draft playbook with auto-typed `password` inputs.
4. Running a playbook against an unchanged fixture page produces `match` verdicts for all steps with reference images.
5. Running the same playbook against a deliberately tweaked fixture page produces a `warn` or `fail`, writes a diff image, and the `diff_accept` flow updates references + bumps `playbook_version`.
6. `.continuum/secrets/` is `chmod 0700` and contains a self-protecting `.gitignore`.
7. No regression in existing tests; bundle rebuilds without errors.

---

## Out of scope (v2+)

- 1Password / Bitwarden / cloud secret manager integrations.
- Vue, Svelte, Angular codebase detection.
- Perceptual / OCR-based visual diff (only pixel-level for v1.5).
- Interactive secret prompt (asking the user mid-run for a missing secret).
- Auto-rotation of secrets (file watch + reload).

---

## Open threads

- **Bundle size:** pixelmatch + pngjs add ~150KB to the bundle. Acceptable but noted.
- **PNG-only references:** JPEG screenshots from `browser_screenshot { format: "jpeg" }` would need conversion before diff. v1.5 captures references as PNG always; JPEG support is a future ask.
- **Secret file rotation:** if a user updates a file in `.continuum/secrets/`, the value is re-read on each run (no cache). Adequate for v1.5.
- **Cross-platform `chmod`:** Node's `fs.chmod` is a no-op on Windows. We log a warning on Windows recommending equivalent ACL setup.

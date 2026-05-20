# Changelog

All notable changes to **Mochi** (the Claude Code plugin formerly known as
`super-tester`) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely and the project follows [Semantic Versioning](https://semver.org/).

---

## [0.4.0] — 2026-05-20

Massive feature release. Tool count grows **39 → 54** with two big new
systems: file uploads (4-strategy chain that bypasses the OS native picker)
and personal-ops playbooks (per-feature markdown playbooks under
`.continuum/playbooks/` with auto-learning, codebase-derived seeding,
secrets, visual diff, sharing bundles, and an HTML dashboard).

### Added — browser file uploads

- **`browser_upload_stage`** — stage a file into the per-project library at
  `.continuum/uploads/`. Accepts `path`, https `url`, `dataUrl`, or `base64`.
  Returns a stable `stashId` (sha256-based, idempotent) reusable across many
  uploads and across sessions.
- **`browser_upload_file`** — attach a file to a page target via a strategy
  chain that bypasses the native OS file picker entirely:
  - `direct` — `DOM.setFileInputFiles` against `<input type=file>`
  - `intercept` — `Page.setInterceptFileChooserDialog` + `Page.handleFileChooser`
    around a click on a trigger button
  - `drop` — synthesized `DataTransfer` + `DragEvent` (handles Twitter/FB
    composer drops, drag-only zones)
  - `paste` — synthesized `ClipboardEvent` (Slack-style image paste into
    contenteditable)
  - Smart wait confirms upload via preview-thumbnail (MutationObserver),
    upload-network 2xx response, or a caller-supplied success signal.
  - Target by `selector`, accessibility `ref`, `trigger: {selector}`, or
    `auto: {near}` (the tool walks the DOM neighborhood for an upload
    target). Same-origin frame traversal is automatic.

### Added — personal ops playbooks (v1)

- **Markdown playbook format** under `.continuum/playbooks/<origin>/<feature>.md`
  with YAML frontmatter (origin, feature, verifiable, preconditions, inputs,
  outputs, composes, cron, last_verified, success_count, playbook_version).
  Sibling `<feature>.workflow.json` holds replay steps.
- **Seven new MCP tools:** `browser_playbook_{list,get,save,delete,match,run,
  propose_update}`. Replay routes through the existing workflow runner so
  selectors self-heal via ARIA role+name; healed selectors land back in the
  per-origin cache.
- **`qa-tester` subagent** (`plugins/qa/agents/qa-tester.md`). Isolated
  context, browser tools + read-only project access, returns one of
  `{verdict: "pass"|"fail"|"blocked"}` with evidence. Main agent decides when
  to delegate via the smart-router rule in `plugins/qa/CLAUDE.md`.
- **Four slash commands:** `/qa <task>` (dispatch the subagent),
  `/mochi:playbook` (list/show/run/delete/match), `/mochi:schedule-playbook`,
  `/mochi:unschedule-playbook` (cron via the host environment's schedule
  skill).
- **Auto-learning loop:** `browser_playbook_propose_update` takes a successful
  trace and creates or updates the matching playbook with inputs inferred
  from `intent` fields.

### Added — playbooks v1.5 (secrets / seeding / visual diff)

- **`browser_playbook_secret_check`** — validate that all `type: secret`
  inputs of a playbook are resolvable. Returns availability per secret;
  **never returns values.**
- **Secret refs:** `${env:VAR_NAME}`, `${secret:NAME}` (reads
  `.continuum/secrets/<name>.txt`, chmod 0700, auto-protective `.gitignore`),
  `${BARE_UPPER}` shorthand. Secret values are stripped from traces and
  promoted playbook bodies.
- **`browser_playbook_seed_from_codebase`** — static analyzer over the
  project's frontend. Detects Next.js (App + Pages Router), Vite, and CRA.
  Walks routes + form components via `@babel/parser`; auto-types `<input
  type="password">` as `secret`. Emits drafts with `playbook_version: 0`
  until you run + bless them.
- **Visual diff regression:** during `browser_playbook_run`, each step's
  screenshot is captured and compared (pixelmatch) against the playbook's
  reference. `warn` between 5–20% diff, `fail` ≥20% (tunable per playbook).
  **`browser_playbook_diff_accept`** blesses a run's screenshots as the new
  reference and bumps `playbook_version`.

### Added — playbooks v2 (sharing & polish)

- **1Password CLI integration:** `${1password:vault/item/field}` (alias
  `${op:...}`) resolves via `op read`. Availability checked with a 60s
  cache. When `op` isn't installed, refs resolve to `null` (treated same
  as missing).
- **Vue + SvelteKit codebase seeding:** Nuxt (`nuxt.config.*` →
  `pages/*.vue`) and SvelteKit (`svelte.config.*` + `@sveltejs/kit` →
  `src/routes/**/+page.svelte`). Built-in HTML tokenizer extracts
  `<input>`, `<button>`, `<form>` and recognizes `v-model={x}`,
  `bind:value={x}`, `data-testid`, and `aria-label`.
- **Blocked-verdict UX:** `browser_playbook_run` returns `verdict:
  "blocked"` with a `needs[]` array (one entry per missing required input,
  with `source` and a human-readable `hint`) instead of throwing. The main
  agent surfaces hints, asks the user, then retries.
- **`browser_playbook_export`** — write one or more playbooks (with
  embedded base64 screenshots and selector cache) to a single JSON bundle.
  Schema-versioned (`mochi-playbook-bundle@1`).
- **`browser_playbook_import`** — restore a bundle from local path, inline
  JSON, or https URL. Supports `overwrite` and `rewriteOrigin` (staging →
  production migration).
- **`browser_playbook_dashboard`** — generate a self-contained HTML
  dashboard from `.continuum/playbooks/index.json`. Dark-mode, search by
  id/title/inputs, tag-chip filters, click-to-expand. ~7KB output for a
  2-playbook library. Opens automatically in the active browser session.

### Changed

- `resolveRunInputs` in `playbooks.js` returns `{missing}` instead of
  throwing on unresolved required inputs (breaking change for v1 callers,
  but no public-API consumers existed).
- `replayPlaybookLeg` now captures per-step screenshots and runs visual
  diff against `visual_refs[]`. Bundle: 760KB → 3.5MB due to `pixelmatch`,
  `pngjs`, `@babel/parser`, `@babel/traverse`, `js-yaml`, `undici`. Still
  single self-contained ESM file, no native deps.
- Origin regex in playbook validation accepts host:port (e.g.,
  `app.localhost:3000`).

### Fixed

- Auto-detect target rule (`auto: {near}`) in `browser_upload_file` now
  correctly walks descendants → following siblings (≤5) → ancestor's
  descendants (depth ≤3).
- File-chooser intercept now restores `Page.setInterceptFileChooserDialog`
  to `false` in the `finally` block to avoid leaking the override.

### Documentation

- New design specs under `docs/superpowers/specs/`:
  - `2026-05-19-browser-file-upload-design.md`
  - `2026-05-20-personal-ops-playbooks-design.md`
  - `2026-05-20-playbooks-v1-5-design.md`
  - `2026-05-20-playbooks-v2-design.md`
- Matching implementation plans under `docs/superpowers/plans/`.

### Out of scope (post-0.4)

- Angular framework detection
- OCR / perceptual visual diff
- OOPIF (cross-origin iframe) traversal in `browser_upload_file`
- Multi-tab playbooks for OAuth popups
- Bitwarden / Doppler / Vault / AWS Secrets Manager integrations
- Continuous regression mode (auto-rerun playbooks on git commit)
- Playbook bundle marketplace / discovery

---

## [0.3.0] — 2026-05-18

Plugin renamed from `super-tester` to `mochi`. Server bundled with esbuild
into a single 760KB ESM file (no native deps, no npm install required for
end-users). File-based memory (`.continuum/`) replaces the older SQLite
store at `.super-tester/memory.db`. Distributed via GitHub plugin
marketplace.

39 tools at this point. See git history (`git log v0.3.0..HEAD`) for the
full details — this CHANGELOG starts tracking from 0.4.0 forward.

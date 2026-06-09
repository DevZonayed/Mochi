# Changelog

All notable changes to **Mochi** (the Claude Code plugin formerly known as
`super-tester`) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely and the project follows [Semantic Versioning](https://semver.org/).

---

## [0.7.1] — 2026-06-09

### Changed (Comment Mode UX, from user feedback)

- **Sticky pick mode** — arm once (💬), then for each comment just **click an
  element → type → Enter**. The picker stays armed (no re-clicking the bubble);
  **Esc** (when nothing's open) or tapping 💬 finishes. Far fewer clicks.
- **Easy cancel** — **Enter** saves (Shift+Enter = newline), **Esc** or
  **clicking outside** the popover discards it; placeholder documents it.
- The picker no longer swallows clicks on Mochi's own FAB / ⋯ menu while armed
  (you can open the menu and finish without disarming first).

### Fixed (Comment Mode)

- **Responsive frame:** the hover highlight was rendered *behind* the device
  overlay (so it looked like nothing happened) — raised above it; the frame now
  **auto-arms** commenting on load, "Comment here" is a clear armed toggle, and
  switching devices re-arms with the correct breakpoint.
- **Top-frame guard:** the content script never mounts inside iframes (including
  the responsive preview), preventing nested instances.

---

## [0.7.0] — 2026-06-07

### Added

- **Comment Mode — standalone visual annotation → agent-ready brief.** One click
  (**💬 Comment mode** in the popup, no Claude session required) drops a floating
  bubble on any page. Click an element to leave a numbered, anchored comment;
  scrolling stays free (with a one-time scroll hint). Comments persist across
  pages/reloads (`chrome.storage`), grouped by route in an iOS-style list, and
  sync across tabs. A **Responsive** device-frame lets you comment at common
  breakpoints. **Copy brief** exports markdown (selector + route + breakpoint +
  element + note) to paste into any coding agent. New content script
  `extension/comment-mode.js`; background re-injects on navigation; SPA route
  changes are detected (history patch + popstate/hashchange). Verified
  end-to-end in a real browser, then hardened against an adversarial review
  (14 findings fixed: cross-tab sync, listener-leak-free teardown, per-tab
  stop, hydration-race + stale-tab-id guards, sandboxed responsive iframe).
  No new MCP tools (browser count stays 61).
- **WhatsApp comms MCP** (from the parallel comms work merged here): a separate
  `comms` MCP server (`server/dist/comms.bundle.mjs`) with WhatsApp messaging
  tools, plus continuum comms recall/scoring. See the comms modules under
  `server/src/comms/` and `plugins/continuum/lib/comms_*`.

---

## [0.6.1] — 2026-06-07

### Changed

- **Popup: the "Send test notification" button is now always visible.** It was
  previously tucked inside the first-run onboarding card and disappeared once a
  user confirmed notifications worked. It now sits permanently in the
  **Notifications** section (under the on/off toggle), fires a test toast
  regardless of the toggle state, and surfaces a Chrome-level "notifications
  switched off" warning when applicable. No new tools (count stays 61).

### Notes

- Patch release so the distributed plugin cache carries the always-visible
  test button. As with 0.5.0+, applying the extension changes requires a
  one-time **reload of the unpacked extension** from the new cache path.

---

## [0.6.0] — 2026-06-07

QA-truth release. The browser tools stop trusting "it rendered" and start
proving "it works." Six new tools turn a QA pass into an exhaustive,
verdict-driven sweep — enumerate every control, drive each one, gate every
page and action for errors, and prove writes persisted. Tool count grows
**55 → 61** (on top of 0.5.0).

### Added

- **`browser_assert_no_errors`** — one-call health gate. `ok=false` if **any**
  console error/uncaught exception **or** any `>=400`/failed request happened
  since the page loaded (`sinceNavigation` default, `sinceMs`,
  `ignoreUrlContains`). Failed-request entries include the response `.body`.
- **`browser_audit_interactives`** — the coverage backbone. Enumerates every
  actionable control (`scope:"all"|"viewport"`, `limit`, `includeHidden`) with
  `{selector, role, accessibleName, visible, inViewport, disabled,
  hasClickHandler, box}` so nothing is left UNTESTED.
- **`browser_act_and_observe`** — perform one action
  (`click`/`type`/`navigate`/`press_key`/`click_at`) and classify the result:
  `WORKS` / `NO-OP` / `ERROR` / `NAVIGATES`. A `NO-OP` (clickable but nothing
  changed) is a dead control = defect. Returns `urlChanged`, `domChanged`,
  `networkDelta`, `consoleDelta`. Render != Works.
- **`browser_wait_for_response`** — block until a matching network response
  arrives (`urlGlob`/`urlContains`, `method`, `statusGte`/`statusLt`,
  `timeoutMs`). Proves a write actually persisted.
- **`browser_page_assets`** — hash the live page assets
  (`script`/`css`/`document`) with sha256 + a `pageHash`. Confirm the live
  bundle hash == the built hash (stale-bundle guard).
- **`browser_set_storage`** — deterministic auth/state seeding: set
  `localStorage`, `sessionStorage`, and `cookies` (or `clear`) in one call.
- **Exhaustive QA coverage mode** (`/qa exhaustive`) — enumerate every control,
  drive each, gate each page/action, and assign one of five verdicts per
  control: **WORKS**, **NO-OP** (defect), **ERROR** (defect), **NAVIGATES**,
  **DISABLED**.
- **Honesty-gate CLI** — refuses to report a run as "pass" while any control is
  UNTESTED/UNCERTAIN. The rule is never "everything works" but *"N of M
  controls verified — here is each result, and here is what I could NOT verify
  and why."*
- **Verification ledger** — per-control results recorded with **provenance
  stamping** so every verdict traces back to the action and evidence that
  produced it.
- **Persistent tooling-gotchas note** — `skills/browser/references/gotchas.md`,
  the canonical durable record of hard-won quirks so they're never re-learned.

### Changed

- `browser_navigate` now accepts `hardReload` (cache-bypass load) and
  `disableCache` (persist cache-off for the tab).
- `browser_console_messages` accepts `sinceNavigation:true` to scope to the
  current page; `level:"error"` includes uncaught exceptions.
- `browser_network_requests` accepts `sinceNavigation`, `sinceMs`, and
  `includeBody`; error responses (`>=400`/failed) include the captured response
  body automatically.
- `browser_click` reports disabled controls (fails loudly with "element is
  disabled" instead of silently passing) and retries a transient not-found once.
- `browser_session_health` accepts `heal:true` to re-attach the debugger to
  session tabs.
- `/continuum:recall` now flags stale chain-link hits by age, so remembered
  facts are re-verified against current code/live state before being asserted.
- **Tool count 55 → 61** (0.5.0 was 55).

### Fixed

- **Docs:** clarified `browser_emulate_viewport` vs `browser_window_resize`.
  `browser_emulate_viewport` (CDP `Emulation.setDeviceMetricsOverride`) **does**
  change `window.innerWidth` / `matchMedia` — real JS layout, and the tool to
  use for responsive/media-query testing. `browser_window_resize` only
  moves/sizes the OS Chrome window and does **NOT** affect JS layout. A common
  past mistake was conflating the two (or assuming emulation "only affects
  screenshots").

### Notes

- Layers on top of 0.5.0 (notifications). Combined tool count **54 → 61**
  (0.5.0 added `browser_request_attention`; 0.6.0 adds the six QA-truth tools).
- Adds a zero-dependency continuum MCP **recall** server
  (`plugins/continuum/mcp/server.js`) — `/continuum:recall` is now also an MCP tool.

---

## [0.5.0] — 2026-06-07

### Changed

- **Automation never steals OS focus.** `browser_session_start`'s
  `bringToFront` default flips `true → false`. Instead of raising the Chrome
  window to the foreground, the extension posts a **click-to-focus OS
  notification** ("Automation started — click to bring the window forward").
  The session tab is still made `active: true` within its window (no SPA
  throttling). Pass `bringToFront: true` when you actually want to watch.
  `chrome.notifications.onClicked` is the **only** path that raises a window.

### Added

- **`browser_request_attention({ reason, tabId?, urgent? })`** — a new MCP
  tool the agent calls when it genuinely needs the human (suspected
  captcha/login wall, an ambiguous choice, or "task finished — come look").
  Posts a notification without stealing focus. **Tool count 54 → 55.**
- **Automatic attention notifications** for the unambiguous cases: an
  unrecoverable session loss, a native JS dialog (`alert`/`confirm`/`prompt`/
  `beforeunload`), and a page crash. The dialog/crash hooks are pure
  `chrome.debugger` observers — they send no CDP command, so native dialog
  handling is unchanged.
- **Project-named notifications.** Each toast is titled `Mochi · <project>`,
  where the label is `basename(cwd)` of the per-project MCP server process,
  injected into `session_start`. The same label now titles the tab group.
- **Popup notifications section** — an OS-notifications on/off switch plus a
  non-technical onboarding flow: a "Send test notification" button, a
  "Did you see it? Yes / No" confirm, and (on No) a one-click **Open
  notification settings** button that deep-links to the macOS Notifications
  pane via a new broker route `POST /os/open-notification-settings`.

### Notes

- **Requires a one-time "reload unpacked extension"** — the new
  `notifications` manifest permission must be granted.
- **macOS:** a Chrome extension cannot read the System Settings notification
  toggle, so the confirm-probe (test → "did you see it?") is the robust check.
  If toasts don't appear, enable **Google Chrome** under System Settings →
  Notifications.

---

## [0.4.1] — 2026-05-20

### Fixed

- **Focus-steal during automation.** Every `browser_navigate` call in 0.4.0
  invoked `chrome.windows.update({ focused: true })`, which raises the Chrome
  automation window to the OS foreground AND captures keyboard focus from
  whatever the user was working on. Long automation flows became unusable
  while doing anything else — every navigate would yank your typing target
  back into Chrome.

  In 0.4.1, `browser_navigate`'s `bringToFront` default changes from `true`
  to `false`. The tab is still made `active: true` within its Chrome window
  (so SPAs / React / Cloudflare render correctly — no throttling), but the
  OS-level window focus is no longer requested on each navigate. Pass
  `bringToFront: true` explicitly when you want the window forward.

  `browser_session_start`'s default stays `bringToFront: true` — the
  one-time window creation is expected to be visible. Subsequent navigates
  in the session are silent.

  **Behavioral impact:** automation now runs in the background and lets you
  keep working in your IDE / Slack / wherever. Visual users who want to
  watch a flow can `bringToFront: true` on a specific navigate, or
  `Cmd+Tab` to the automation window once.

### Notes

- The `bringToFront` parameter in tool schemas was conflating two separate
  Chrome concepts (tab-active-in-window vs window-focused-on-OS). They're
  now decoupled internally: tab activity is always on; window OS focus is
  the opt-in flag.
- No new MCP tools. Tool count remains 54.

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

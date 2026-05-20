# Mochi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build server bundle](https://github.com/DevZonayed/Mochi/actions/workflows/build.yml/badge.svg)](https://github.com/DevZonayed/Mochi/actions/workflows/build.yml)
[![CodeQL](https://github.com/DevZonayed/Mochi/actions/workflows/codeql.yml/badge.svg)](https://github.com/DevZonayed/Mochi/actions/workflows/codeql.yml)
[![GitHub Repo stars](https://img.shields.io/github/stars/DevZonayed/Mochi?style=social)](https://github.com/DevZonayed/Mochi/stargazers)

> Browser companion for AI assistants. Browser automation MCP + persistent
> project memory + in-page hint messaging, all in one Claude Code plugin.

A QA-tester MCP for AI assistants — with **memory**.

Each AI session runs inside its own Chrome **tab group** (your other tabs are
untouched). What's new: every successful action is auto-traced, and the agent
can save the trace as a named **workflow** scoped to a domain. Next time you ask
"test the login flow on staging", the agent replays the saved workflow with
cached selectors — no re-discovery, no re-screenshotting. If a selector breaks
(refactor, A/B test, redesign), the engine **self-heals** by ARIA role + name
and updates the cache.

```
                 selector cache + workflow store
                  (file-based, <project>/.continuum/)
                              ▲
AI client (Claude Code / Codex / Cursor)
        │  stdio (MCP)                 ▲
        ▼                              │
   server/  ──── auto-launches Chrome ─┴─▶  Chrome
        │  WebSocket                              │
        ▼                                         ▼
 extension/ background.js  ◀──────────────  manifest V3 extension
                       │
                       ▼
              session = { tab group, primary tab, tab set, CDP }
```

## Layout

| Directory     | What it is                                                                       |
| ------------- | -------------------------------------------------------------------------------- |
| `server/`     | Node MCP server. WS server (port 9009) + file-based memory + workflow replay engine. |
| `extension/`  | Chrome MV3 extension. Owns the tab group, CDP attachments, and DOM helpers.      |
| `mcp/`        | Reference clone of upstream Browser MCP (not used; archival).                    |

Memory (selector cache, workflows, runs) lives in **`<project>/.continuum/`**
alongside the Continuum chain data — pure files, no database. Override with
`SUPER_TESTER_DATA_DIR`.

## Install (one plugin, one extension, done)

**Mochi** is a Claude Code plugin bundling browser automation, context-chain
memory, and popup hint messaging. The server is pre-bundled into a single
file (`server/dist/server.bundle.mjs`) by GitHub Actions on every push to
the default branch — so installing means cloning the repo. No `npm install`,
no native binaries, no setup script.

### Install from GitHub (recommended)

```text
# Inside any Claude Code session:
/plugin marketplace add DevZonayed/Mochi
/plugin install mochi@mochi
```

That's it for the plugin. Then load the Chrome extension once:

```text
chrome://extensions → Developer mode → Load unpacked → select
  ~/.claude/plugins/cache/mochi/mochi/0.4.0/extension
```

Restart Claude Code. Press **⌘⇧M** (macOS) or **Ctrl+Shift+M** (other) on
any tab to send a hint with picked elements + screenshot.

### Install from a local checkout (if hacking on the plugin itself)

```text
/plugin marketplace add /absolute/path/to/your/Mochi/checkout
/plugin install mochi@mochi
```

If you change source files, rebuild the bundle before reloading:

```bash
cd /path/to/Mochi/server && npm install && npm run build
```

Then `/reload-plugins` inside Claude (or `/plugin uninstall mochi && /plugin install mochi@mochi` for a clean refresh).

The plugin auto-registers:
- Two MCP servers — `browser` (automation tools) and `continuum` (recall tool)
- Seven slash commands — `/continuum:checkpoint`, `/continuum:recall`,
  `/continuum:status`, `/continuum:dream`, `/continuum:feedback`,
  `/continuum:rename`, `/continuum:render`
- Seven hooks — SessionStart, PreCompact, SessionEnd, PreToolUse,
  PostToolUse, Stop, UserPromptSubmit
- The `/browser` skill

For the in-page hint modal: press **⌘⇧M** (macOS) or **Ctrl+Shift+M** on any
page once the extension is loaded.

### Migrating from the older `super-tester` plugin name

If you had an earlier install when the plugin was called `super-tester`, run:

```
/plugin uninstall super-tester
/plugin marketplace remove super-tester
```

…then follow the install steps above using the new `mochi` names. Your
`.continuum/` chain data, screenshots, and feedback queue are tied to your
project dir (not the plugin name) — they survive the rename.

### Updating

Whenever new versions of mochi land (bumped `version` in `plugin.json`):

```
/plugin update mochi
```

Claude Code re-copies the source files into its plugin cache and switches the
active install over. MCP servers respawn on next Claude restart. For hook /
command / skill changes only, `/reload-plugins` works mid-session.

### Legacy install script

The older `./install.sh` script (which edited `~/.claude.json` directly) is
still in the repo but is now redundant with the plugin route. Don't use both
at the same time — pick one.

```bash
./install.sh --uninstall   # remove the legacy .claude.json entry if present
```

## Tools (MCP)

54 tools, grouped by purpose.

### Session + tabs

| Tool | What it does |
|---|---|
| `browser_session_start` | New tab group + primary tab. Pass `newWindow:true` to spawn a fresh window. |
| `browser_session_end` | Detach debugger, ungroup or close session tabs. |
| `browser_navigate` | Navigate primary tab, wait for load. |
| `browser_open_tab` | Open new tab inside the session group. |
| `browser_list_tabs` | List session tabs + CDP attachment state. |
| `browser_close_tab` | Close a specific session tab. |

### Discovery + interaction

| Tool | What it does |
|---|---|
| `browser_text` | Compact visible text lines, optionally filtered by query. Use before snapshot for reading/searching content. |
| `browser_links` | Compact visible links with text, href, selector ref, and box. |
| `browser_snapshot` | ARIA tree with stable refs + pixel boxes. Defaults to compact, viewport-only, redacted, depth-limited, and 12KB capped. |
| `browser_snapshot_query` | Search the stored snapshot by text/name/role/ref/tag and return tiny excerpts. |
| `browser_snapshot_node` | Return one compact subtree from the stored snapshot by ref, text, or query path. |
| `browser_click` | Click by selector (CDP). Pass `intent` to **cache** the selector for next time. |
| `browser_click_at` | Click at pixel coords (CDP). |
| `browser_type` | Focus + clear + insertText. Pass `intent` to cache. |
| `browser_press_key` | Real keyboard event (CDP). |
| `browser_scroll` | Absolute `{x,y}` or relative `{deltaX,deltaY}`. |
| `browser_go_back` / `browser_go_forward` | History navigation. |
| `browser_wait` | Sleep up to 60s. |
| `browser_screenshot` | PNG/JPEG (viewport / fullPage / elementRef). |

### Viewport + window

| Tool | What it does |
|---|---|
| `browser_window_resize` | Resize/move/maximize the actual window (only safe with `newWindow`). |
| `browser_emulate_viewport` | Device Mode via CDP. Presets + custom width/height/DPR/UA. |
| `browser_clear_emulation` | Reset viewport overrides. |

### Assertions

| Tool | What it does |
|---|---|
| `browser_assert` | Verify `url-contains`, `url-equals`, `title-contains`, `element-exists`, `element-missing`, `text-contains`, `text-equals`. Returns `{ok, got}`. |

### File uploads

| Tool | What it does |
|---|---|
| `browser_upload_stage` | Stage a file into the per-project library at `.continuum/uploads/`. Accepts `path`, https `url`, `dataUrl`, or `base64`. Returns a stable `stashId` (sha256-based, idempotent) reusable across many uploads. |
| `browser_upload_file` | Attach a file to a page target via a strategy chain: `direct` (`DOM.setFileInputFiles`) → `intercept` (file-chooser dialog) → `drop` (synthesized `DataTransfer` + `DragEvent`) → `paste` (synthesized `ClipboardEvent`). Bypasses the native OS file picker entirely. Target by `selector`, `ref`, `trigger`, or `auto: { near }`. Smart-wait confirms upload (preview thumbnail / 2xx upload response / custom `successSelector`). |

Sources can be inlined into `browser_upload_file` or pre-staged with
`browser_upload_stage`; staging dedupes by sha256, so the same logo across
ten sites is fetched/decoded once and reused. Frame-traversal handles
same-origin iframes automatically. See
[`docs/superpowers/specs/2026-05-19-browser-file-upload-design.md`](docs/superpowers/specs/2026-05-19-browser-file-upload-design.md)
for the full design.

### Playbooks (personal ops memory)

| Tool | What it does |
|---|---|
| `browser_playbook_list` | List playbooks under `.continuum/playbooks/`, filter by origin/tag/verifiable. |
| `browser_playbook_get` | Return one playbook with meta + body sections + workflow JSON. |
| `browser_playbook_save` | Create/update a playbook (validates frontmatter and required sections). |
| `browser_playbook_delete` | Remove a playbook + workflow + screenshots. |
| `browser_playbook_match` | Score-match playbooks against a URL, intent, or task description. |
| `browser_playbook_run` | Replay a playbook (with self-heal) using provided inputs; recursively executes `composes`/`next` chains; returns verdict + evidence. |
| `browser_playbook_propose_update` | Given a successful trace, create or update the matching playbook. Inputs and steps auto-inferred. |
| `browser_playbook_secret_check` | Validate that a playbook's `type: secret` inputs are resolvable (env or `.continuum/secrets/`). Returns availability only — never values. |
| `browser_playbook_seed_from_codebase` | Static-analyze the project's frontend (Next.js / Vite / CRA) and emit draft playbooks per route + form. Solves cold-start on in-house apps. |
| `browser_playbook_diff_accept` | Bless a run's per-step screenshots as the new visual reference; bumps `playbook_version`. |
| `browser_playbook_export` | Export one or more playbooks to a single JSON bundle file. Includes embedded base64 screenshots. |
| `browser_playbook_import` | Import a playbook bundle (file / inline JSON / https URL). Supports `overwrite` + `rewriteOrigin` (e.g., staging → production). |
| `browser_playbook_dashboard` | Generate a self-contained HTML dashboard from the library; opens in the active browser session. |

**v1.5 capabilities:**
- **Typed secrets:** `inputs[].type: secret` resolves at runtime from `${env:VAR}` or `${secret:name}` (reads `.continuum/secrets/<name>.txt`, which is `chmod 0700` with an auto-protective `.gitignore`). Secret values never appear in `.continuum/runs/` traces or promoted playbook bodies.
- **Codebase-derived drafts:** point `browser_playbook_seed_from_codebase` at this project and it walks your routes (Next.js App/Pages Router, Vite, CRA), extracts forms + `data-testid`s + `aria-label`s, and emits draft playbooks per route. Password fields auto-typed as `secret`.
- **Visual diff regression:** during `browser_playbook_run`, each step's screenshot is compared (pixelmatch) against the playbook's reference. `warn` between 5–20% diff; `fail` ≥20% (configurable per playbook). Use `browser_playbook_diff_accept` to bless intentional UI changes.

See [`docs/superpowers/specs/2026-05-20-playbooks-v1-5-design.md`](docs/superpowers/specs/2026-05-20-playbooks-v1-5-design.md).

**v2 capabilities (Sharing & Polish):**
- **1Password integration:** `inputs[].type: secret` refs accept `${1password:vault/item/field}` (alias `${op:...}`). When the `op` CLI is installed and signed in, values are resolved via `op read` at run time and never logged.
- **Vue + SvelteKit codebase seeding:** Nuxt projects (`nuxt.config.*`) and SvelteKit projects (`svelte.config.*` + `@sveltejs/kit`) are detected by `browser_playbook_seed_from_codebase` in addition to Next.js / Vite / CRA.
- **Blocked-verdict UX:** `browser_playbook_run` returns `verdict: "blocked"` with a `needs[]` array (one entry per missing required input + a `hint` per source) instead of throwing. The main agent uses the hints to prompt the user (or fix env) and then retries.
- **Cross-project playbook bundles:** `browser_playbook_export` writes a single JSON containing markdown + workflow + base64 screenshots; `browser_playbook_import` restores them anywhere. Supports overwrite + origin rewrite for staging → production migration.
- **HTML dashboard:** `/mochi:playbook ui` (or `browser_playbook_dashboard`) generates a self-contained dashboard with search, tag filters, and inline drill-down per playbook.

See [`docs/superpowers/specs/2026-05-20-playbooks-v2-design.md`](docs/superpowers/specs/2026-05-20-playbooks-v2-design.md).

Combined with the bundled `qa-tester` subagent and the smart-router rule in
`plugins/qa/CLAUDE.md`, the playbook library is your **personal ops memory** —
each browser task you do once becomes replayable, chainable, and
scheduleable. Main Claude routes verifiable + repeatable tasks to the
isolated `qa-tester` subagent (which returns a pass/fail verdict + evidence)
while operational tasks (multi-step, decisive, may need mid-flow input)
stay in the main conversation and use playbooks as guidance.

**Slash commands:**
- `/qa <task>` — dispatch the qa-tester subagent for a verifiable browser task.
- `/mochi:playbook list|show|run|delete|match [args]` — manage playbooks.
- `/mochi:schedule-playbook <id>` — wire up cron via the host's `schedule` skill.
- `/mochi:unschedule-playbook <id>` — cancel a scheduled playbook.

See [`docs/superpowers/specs/2026-05-20-personal-ops-playbooks-design.md`](docs/superpowers/specs/2026-05-20-personal-ops-playbooks-design.md)
for the full design.

### Memory: selector cache (per origin)

| Tool | What it does |
|---|---|
| `browser_recall_selector` | "Do I already know how to find X on this site?" Returns cached selector or null. |
| `browser_forget_selector` | Drop a cached entry. |
| `browser_list_selectors` | Inspect the cache. |

### Memory: workflows

| Tool | What it does |
|---|---|
| `browser_workflow_save` | Persist current session's auto-traced actions as a named workflow. |
| `browser_workflow_run` | Replay. Cached selector → self-heal by role+name → screenshot on miss. |
| `browser_workflow_list` / `_get` / `_delete` | Manage workflows. |
| `browser_workflow_export` / `_import` | Portable JSON (commit alongside your app's tests). |
| `browser_run_history` | Last N runs of a workflow. |

### Compact inspection ladder

Use the smallest inspection tool that can answer the current question:

1. `browser_text {query?, limit?}` for page copy, search results, lists, and visible facts.
2. `browser_links {query?, limit?}` for navigation choices.
3. `browser_snapshot` for clickable refs and visible actionable UI.
4. `browser_snapshot_query` for targeted search inside the stored snapshot.
5. `browser_snapshot_node` for the one subtree you need.
6. `browser_snapshot {mode:"full", scope:"all", maxBytes:0}` only as an explicit last resort.

This keeps Claude Code, Codex, and parallel agents from flooding their context
with full-page accessibility trees.

### Visual placement loop

```
browser_snapshot      → compact tree with refs + boxes
browser_screenshot    → image (viewport / fullPage / elementRef)
   ↓
agent correlates ref ↔ box ↔ pixel position
   ↓
browser_click {ref, intent:"…"}    ← intent caches the selector
```

### Resize vs. emulate — when to use which

| Goal                                                         | Tool                                              |
| ------------------------------------------------------------ | ------------------------------------------------- |
| Test a real responsive layout at iPhone size                 | `browser_emulate_viewport {preset:"iphone-15-pro"}` (no window change, includes touch + UA) |
| Test how the UI behaves at a real 2560×1440 monitor          | `browser_window_resize {width:2560, height:1440}` (only safe in a session-owned window)      |
| Verify a layout breakpoint at exactly 768px wide             | `browser_emulate_viewport {width:768, height:1024}` |
| Reset back to native                                         | `browser_clear_emulation`                          |

`emulate_viewport` is preferred — it's deterministic, doesn't disturb anything else, and matches what Chrome DevTools' Device Mode does. `window_resize` is for when you genuinely need real OS-level window dimensions.

## Memory model

Two layers, stored as plain JSON files under `<project>/.continuum/` (no
database, no native bindings).

### 1) Selector cache — keyed by `(origin, intent)`

Every `browser_click` / `browser_type` call may carry an **intent** ("click sign in
button", "email field"). On success, the resolved selector is cached at
`(origin, intent)`. The agent can short-circuit discovery by calling
`browser_recall_selector` before snapshotting:

```
browser_recall_selector {intent:"click sign in button"}
  → {found:true, selector:'button[aria-label="Sign in"]', last_box:{...}}
browser_click {ref:'button[aria-label="Sign in"]', intent:"click sign in button"}
```

The cache survives Chrome restarts, project reloads, server restarts.

### 2) Workflows — keyed by `(origin, name)`

Every successful action inside a session is appended to an in-memory **trace**.
`browser_workflow_save {name:"login"}` persists the trace as an ordered list of
steps. `browser_workflow_run {name:"login"}` replays them.

Replay strategy per step:
1. Try the step's stored selector. If it resolves → click.
2. Else: try other entries from the selector cache for the same `intent`.
3. Else: **self-heal** by ARIA role + name from a fresh snapshot. If found,
   update both the step record AND the selector cache, continue.
4. Else: return a rich failure envelope (tried selectors, role/name, screenshot,
   suggestion) so the agent can recover.

The agent doesn't need to think about caching — just pass `intent`. Workflows
build themselves out of normal exploration and replay deterministically next
time.

### Step-by-step feedback contract

Every replayed step returns:

```json
{
  "step": 2,
  "action": "click",
  "intent": "click sign in button",
  "status": "pass",                          // pass | fail | skipped
  "selector": "button[aria-label=\"Sign in\"]",
  "selector_source": "step_cache",           // step_cache | selector_cache | self_healed
  "durationMs": 12
}
```

Failures additionally include `tried`, `role`, `name`, `screenshotDataUrl`, and
a `suggestion`.

### Typical agent flow

**First time** ("test the login flow"):
```
browser_session_start
browser_navigate {url:"https://staging.myapp.com/login"}
browser_recall_selector {intent:"email field"}        → not found
browser_snapshot
browser_type {ref:"input[name=email]", text:"…", intent:"email field"}
browser_recall_selector {intent:"click sign in"}      → not found
browser_click {ref:"button.signin", intent:"click sign in"}
browser_assert {kind:"url-contains", value:"/dashboard"}
browser_workflow_save {name:"login"}
```

**Next time** ("retest login"):
```
browser_session_start
browser_workflow_run {name:"login", origin:"https://staging.myapp.com"}
  → {status:"pass", stepsTotal:5, stepsPassed:5, results:[…]}
```

If the UI was refactored, the run still passes — the engine self-heals and
updates the cache. If it can't find the element at all, the agent gets a
screenshot and a suggestion, and falls back to snapshot + AI discovery.

### Portability

Workflows are portable JSON. Commit them alongside your app:

```bash
# in agent flow:
browser_workflow_export {name:"login"}     # returns JSON payload
# write to repo: tests/super-tester/login.json
# later, on a fresh machine:
browser_workflow_import {payload: <json>}
```

## Concurrent Claude sessions

You can run **multiple Claude Code sessions at once**, each with its own
super-tester scope. The first MCP server to start binds port 9009 and becomes
the **broker**; subsequent MCP servers detect the conflict and connect to the
broker as **clients**, forwarding their browser commands through it. Each
Claude session gets its own `clientId`, and the extension keeps a separate tab
group per client. Sessions are fully isolated — Session A's clicks/navigates
never touch Session B's tabs.

```
Claude session 1 ──stdio──► MCP-A ─────► (broker, owns port 9009 + extension WS)
                                    └──┐
Claude session 2 ──stdio──► MCP-B ─────► (client → forwards via MCP-A)
                                    └──┐
Claude session 3 ──stdio──► MCP-C ─────► (client → forwards via MCP-A)

Extension holds Map<clientId, Session> — one tab group per Claude session.
```

The selector cache and workflow store are shared across sessions
(per-origin, in `.continuum/`), so a workflow recorded in Session A can be
replayed from Session B without re-learning anything.

## Claude Code shortcuts

After installing the `mochi` plugin (see [Install](#install-one-plugin-one-extension-done)
above), the `browser` MCP server runs automatically. No `claude mcp add-json`
needed.

After restarting Claude Code, use:

```text
/browser test localhost:3000
use browser to verify the login flow
use the browser MCP and check console errors
```

The MCP tools are named `browser_session_start`, `browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_screenshot`,
`browser_console_messages`, `browser_network_requests`, and related
`browser_*` tools.

If the broker process dies (for example, the first Claude Code session exits),
the remaining MCP clients automatically race to recover. One client promotes
itself to the new broker, the extension reconnects to it, and clients request
their previous `clientId` so existing tab groups remain attached to the right
Claude session. New Claude sessions can then connect to the recovered broker.

Commands from the same client are serialized inside the extension to prevent
same-session races such as `session_start` overlapping `navigate` or
`session_end`. Different client sessions still run in parallel, each scoped to
its own tab group.

## Boundary guarantees

- **Spawned tabs** (target=_blank, `window.open`, etc.) are auto-grouped into the session group via `chrome.tabs.onCreated`.
- **Drag a tab out of the group** → it's released from the session, no longer touched.
- **All operations validate** that the target tab is still in the session group. If you ungroup or close the group, the next tool call fails cleanly.
- **Other Chrome windows / tabs / groups** are never queried, never modified.
- **Per-client isolation:** every operation is scoped to the originating Claude session's tab group. Cross-session reads/writes are impossible at the protocol level.
- **Service-worker restart recovery:** session metadata is persisted in `chrome.storage.local` and restored against live tab groups when the extension wakes back up.

## Environment variables

| Variable                           | Default                          | Purpose                                                   |
| ---------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `SUPER_TESTER_WS_PORT`             | `9009`                           | WS port the extension connects to (must match in code).   |
| `SUPER_TESTER_AUTO_LAUNCH`         | `true`                           | Set `false` to disable Chrome auto-launch.                |
| `SUPER_TESTER_CHROME_PATH`         | platform-detected                | Override Chrome binary path.                              |
| `SUPER_TESTER_EXTENSION_PATH`      | unset                            | If set, Chrome launches with `--load-extension=<path>`.   |
| `SUPER_TESTER_PROFILE_DIR`         | `~/.super-tester/super-tester-profile` | Dedicated `--user-data-dir`.                        |
| `SUPER_TESTER_EXTENSION_WAIT_MS`   | `20000`                          | How long to wait for the extension to connect on cold start. |
| `SUPER_TESTER_DATA_DIR`            | `<project>/.continuum/`          | Override where selector cache and workflows are stored. |
| `SUPER_TESTER_PROJECT_DIR`         | `process.cwd()`                  | Where to start looking for a project root (`.git` / `package.json`) for the per-project data dir. |

## Caveats

- **Chromium-only** (Tab Groups API). Won't work in Firefox.
- **Debugger banner:** the first time you call `browser_click` / `browser_type` / `browser_press_key` / `browser_screenshot` with `fullPage` or `elementRef` on a tab, Chrome shows a *"Mochi started debugging this browser"* banner (Chrome shows the extension's display name). The session keeps the attachment alive until `browser_session_end` (or the tab closes). This is intentional and unavoidable for real input dispatch.
- **DevTools collision:** if you open Chrome DevTools on a session tab, CDP attach will fail until you close DevTools.
- **`--load-extension`** requires Developer Mode in the target profile.
- **WebSocket reconnect** from an MV3 service worker is best-effort: a 30-second alarm pings every cycle; opening the popup wakes the SW immediately.
- Hard-coded `ws://127.0.0.1:9009` in the extension — change there + via `SUPER_TESTER_WS_PORT` if needed.

## Troubleshooting

| Symptom                                                    | Likely cause / fix                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension didn't connect within timeout`                  | Extension isn't loaded, Chrome on a different profile, or the SW died. Click the Mochi icon → confirm the status dot is green.              |
| `tab not in session group`                                 | The tab was dragged out, or the session was ended/cleared. Call `browser_session_start` again.                                              |
| `element not found: …`                                     | Use `browser_snapshot` first; pass the `ref` it returns.                                                                                    |
| `chrome.debugger attach failed — another debugger…`        | Close Chrome DevTools on the session tab (or other debugging extensions), then retry.                                                       |
| `element has zero size` from `browser_screenshot`          | The `elementRef` is hidden / `display:none`. Snapshot first to confirm visibility.                                                          |
| Chrome opens but with the wrong profile                    | Set `SUPER_TESTER_PROFILE_DIR` to a clean directory.                                                                                        |
| Server logs `[ws] error: EADDRINUSE`                       | Another instance is running on port 9009. Kill it or change `SUPER_TESTER_WS_PORT`.                                                         |

## Contributing

Issues, ideas, and PRs welcome. A few pointers:

- **Bug reports / feature requests** — use the [issue templates](https://github.com/DevZonayed/Mochi/issues/new/choose).
- **Open-ended questions or ideas** — start a [discussion](https://github.com/DevZonayed/Mochi/discussions) instead of an issue.
- **Pull requests** — keep them focused (one concern per PR). The PR template prompts for context. Don't hand-edit `server/dist/` — it's auto-rebuilt by CI from `server/src/`.
- **Security issues** — please **don't** open a public issue. See [SECURITY.md](SECURITY.md) for the private disclosure process.

## License

[MIT](LICENSE) © Jonayed Ahamed

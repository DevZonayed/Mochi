# Personal Ops Playbooks — design spec (v1, sub-projects 1–4)

**Status:** Approved roadmap, ready for implementation plan.
**Date:** 2026-05-20
**Scope:** Four sub-projects shipping together as one coherent system:
1. Playbook format + CRUD tools
2. QA subagent + smart router
3. Auto-learning loop
4. Chained playbooks + scheduling

**Out of scope (v1.5+):** codebase-derived seeding, visual diff regression, secrets store.

---

## Motivation

Mochi already has the *primitives* for memory: per-origin selector cache, JSON action workflows, per-run history under `.continuum/`. What's missing is a **human + agent-readable narrative layer** on top — a per-feature playbook the agent reads *before* acting and updates *after* succeeding. Combined with a thin QA subagent and an opinionated smart-router rule, this turns Mochi from "browser automation tools" into a **personal operations memory**: every recurring web task you do once becomes replayable, chainable, scheduleable.

The framing "QA agent" undersells this. The same playbook library serves:
- **QA tasks** (verifiable, repeatable) — isolated in a subagent that returns a verdict.
- **Operational tasks** (multi-step, decisive, may need user input mid-flow) — stay in the main agent which consults playbooks as guidance.

The split is *not* by domain (Gmail vs AWS) but by **task shape**: does the task have a binary pass/fail outcome that's safe to delegate, or does it need a human decision point? Main Claude classifies before acting.

---

## Architecture overview

```
┌─ Main Claude Agent ─────────────────────────────────────────┐
│  Reads CLAUDE.md smart-router rule on browser-leaning tasks │
│  Classifies: verifiable+repeatable  OR  operational+decisive│
└───┬─────────────────────────────────────────┬───────────────┘
    │ delegate                                │ stay in-line
    ▼                                         ▼
┌─ qa subagent (.claude/agents/qa.md) ─┐   ┌─ in-line execution ──────┐
│  Isolated context window             │   │  Main context             │
│  Tools: browser_*, Read, Grep, Glob  │   │  All tools (Bash, Edit…)  │
│  Cannot Write/Edit project files     │   │  Reads matching playbook  │
│  Returns verdict + evidence + traces │   │  Can pause to ask user    │
└──────────────────────────────────────┘   └───────────────────────────┘
              │                                       │
              └───────────┬───────────────────────────┘
                          ▼
            ┌─ .continuum/playbooks/ ────────────────────┐
            │  <origin>/                                 │
            │    <feature>.md                            │
            │    <feature>.workflow.json   (replay data) │
            │    <feature>.screenshots/                  │
            │  _generic/                                 │
            │    login-form.md, file-upload.md, …        │
            │  index.json    (origin × feature → meta)   │
            │  inbox/<YYYY-MM-DD>/<playbook>-<runId>.md  │
            └────────────────────────────────────────────┘
                          ▲
            ┌─ Auto-learning loop ───────────────────────┐
            │  After successful run: read run trace,     │
            │  diff vs existing playbook (if any),       │
            │  write/update markdown + workflow.json,    │
            │  bump success_count + last_verified.       │
            └────────────────────────────────────────────┘
                          ▲
            ┌─ Chained playbooks + scheduling ───────────┐
            │  composes: [p1, p2]  → run-then-run        │
            │  cron: "0 7 * * *"   → schedule skill      │
            │  outputs of P1 → inputs of P2 (named refs) │
            └────────────────────────────────────────────┘
```

---

## Sub-project 1 · Playbook format + CRUD tools

### File layout

```
.continuum/playbooks/
  index.json                                          # fast lookup
  <origin-hostname>/                                  # e.g. mail.google.com/
    <feature>.md                                      # narrative + frontmatter
    <feature>.workflow.json                           # JSON replay data (links to existing memory.js workflow record)
    <feature>.screenshots/                            # PNGs referenced from the .md
      step-01.png …
  _generic/                                           # cross-site patterns
    login-form.md
    file-upload-trigger.md
    infinite-scroll.md
  inbox/                                              # scheduled-run outputs
    2026-05-20/
      gmail-morning-summary-r4a91.md
```

`<feature>` is a kebab-case slug (e.g. `send-email`, `create-s3-bucket`).
`<origin-hostname>` is the bare hostname (no scheme, no port for default 80/443).

### Playbook markdown format

```markdown
---
origin: mail.google.com                # required; "_generic" for cross-site
feature: send-email                    # required; kebab-case
title: Send an email via Gmail web     # human-readable
verifiable: true                       # if true, eligible for qa subagent
preconditions: [logged-in]             # symbolic preconditions
inputs:
  - { name: to,          type: email,            required: true }
  - { name: subject,     type: text,             required: true }
  - { name: body,        type: markdown,         required: true }
  - { name: attachments, type: file[], accept: "image/*,application/pdf", max: 25MB, optional: true }
outputs:
  - { name: sentMessageId, type: text }
composes: []                           # other playbook ids to invoke (sub-project 4)
next: null                             # playbook id to chain to (sub-project 4)
cron: null                             # cron expression for scheduling (sub-project 4)
last_verified: 2026-05-20T10:00:00Z
success_count: 14
last_run_id: r4a91
playbook_version: 1
schema_version: 1
---

## Summary

Compose and send a Gmail message from mail.google.com. Optionally attaches files.

## Preconditions

- User is logged in (cookie present, /mail/u/0/#inbox loads to inbox not consent screen).
  Check via: visible element matching `[aria-label="Search mail"]`.

## Steps

1. Navigate to `https://mail.google.com/mail/u/0/#inbox`. Wait for inbox load.
2. Click the **Compose** button. Selector: `[data-tooltip="Compose"]` (intent: `compose-button`).
3. In the `To` field (selector: `input[aria-label="To recipients"]`), type `${input.to}`.
4. Tab to the **Subject** field (selector: `input[aria-label="Subject"]`), type `${input.subject}`.
5. Click the message body (selector: `div[aria-label="Message Body"]`), insert `${input.body}`.
6. If `${input.attachments}` is set, for each attachment:
   - Call `browser_upload_stage` with the attachment source.
   - Call `browser_upload_file` with `trigger: { selector: "[data-tooltip*='Attach files']" }`, the stashId, and `waitFor: { successSelector: "[aria-label*='Uploaded']" }`.
7. Click the **Send** button (selector: `[data-tooltip*='Send (Ctrl+Enter)']`).
8. Wait for the "Message sent." toast (selector: `[role=alert] :text("Message sent.")`).

## Verification

Pass when step 8's toast appears within 10s **and** a network 2xx response to `/sendchatmessage` was observed.

## Selectors used

| intent              | selector                                         |
|---------------------|--------------------------------------------------|
| `compose-button`    | `[data-tooltip="Compose"]`                       |
| `to-field`          | `input[aria-label="To recipients"]`              |
| `subject-field`     | `input[aria-label="Subject"]`                    |
| `body-field`        | `div[aria-label="Message Body"]`                 |
| `attach-button`     | `[data-tooltip*="Attach files"]`                 |
| `send-button`       | `[data-tooltip*="Send (Ctrl+Enter)"]`            |

## Recent runs

- r4a91 (2026-05-20) — pass, 6.2s
- r3f87 (2026-05-19) — pass, 6.8s
- r3a01 (2026-05-18) — fail; `send-button` no longer matched, self-healed via role+name="Send"

## Screenshots

- ![Compose form open](send-email.screenshots/step-02.png)
```

The body has **fixed top-level sections** so the agent can navigate by heading without parsing prose: `## Summary`, `## Preconditions`, `## Steps`, `## Verification`, `## Selectors used`, `## Recent runs`, `## Screenshots`.

### `<feature>.workflow.json` companion

```json
{
  "playbookId": "mail.google.com/send-email",
  "schemaVersion": 1,
  "steps": [
    { "action": "navigate", "url": "https://mail.google.com/mail/u/0/#inbox" },
    { "action": "click",    "intent": "compose-button" },
    { "action": "type",     "intent": "to-field",       "valueRef": "input.to" },
    { "action": "type",     "intent": "subject-field",  "valueRef": "input.subject" },
    { "action": "click",    "intent": "body-field" },
    { "action": "type",     "intent": "body-field",     "valueRef": "input.body" },
    { "action": "upload",   "intent": "attach-button",  "filesRef": "input.attachments" },
    { "action": "click",    "intent": "send-button" },
    { "action": "assert",   "kind": "element-exists",   "selector": "[role=alert] :text(\"Message sent.\")", "timeoutMs": 10000 }
  ]
}
```

Selectors are not embedded in `workflow.json` — they're looked up via the existing `memory.js` per-origin selector cache, keyed by `intent`. This lets selectors self-heal independently of the workflow.

### `index.json` — fast lookup

```json
{
  "version": 1,
  "playbooks": [
    {
      "id": "mail.google.com/send-email",
      "origin": "mail.google.com",
      "feature": "send-email",
      "title": "Send an email via Gmail web",
      "verifiable": true,
      "inputs": ["to", "subject", "body", "attachments"],
      "success_count": 14,
      "last_verified": "2026-05-20T10:00:00Z",
      "tags": ["email", "communication"]
    }
  ]
}
```

Rebuilt automatically from the `.md` frontmatter on any playbook save.

### Server module: `server/src/playbooks.js`

New module. Public functions:

```js
// CRUD
listPlaybooks({ origin?, feature?, tag?, verifiable? }) -> [{...meta}]
getPlaybook(playbookId) -> { meta, body, workflow } | null
savePlaybook({ id, meta, body, workflow }) -> { ok: true, path }
deletePlaybook(playbookId) -> { ok: true }

// Discovery
matchPlaybook({ url, intent, taskText }) -> [{ playbookId, score, reason }, ...]

// Index
rebuildIndex() -> { entries: N }
```

`matchPlaybook` scoring:
- Exact origin match → +50
- URL path-prefix match (e.g. `/inbox` in playbook navigates to `/inbox`) → +30
- Feature name token overlap with `taskText` (stemmed) → +N
- Tag overlap → +10/tag
- Returns top 5 scored ≥ threshold (default 30).

### New MCP tools

| Tool | Purpose |
|---|---|
| `browser_playbook_list` | List playbooks with optional filters. Compact response (id + title + tags + success_count). |
| `browser_playbook_get` | Return the full playbook (meta + body + workflow JSON). |
| `browser_playbook_save` | Create/update a playbook (typically called by the auto-learning loop, but also user-callable). |
| `browser_playbook_delete` | Remove a playbook. |
| `browser_playbook_match` | Given `{ url, intent, taskText }`, return scored matches. Used by the smart router. |
| `browser_playbook_run` | Replay a playbook by id with provided `inputs`. Routes through existing `browser_workflow_run` for replay + self-heal. |

### Validation

- `id` must be `<origin>/<feature>`, both kebab-case-ish (origin is hostname, feature is `[a-z0-9-]+`).
- `feature` slug max 40 chars.
- `inputs[].name` must be a valid JS identifier.
- `inputs[].type` is one of: `text`, `email`, `url`, `markdown`, `password`, `file`, `file[]`, `image`, `image[]`, `secret`, `enum`, `int`, `bool`.
- `cron` validated against standard 5-field cron syntax.
- All required frontmatter fields present; body has required top-level sections.

---

## Sub-project 2 · QA subagent + smart router

### QA subagent file

Path (plugin-distributed): `plugins/qa/agents/qa-tester.md`. Registered via `plugin.json`'s `agents` array (parallel to `commands`/`hooks`). If the plugin agents path is not yet supported by Claude Code, fall back to project-level `.claude/agents/qa-tester.md`.

```markdown
---
name: qa-tester
description: Use when the task is a verifiable browser interaction with a binary pass/fail outcome — login flow, submit form, attach file, verify message appears. Returns a verdict + evidence (screenshot, network log). Do NOT use for tasks that require user decisions mid-flow (e.g., picking AWS region, choosing a domain).
tools: [Bash, Read, Grep, Glob, mcp__plugin_mochi_browser__*]
---

# qa-tester

You are an isolated QA subagent. Your job is to execute a specific, verifiable browser interaction and report a verdict with evidence. You DO NOT make creative decisions, write code, or edit project files.

## What you can do

- Use any Mochi browser MCP tool.
- Read project files (`Read`, `Grep`, `Glob`) to understand the context — useful for finding URLs, env, fixtures.
- Run read-only bash (status, ls, git log) — never destructive.
- Read playbooks from `.continuum/playbooks/` and follow them.
- Write a run report to `.continuum/inbox/` summarizing the outcome.

## What you cannot do

- Edit, Write, or modify project files (other than `.continuum/inbox/` reports).
- Ask the user questions. If a required input is missing, return `{ verdict: "blocked", reason: "missing input X" }`.
- Make scope-expanding decisions — if the task isn't well-defined, return `{ verdict: "blocked", reason: "task ambiguous: …" }`.

## How to run a task

1. Parse the task: identify origin, feature, inputs.
2. `browser_playbook_match { url, intent, taskText }` — see if a playbook exists.
3. If a playbook exists with `verifiable: true`:
   - `browser_playbook_get` it.
   - `browser_playbook_run { id, inputs }`.
   - Use the playbook's `## Verification` section to confirm pass/fail.
4. If no playbook exists:
   - Use snapshot/click/type/upload tools manually.
   - On success, **propose** a new playbook (via `browser_playbook_save`) so the next run is fast.
5. On finish, write a report to `.continuum/inbox/<date>/<feature>-<runId>.md` with: verdict, evidence (screenshots, network), trace summary, suggested playbook changes.

## Return shape

Always return one of:

```json
{ "verdict": "pass",    "evidence": { ... }, "playbookId": "...", "runId": "..." }
{ "verdict": "fail",    "reason": "...",     "evidence": { ... }, "playbookId": "...", "runId": "..." }
{ "verdict": "blocked", "reason": "..." }
```

No prose narration. The main agent will surface to the user.
```

### Smart router rule

A new file `plugins/qa/CLAUDE.md` (loaded into the project context when the plugin is installed) containing:

```markdown
# Mochi QA — task routing

When the user asks you to do a browser interaction, FIRST classify:

**Verifiable + repeatable** (delegate to `qa-tester` subagent):
- Has a binary pass/fail outcome ("does login work?", "verify the upload preview appears").
- All inputs known up front (no mid-flow user decisions).
- Failure mode is clear (page didn't load, button missing, assertion failed).

**Operational + decisive** (stay in-line):
- May require mid-flow user input ("which AWS region?", "which domain?").
- Has side effects on real infrastructure or external accounts.
- Outcome isn't a clean pass/fail (you might need to backtrack and choose differently).

If verifiable: spawn the `qa-tester` subagent with the task and inputs. Surface the verdict to the user.

If operational: stay in the main conversation. BEFORE acting, call `browser_playbook_match { url, intent, taskText }` — if a high-score playbook exists, read it and follow it (asking the user for any missing inputs as needed).

After any successful in-line browser run, propose updating the matching playbook (or creating one) so future runs are faster.
```

### New slash command

`plugins/qa/commands/qa.md` — user-facing `/qa <task>` that explicitly invokes the subagent. Useful when the user wants to force delegation even for an ambiguous task.

```markdown
---
description: Dispatch a verifiable browser task to the qa-tester subagent. Use for regression checks, smoke tests, and any task with a clean pass/fail outcome.
argument-hint: "<task description>"
allowed-tools: [Task]
---

Dispatch the qa-tester subagent with the user's task: $ARGUMENTS

If the task is ambiguous (no clear pass/fail), explain why and ask the user to clarify before dispatching.
```

---

## Sub-project 3 · Auto-learning loop

### Trigger points

The auto-learning loop runs at two points:

1. **End of an in-line successful task** — main agent calls `browser_playbook_propose_update` with its trace. (New tool, see below.)
2. **End of a qa-tester subagent run** — the subagent calls the same tool before exiting.

We do *not* hook session-end automatically (too noisy — most sessions aren't task-shaped). Promotion is explicit.

### Trace → playbook transformation

Input to the promoter:
- Origin: derived from final navigated URL.
- Feature: agent-supplied label (e.g. "send-email") OR inferred from the task description.
- Inputs: parameterized variables the agent identified.
- Trace: the sequence of `browser_*` tool calls with arguments + selectors + results.
- Selector cache snapshot: `memory.js` selector entries used during the run.
- Screenshots: any `browser_screenshot` calls during the run.

Output:
- A markdown playbook file (`<origin>/<feature>.md`).
- A workflow JSON (`<origin>/<feature>.workflow.json`).
- Screenshots copied into `<feature>.screenshots/`.
- Updated `index.json`.

### Generation algorithm

```
function promote(trace, label, screenshots):
  origin = parseOrigin(trace[0].url or trace.lastNavigation)
  feature = slug(label or inferFeature(trace))
  steps = []
  for call in trace.filter(toolCalls):
    step = normalize(call)            # collapses retries, drops noise
    if step.action == 'click' or 'type':
      step.intent = call.args.intent  # require intent for stable replay
    if step.action == 'upload':
      step.filesRef = inferRef(call.args)
    steps.push(step)

  inputs = extractInputs(steps)       # finds parameterized fields
  outputs = extractOutputs(steps)     # finds anything returned (e.g. sent message id)

  if exists(origin/feature):
    existing = load(origin/feature)
    if differsOnly(in: selectors, steps): mergeAndBump(existing, steps)
    else: writeNewVersion(origin/feature, steps)   # bump playbook_version
  else:
    write(origin/feature, steps, screenshots)

  rebuildIndex()
```

`extractInputs` heuristic: look for `type` calls whose value matches a known template variable, OR was provided as an argument to the task — those become `inputs[].name`. The agent labels them via the `intent` field already used by `browser_type`.

### New tool: `browser_playbook_propose_update`

```json
{
  "name": "browser_playbook_propose_update",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label":       { "type": "string", "description": "Suggested feature slug, e.g. 'send-email'." },
      "title":       { "type": "string" },
      "verifiable":  { "type": "boolean", "default": false },
      "runId":       { "type": "string", "description": "Optional run id; if present, trace is loaded from .continuum/runs/" },
      "trace":       { "type": "array",  "description": "Or supply the trace inline." },
      "inputs":      { "type": "array",  "description": "Optional explicit input descriptors; auto-inferred if absent." },
      "outputs":     { "type": "array",  "description": "Optional explicit outputs." },
      "screenshots": { "type": "array",  "items": { "type": "string" }, "description": "Stash IDs or paths." }
    },
    "required": ["label"]
  }
}
```

Returns:
```json
{
  "ok": true,
  "playbookId": "mail.google.com/send-email",
  "created": true,             // false if updated existing
  "diffSummary": "added attachment step; updated selector for #send-button",
  "path": "/abs/.continuum/playbooks/mail.google.com/send-email.md"
}
```

### Replay self-heal

When a playbook runs and a selector fails, the existing `find_by_role_name` / `match_count` self-heal logic in `tools.js` kicks in. On heal, the new selector is written back to the cache AND the playbook's "Recent runs" log notes the heal. This is already 80% built in `memory.js` / `tools.js` — we just plumb the heal event through to playbook update.

---

## Sub-project 4 · Chained playbooks + scheduling

### Composition (chains)

A playbook may declare in frontmatter:

```yaml
composes:
  - { id: "twitter.com/post",       inputs: { text: "${input.text}", media: "${input.image}" } }
  - { id: "linkedin.com/post",      inputs: { text: "${input.text}", media: "${input.image}" } }
  - { id: "news.ycombinator.com/submit", inputs: { url: "${input.url}", title: "${input.title}" } }
```

`browser_playbook_run` resolves `composes` sequentially. Each sub-playbook executes with mapped inputs. If any sub-playbook fails (`verdict: fail`), the run halts unless the parent has `composes_on_error: continue`.

Sub-playbooks may produce outputs that become available to subsequent sub-playbooks via `${steps.<index>.output.<name>}`.

### Sequencing (`next:`)

```yaml
next: { id: "gmail.com/forward-summary-to-team", inputs: { from: "${output.lastReport}" } }
```

`next` runs *after* the parent completes successfully. Single follow-up only; for branching, use a parent playbook with `composes`.

### Scheduling

A playbook may declare:
```yaml
cron: "0 7 * * 1-5"                   # weekdays at 7am
schedule_inputs: { date: "${today}" } # input bindings for scheduled runs
schedule_inbox: "morning-briefings/"  # subdirectory under inbox/
```

Activation: the user runs `/mochi:schedule-playbook <playbookId>`. This:
1. Reads the playbook's `cron` field.
2. Invokes the existing `schedule` skill in this environment to register a recurring routine.
3. The routine, when fired, invokes `browser_playbook_run` and writes the report to `.continuum/playbooks/inbox/<schedule_inbox>/<runId>.md`.

Deactivation: `/mochi:unschedule-playbook <playbookId>` removes the scheduled routine.

We do *not* run our own cron daemon — we ride the existing harness scheduling.

### New slash commands

- `/mochi:playbook list [--origin=…] [--tag=…]`
- `/mochi:playbook show <playbookId>`
- `/mochi:playbook run <playbookId> [--input.name=value …]`
- `/mochi:playbook delete <playbookId>`
- `/mochi:schedule-playbook <playbookId>`
- `/mochi:unschedule-playbook <playbookId>`

Each is a thin shell over the corresponding MCP tool.

---

## Errors

| Code | Where | Meaning |
|---|---|---|
| `playbook-not-found` | server | `playbookId` doesn't resolve |
| `playbook-id-invalid` | server | id format wrong |
| `playbook-validation-failed` | server | frontmatter or body schema check failed; `details` lists issues |
| `playbook-input-missing` | server | required input not provided to `_run` |
| `playbook-input-type-mismatch` | server | provided input doesn't match declared type |
| `playbook-compose-cycle` | server | chain contains a cycle |
| `playbook-replay-drift` | server | workflow.json steps no longer match the DOM and self-heal exhausted |
| `qa-task-ambiguous` | qa subagent | task isn't pass/fail-shaped |
| `qa-input-missing` | qa subagent | required input absent |
| `schedule-cron-invalid` | server | `cron` field doesn't parse |
| `schedule-harness-unavailable` | server | `schedule` skill not present in environment |

---

## Security

- **Playbook frontmatter `inputs[].type: secret`** values are *never* logged to traces, runs, or inbox reports. They're resolved at runtime from one of:
  - `process.env.<name.toUpperCase()>` (developer convenience)
  - `${op://...}` reference (1Password CLI; if installed)
  - User prompt at run time (not in v1; user-prompt support deferred)
- **Path safety:** playbook files written only under `.continuum/playbooks/`. Origin component is sanitized to `[a-z0-9-.]+` (lowercase hostnames). Feature slug `[a-z0-9-]+`. No path traversal.
- **No arbitrary code execution from playbooks.** Steps are constrained to the existing wire actions: `navigate`, `click`, `type`, `press_key`, `scroll`, `wait`, `assert`, `upload`, plus `composes`/`next`. Playbooks cannot embed JavaScript.
- **QA subagent tool allowlist:** no `Edit`, `Write`, `NotebookEdit`, no destructive Bash (`rm`, `curl -X POST`, etc.). Enforced by Claude Code's subagent permission system.

---

## Testing

### Unit (server)

- `playbooks.parse(md)` — frontmatter + section extraction.
- `playbooks.serialize({ meta, body })` — round-trip a parsed playbook.
- `playbooks.validate(playbook)` — every error code triggerable.
- `playbooks.matchPlaybook` — scoring + threshold behavior on a fixture index.
- `playbooks.savePlaybook` — atomic write, screenshots copy, index rebuild.
- `playbooks.composeResolve` — cycle detection, input resolution, output passthrough.
- Promoter (`promoteFromTrace`) — produces expected playbook from a synthetic trace.

### Contract (wire)

- Each new tool builds the right payload for representative inputs.
- `browser_playbook_run` returns a structured result with verdict + evidence.

### Integration (against fixture pages)

Reuse the upload-fixture HTTP server. Add three new fixture pages:
1. `_fixtures/playbooks/pages/login-form.html` — form with username/password/submit + success banner.
2. `_fixtures/playbooks/pages/compose-form.html` — Gmail-ish compose: to/subject/body/attach/send.
3. `_fixtures/playbooks/pages/multi-step.html` — three-step wizard exercising `next` chains.

End-to-end runner (`_playbook_e2e.mjs`):
- Stage a playbook for each fixture.
- Run via `browser_playbook_run`.
- Assert verdict, screenshots, network log.
- Mutate the fixture (rename a button) → assert self-heal updates the playbook.

### Smoke

Add to existing `_smoke.mjs`: assert the 7 new tools register with valid schemas; total tool count = 48.

---

## Acceptance criteria

1. `browser_playbook_*` tools register and surface in `tools/list`.
2. A playbook saved with valid frontmatter and body round-trips through save→get→list→match.
3. The qa-tester subagent dispatches via the `Agent` tool with `subagent_type: 'qa-tester'` and returns one of the three verdict shapes.
4. `/qa <task>` slash command dispatches the subagent and surfaces the verdict.
5. Smart-router rule lands in plugin CLAUDE.md and is read by main agent on plugin install.
6. `browser_playbook_propose_update` after a successful run produces a valid playbook file + screenshots + index entry.
7. Self-heal during replay updates both selector cache and playbook "Recent runs" log.
8. Compose: a 3-leg chain runs sequentially; output of leg 1 feeds leg 2's input.
9. Cron scheduling: a playbook with `cron: "*/5 * * * *"` registered via `/mochi:schedule-playbook` actually fires via the env's schedule skill and writes to `.continuum/playbooks/inbox/`.
10. All existing tests remain green (no regression in upload tools, smoke, integration, multi-client).
11. Smoke test confirms 48 tools total.

---

## Out of scope (v1.5+)

- **Codebase-derived seeding** (static analyzer over the project's frontend to pre-fill playbooks).
- **Visual diff regression** (per-step screenshot diff with N% threshold).
- **Interactive secret store** (1Password CLI integration; user-prompt-at-runtime for missing secrets).
- **Cross-plugin sharing** (export/import playbook bundles between projects).
- **Headless mode** (running playbooks without a visible Chrome — currently requires the Mochi extension attached).

---

## Open threads

- **Origin canonicalization edge cases:** Subdomains (mail.google.com vs google.com), country TLDs (amazon.co.uk vs amazon.com), staging-vs-prod (staging.acme.com vs acme.com). v1 stores exact hostname; future enhancement could allow tag-based aliases (`tags: [amazon-marketplace]` shared across regional domains).
- **Multi-tab playbooks:** Some flows span tabs (OAuth popup, then back to the parent). v1 supports same-tab + same-origin frames; multi-tab is a v1.5 expansion.
- **Playbook diff UI:** When a playbook auto-updates after a self-heal, the diff is recorded in "Recent runs" but there's no review UI. Future: `/mochi:playbook diff <id>` to show what changed.
- **Inputs with file[] type and the new upload tool:** The replay step `{ action: "upload", filesRef: "input.attachments" }` maps to `browser_upload_file` with `files: input.attachments`. Verified that the upload tool's `files: []` parameter accepts arrays of stash refs. (Confirmed in `2026-05-19-browser-file-upload-design.md`.)

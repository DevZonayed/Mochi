---
description: Dispatch a verifiable browser task to the qa-tester subagent. Use for regression checks, smoke tests, and any task with a clean pass/fail outcome. Supports an EXHAUSTIVE mode that verifies every control behind an honesty gate.
argument-hint: "<task description>  |  exhaustive <url/app>  |  --exhaustive"
allowed-tools: [Task, Bash]
---

## Mode select

Inspect `$ARGUMENTS` and pick ONE mode:

- **EXHAUSTIVE mode** — choose this when `$ARGUMENTS` begins with `exhaustive`, contains `--exhaustive`, or contains intent phrases like "test everything", "click every button", "make everything dynamic / nothing static", or "exhaustive QA". Follow the **Exhaustive QA mode** section below.
- **Single-dispatch mode** (default) — everything else. Follow the **Single dispatch** section below.

---

## Single dispatch

Dispatch the `qa-tester` subagent with the user's task: $ARGUMENTS

Use the `Task` (Agent) tool with `subagent_type: "qa-tester"` and pass the user's task verbatim as the prompt. If the task is clearly ambiguous (no clean pass/fail outcome) explain why and ask the user to clarify before dispatching.

After the subagent returns its verdict, surface a short summary to the user:
- On `pass`: "✓ Task passed via playbook `<id>` (run `<id>`). Evidence: <screenshots/network summary>."
- On `fail`: "✗ Task failed: `<reason>`. Evidence: <…>. Suggest re-running with adjusted inputs."
- On `blocked`: "Cannot run as-is: `<reason>`. Need: <missing input or clarification>."

---

## Exhaustive QA mode

GOAL: verify EVERY actionable control on the target app — not "the page renders", but "each control was exercised and we observed what it did". The five verdicts you assign each control are **WORKS, NO-OP (defect), ERROR (defect), NAVIGATES, DISABLED**. Render != Works. A clickable control that does nothing is a NO-OP — a defect, not a pass.

Pick a short `<app>` slug (e.g. the host/feature, used for the ledger) and the base URL from `$ARGUMENTS`. Then run this coverage-driven loop. You MAY parallelize by spawning the `qa-tester` subagent per (role × route) and merging the partial coverage matrices each returns; but the honesty gate below is run ONCE at the end over the merged ledger.

### 1. PRE-FLIGHT — confirm you are testing the right build
- `browser_navigate { url, hardReload: true }` — cache-bypass load so you are not testing a stale bundle.
- `browser_page_assets { hash: true }` — capture the LIVE bundle hash(es). If you know the built hash, confirm live == built (stale-bundle guard). Note: `browser_emulate_viewport` changes JS layout (`window.innerWidth` / `matchMedia` via CDP device metrics); `browser_window_resize` only moves the OS window and does NOT affect JS layout — use `browser_emulate_viewport` for breakpoint coverage.
- `browser_assert_no_errors { sinceNavigation: true }` immediately after load. Treat any pre-existing console buffer as UNTRUSTED — `sinceNavigation:true` scopes to the current page so you do not get a false "no errors" from stale buffers.

### 2. INVENTORY — enumerate routes × roles × breakpoints
- Build the cross product of routes × roles (e.g. anon, user, admin) × breakpoints (e.g. 375 / 768 / 1280 via `browser_emulate_viewport`).
- On EACH route, call `browser_audit_interactives { scope: "all" }` to list EVERY actionable control (selector, role, accessibleName, visible, inViewport, disabled, hasClickHandler). If `truncated`, raise `limit` and re-audit until complete.
- Seed a coverage matrix where every (route, control) cell starts **UNTESTED**.

### 3. VERIFY EACH CONTROL — classify with evidence
For each control in the matrix:
- `browser_act_and_observe { action: { type, ref, text?, url?, key? }, settleMs: 800 }`.
- Classify from the returned `classification` + deltas:
  - **WORKS** — observable effect: a 2xx in `networkDelta` and/or `domChanged`/`urlChanged`.
  - **NO-OP** — clickable but nothing happened (no DOM/route/network change). A dead control = **defect**.
  - **ERROR** — a console error/exception in `consoleDelta`, or a `>=400`/failed request. READ the captured response `.body` and record it.
  - **NAVIGATES** — the control routed/navigated as intended (`urlChanged`).
  - **DISABLED** — record WHY (e.g. "disabled until form valid"); a disabled control is not a failure but must be explained.
- After EACH action, call `browser_assert_no_errors { sinceNavigation: true }` (it is `ok:false` on any console error/exception OR any `>=400`/failed request since load). Fold its result into the verdict.
- Record each verdict to the ledger:
  ```
  node "$(cat .continuum/.plugin-root)/lib/verification_ledger_cli.js" record \
    --app <app> --route <route> \
    --element '{"selector":"…","accessibleName":"…","verdict":"WORKS|NO-OP|ERROR|NAVIGATES|DISABLED","evidence":"…","reason":"…"}'
  ```
  (The ledger lives at `.continuum/verification/<slug>.json`.) Flip the matrix cell from UNTESTED to its verdict.
  > Run the record commands and the honesty gate (step 6) from the SAME working directory — both default the `.continuum/` location to `CLAUDE_PROJECT_DIR || cwd`. If you pass `--project-dir <dir>` to one, pass the identical value to the other, or they will target different ledgers.

### 4. PROVE WRITES PERSIST — "UI updated" != "persisted"
After any create / edit / delete / save:
- Either `browser_wait_for_response { urlContains: "<save endpoint>", method: "POST|PUT|PATCH|DELETE", statusGte: 200, statusLt: 300 }` to prove the write hit the backend, OR re-load with `browser_navigate { hardReload: true }`.
- Then re-read the page (`browser_snapshot` / `browser_text`) and confirm the change actually stuck. If it only changed the DOM but did not persist, that is a defect.

### 5. UNHAPPY PATHS
Cover, per route/role:
- Empty states (no data).
- Invalid input (validation must fire; do not let a bad value through).
- Wrong-role access (expect a `403`, not a silent allow).
- Expired / missing auth — re-seed deterministically with `browser_set_storage { localStorage, cookies, clear }`, then re-test.
- Backend-misconfig — the UI must show a graceful message, NEVER a raw `500` / stack trace.

### 6. HONESTY GATE — non-negotiable
- Run the machine-checkable gate over the merged ledger. Resolve its path the
  same install-robust way as the record step (qa_coverage.js sits in the qa
  plugin, a sibling of the continuum plugin that `.plugin-root` points at):
  ```
  node "$(cat .continuum/.plugin-root)/../qa/lib/qa_coverage.js" --app <app>
  ```
  (add `--project-dir <dir>` to MATCH whatever you passed to the record step; add `--require-clean` to also fail on defects). Exit codes: `2` = coverage incomplete (any UNTESTED/UNCERTAIN — CANNOT claim pass), `1` = `--require-clean` and defects exist, `0` = complete (and clean when required).
- The run CANNOT be reported "pass" while ANY cell is UNTESTED or UNCERTAIN. If the gate prints `GATE: BLOCKED`, the run is not a pass — surface what is missing and either finish testing it or report it as a known gap.
- Output to the user:
  1. A coverage **TABLE** — every control + its verdict + evidence (you can paste the gate's table).
  2. An explicit **"Did NOT verify / why"** list. Untestable items are reported as known gaps, NEVER silently dropped.
- End with the mandated phrasing, with real numbers:
  > **"N of M controls verified — here is each result, and here is what I could not verify and why."**
- NEVER say "everything works."

---
description: Agent-driven design QA — walk the running app, judge design/UX, and drop a Comment-Mode comment on every issue (visible to the human as pins). Then read the session back and fix everything in bulk. Optional focus argument steers the pass.
argument-hint: "[focus…]  |  fix [sessionName]  |  list [sessionName]"
---

You run a **design-QA loop** that bridges the browser MCP and Comment Mode. Comments
the agent creates appear to the human as live pins in the Mochi extension (they share
`chrome.storage.local`), and Comment Mode is auto-activated on the session tab so the
pins show up without the human opening it first. Inspect `$ARGUMENTS` and pick a mode.

> **Same Chrome required.** Pins are stored per Chrome **profile**. The human sees them
> only in the same Chrome the agent drove — i.e. the one whose Mochi extension is
> connected (auto-connect on). If the MCP auto-launched its own Chrome window, review the
> comments in **that** window, not a separate Chrome.

## Mode: `fix` / `list` (when `$ARGUMENTS` starts with `fix` or `list`)
1. `browser_comment_list { sessionName }` (pass the name after `fix`/`list` to scope; omit to list this site's sessions for the current tab). 
2. For `list`: print the comments grouped by route (n · route · selector · text · severity · resolved) and stop.
3. For `fix`: for each unresolved comment, locate the code that renders `selector` on `route`, make the fix, and call `browser_comment_resolve { id }`. Work in dependency-safe order; commit logically. Report a summary (fixed / skipped + why). Do NOT mark resolved unless actually fixed.

## Default mode: run the design-QA pass
**1. Name the session meaningfully (project-wise, reflecting the latest changes).**
Run in the repo:
```bash
echo "$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)") · $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main) — QA $(date +%Y-%m-%d)"
```
Use that string as `sessionName` for every `browser_comment_add`. (Re-running on the same branch/day appends to the same session.)

**2. Open the app.** Ensure a browser session: `browser_session_start { url }` (ask for / infer the dev URL, e.g. `http://localhost:3000`). Determine the routes to check — from `$ARGUMENTS`, the user, or by crawling visible links (`browser_links`).

**3. For each route** (and, when relevant, common breakpoints via `browser_emulate_viewport` — use widths that match the extension's device presets so pins are revealable in the device frame: **375, 390, 768, 1024, 1280, 1440**; clear with `browser_clear_emulation`):
- `browser_navigate { url }`, then `browser_screenshot`, `browser_audit_interactives { scope:"all" }`, and `browser_assert_no_errors { sinceNavigation:true }`.
- **Judge design/UX.** Default heuristics: spacing/alignment/rhythm, visual hierarchy, contrast & legibility, overflow/clipping/truncation, broken or empty/loading/error states, responsive breakage at the current width, obvious accessibility (labels, alt text, focus, target size), and copy (typos, clarity, consistency). **If `$ARGUMENTS` provides a focus** (a checklist, a design system / Figma reference, or a scope like "mobile + forms only"), prioritize it and stay on-target.
- **For each issue:** `browser_comment_add { selector, text, sessionName, severity, breakpoint? }`.
  - `selector` = a precise CSS selector for the element (use refs from `browser_snapshot` / `browser_audit_interactives`). Check the response's `located`: if it is `false` the selector didn't resolve — retry with a better selector so the pin lands on the real element.
  - `text` = a concrete, actionable instruction (what's wrong + the fix), not a vague observation.
  - `severity` = `high | medium | low`.
  - `breakpoint` = `{ label, width }` when the issue is breakpoint-specific (use a preset width above so it's visible in the device frame).

**4. Finish.** Report: the **session name**, total comments by severity, and routes covered + any you could NOT check (and why — never silently drop). Tell the user:
> Open the Mochi extension → Comment mode → the **"<session name>"** session to review/edit the comments (they're pins on the elements). When ready, run `/mochi:design-qa fix "<session name>"` and I'll fix them in bulk.

Keep it honest: only comment on things you actually observed in the screenshots/audit; prefer fewer, high-signal comments over noise.

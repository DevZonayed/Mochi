# Design-QA loop — agent QA → comments → human review → bulk fix

**Date:** 2026-06-09 · **Status:** approved (brainstorming), pending spec review
**Approach:** A (bridge tools) + C (default heuristics + optional focus)

## Problem / goal
Close the loop between the **browser MCP**, the **QA skills**, and **Comment Mode**:
an agent runs a **design QA** pass over a running app, drops a **comment on every
issue** (anchored to the exact element/route/breakpoint), the user **sees and
edits those comments client-side** in Comment Mode, and then the agent **reads the
session and fixes everything in bulk** in code.

The enabling insight: Comment Mode comments already live in
`chrome.storage.local["mochiComments"]`, shared across the whole extension. If the
agent can write that store, its comments appear as pins in the user's Comment Mode
automatically (live, via `chrome.storage.onChanged`).

## The loop
1. **Agent QA** — drive Chrome via the browser MCP across routes (and optionally
   breakpoints); screenshot + `browser_audit_interactives` + `browser_assert_no_errors`;
   judge design/UX; write a comment per finding into a named session.
2. **Client-side review** — user opens Comment Mode → the QA session → pins on the
   real elements, grouped by route; edits / deletes / adds their own.
3. **Bulk fix** — agent reads the session (`browser_comment_list`), fixes each item in
   code, and marks it resolved (`browser_comment_resolve`) so progress shows on the pins.

## New browser-MCP tools (the bridge)
All write/read `mochiComments` via the extension background (read-modify-write), so they
round-trip with the content script. Comment + session shapes EXACTLY match Comment Mode v2.

- **`browser_comment_add`** `{ ref|selector, text, sessionName?, breakpoint?, severity? }`
  → resolves the element on the active session tab (verify selector, compute box, read
  `route`/`url`/`origin` + `tagName`/`role`/`elementText`), finds-or-creates the named
  session for that origin, assigns `n = maxN+1`, pushes the comment (fields: `id, sessionId,
  n, text, url, route, origin, selector, tagName, role, elementText, box, viewport,
  breakpoint, severity?, createdAt`), bumps `updatedAt`, and **sets that session active for
  the origin on first add** (so the user sees its pins immediately). Returns `{ id, n,
  sessionId, sessionName }`.
- **`browser_comment_list`** `{ sessionName?|sessionId?, origin?, includeResolved? }`
  → returns the structured comments (sorted, grouped-by-route friendly) for bulk fixing.
- **`browser_comment_sessions`** `{ origin? }` → list sessions (id, name, origin, count, updatedAt).
- **`browser_comment_resolve`** `{ id, resolved? = true }` → mark a comment resolved.
- *(Tool count grows by 4; bump the smoke/integration assertions.)*

### Element resolution
`browser_comment_add` resolves the element in the agent's session tab via a tiny
`chrome.scripting.executeScript` helper (selector → `{ ok, selector, box, route, url,
origin, tagName, role, text }`), reusing the same `uniqueSelector` logic Comment Mode uses
so selectors are consistent. If `ref` is a CSS selector that matches, use it; else fall back
to the agent-provided selector verbatim and flag `resolved:false` box.

## Meaningful, project-wise session names (added)
- The agent passes a **meaningful** `sessionName` derived from project context:
  `<repo-basename> · <git-branch> — QA <date>` (the "latest changes" context = the
  current branch/feature the user is working on). `/mochi:design-qa` computes this
  (it runs in the repo: `git rev-parse --abbrev-ref HEAD`, repo basename).
- `browser_comment_add` finds-or-creates by `sessionName` for the origin, so re-running
  QA on the same branch appends to the same session (idempotent by name).
- **Browser-created sessions** also get a meaningful default name (not "Session N"):
  the page's `document.title` (app name) — e.g. `"My App — review"` — falling back to the
  origin host. Renameable as today.

## Browser session selector (added)
- A **prominent, always-visible current-session selector** in Comment Mode so the user can
  pick the active session and comment into the **same** session the agent used.
- Implementation: a **session pill** in the navigator header (and shown even when the
  navigator is closed, as a small label above the FAB) showing the active session's name;
  clicking it opens a compact **switcher dropdown** listing this origin's sessions (active
  one checked) + "＋ New". Selecting one calls `switchSession` (active), so subsequent user
  comments go into it. Keeps the existing Sessions view too.

## Comment Mode rendering (small additions)
- **`severity`** — optional `low|medium|high`; tints the pin (grey/amber/red) and shows a
  chip in the list. Defaults to none (current blue).
- **`resolved`** — resolved comments render struck-through / dimmed in the list and a
  checkmark pin; a filter toggle "hide resolved". No data removed.
- Backwards-compatible: missing fields render exactly as today.

## `/mochi:design-qa` skill (orchestration)
`/mochi:design-qa [focus...]`
- **Default heuristic pass:** for each route to check (discovered from the app or given),
  optionally at common breakpoints (`browser_emulate_viewport`): capture screenshot +
  `browser_audit_interactives` + `browser_assert_no_errors`; evaluate against built-in
  design/UX heuristics — spacing/alignment, contrast/legibility, overflow/clipping, broken
  or empty states, responsive breakage, obvious a11y (labels/alt/focus), and copy. For each
  issue → `browser_comment_add` into session **"Design QA — <date>"** with a concrete,
  actionable instruction + severity.
- **Optional focus (`[focus...]`)** — steers the pass: a checklist, a design system / Figma
  reference, or a scope ("mobile + forms only"). Folded into the judgment prompt; comments
  stay on-target.
- Ends by reporting the session name + count; tells the user to open Comment Mode to review.
- **Fix mode** (`/mochi:design-qa fix [sessionName]` or just ask): `browser_comment_list`
  → fix each in code → `browser_comment_resolve` per item.

## Architecture / files
- `server/src/tools.js` — 4 tool schemas + `TOOL_TO_WS_TYPE` entries; local-ish handling
  (these go through the bridge to the extension which owns storage).
- `extension/background.js` — wire types `comment_add/list/sessions/resolve`: read-modify-write
  `mochiComments`, element-resolve helper, numbering, active-on-first-add. Reuse Comment
  Mode's comment/session shape (extract the shared shape so both stay in sync).
- `extension/comment-mode.js` — severity + resolved rendering (+ "hide resolved" filter).
- `plugins/qa/commands/design-qa.md` (or skill) — the orchestration prompt.
- Tests: `server/_smoke.mjs` + `_integration.mjs` tool-count + a `comment_add/list` round-trip
  against the fake extension.
- Rebuild `server/dist/server.bundle.mjs`.

## Risks / call-outs
- **Read-modify-write races** with the user editing concurrently are mitigated by Comment
  Mode's flush-before-adopt guard + sequential agent calls; acceptable for v1.
- **Selector stability** across the agent's tab vs the user's tab relies on the shared
  `uniqueSelector` (id → nth-of-type path) — same basis as today's pins.
- **Design judgment quality** is model-dependent; the focus arg + screenshots + audit data
  ground it. Severity lets the user triage.

## Out of scope (v1)
- Auto-fixing without human review (the loop keeps a human gate by default).
- Visual-diff/baseline regression (separate from subjective design QA).
- Pixel-level Figma comparison (focus arg can reference Figma, but no automated diff).

## Versioning
Minor bump (**0.9.0**) — new tools + skill + rendering. Extension reload + restart as usual.

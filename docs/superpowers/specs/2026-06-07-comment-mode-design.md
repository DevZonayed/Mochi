# Mochi Comment Mode — design (self-brainstormed)

**Date:** 2026-06-07 · **Status:** building autonomously (user said: design it yourself, no questions, make it perfect)

## Problem

The existing in-page hint modal (`mochi-modal.js`, ⌘⇧M) is powerful but hard to
use: it requires a **running Claude session** to send to, and it's a one-shot
"pick element + type + send" flow. There's no way to just walk a page, drop
several visual comments, and hand the whole thing to *any* coding agent.

## Goal

A **standalone visual annotation mode** ("Comment Mode") that needs no Claude
session. One click enables it; the user drops comments on elements across
pages and breakpoints; at the end they **copy one agent-ready brief** and paste
it into any coding agent, which then has everything (selector + route +
breakpoint + element context + the note) to act precisely.

## Principles

- **Zero dependency on a session.** Everything is local (`chrome.storage.local`).
- **Never block scrolling.** The user must roam the page freely while commenting.
- **Survive navigation & reload.** Comments persist; the FAB + pins reappear.
- **Output is text.** The export is markdown a coding agent can act on (no images
  required — selectors + routes are what an agent needs).

## UX

### Entry
- Popup: **💬 Comment mode** → one click starts a session on the active tab.
- Keyboard: **⌘⇧C / Ctrl+Shift+C** toggles it too.

### Floating Action Button (FAB) — bottom-right, shadow-DOM, draggable
- Primary tap → toggle **pick-&-comment** mode.
- Count badge = number of comments.
- Expander reveals a vertical menu (icon buttons):
  - **New comment** (pick element)
  - **Comments** (opens the list panel) — shows count
  - **Responsive** (device-frame switcher)
  - **Copy brief** (export → clipboard)
  - **End** (close session)

### Pick & comment
- Hover highlights elements (reuse the modal's picker pattern; works while the
  page scrolls — picking is via document-level capture listeners + `elementFromPoint`).
- Click element → a **comment popover** (textarea + Save/Cancel) anchored near it.
- Save → store the comment + drop a **numbered pin marker** on the element.
- `Esc` cancels pick mode.

### Pin markers
- Numbered circular badges anchored to each commented element on the **current
  route**. Repositioned on scroll/resize via a throttled `rAF` loop
  (`querySelector(selector)` → `getBoundingClientRect`). If the element is gone,
  the pin parks at the viewport edge as "detached."
- Click a pin → reopen that comment (edit / delete / view).

### Comments list (iOS-style slide-over)
- Lists all comments grouped by **route**, each row: `#n`, snippet, breakpoint
  badge, route. Tap a row → if on the same route, scroll-to + flash the element;
  otherwise show its route. Per-row delete.

### Responsive mode
- Device switcher: 375 (iPhone SE), 390 (iPhone), 768 (iPad), 1024, 1280, 1440,
  + custom width.
- Implementation: a full-screen **device-frame overlay** containing an `<iframe>`
  of the current URL at the chosen width — the page genuinely reflows (real
  media queries), the user's window is untouched.
- Picking/commenting inside the frame attaches the picker to the iframe's
  same-origin `contentDocument`; comments get `breakpoint = {label, width}`.
- **Graceful fallback:** if the page refuses framing (X-Frame-Options / CSP) or
  the contentDocument is cross-origin, show a notice and keep the rest working.

### Scroll-teach animation
- Because comment mode keeps the page scrollable (unlike the old modal), show a
  **one-time** animated hint on first start (a glyph with a bouncing down-arrow +
  "Scroll freely — comment anywhere"). Fades after a few seconds; flag stored so
  it never repeats.

### Export ("Copy brief")
Markdown copied to clipboard, e.g.:

```
# Mochi review — http://localhost:3000 — 3 comments
Generated 2026-06-07T…Z. Each item has a CSS selector + route so you can locate the element.

## 1 · /dashboard · [iPhone 390]
- selector: `main > section.stats > div:nth-of-type(2)`
- element: <div> "Total revenue" (role=group)
- box: 24,180 312×96 @ 390×844
- comment: This number overflows its card on mobile.

## 2 · /dashboard
- ...
```

## Architecture

- **`extension/comment-mode.js`** — one self-contained IIFE, closed shadow DOM,
  injected on demand. Owns: state load/save, FAB, picker, popover, pins, list,
  responsive frame, scroll-teach, export. Re-entrant (guards on host id; if
  already present, just re-syncs).
- **`extension/background.js`** — adds:
  - `popup_start_comment_session` → inject `comment-mode.js` into the active tab.
  - `comment_register_tab` / `comment_unregister_tab` (from the content script) →
    maintain a persisted set `mochiCommentTabs` of tabs to keep injected.
  - On `tabs.onUpdated` (`status==="complete"`, http(s)) for a registered tab →
    re-inject so the FAB + pins survive navigation/reload.
  - `chrome.commands` `toggle-comment-mode` (⌘⇧C).
- **`extension/popup.html` / `popup.js`** — a "Comment mode" section with a
  **Start commenting** button (and Stop when active).
- **`extension/manifest.json`** — add `comment-mode.js` to
  `web_accessible_resources`, add the `toggle-comment-mode` command.

### Storage model (`chrome.storage.local`)
```
mochiCommentSession = {
  active: boolean,
  startedAt: number,
  taughtScroll: boolean,
  comments: [{
    id, n, text,
    url, route,                 // route = pathname + search
    origin,
    selector, tagName, role, elementText,
    box: {x,y,w,h},             // page coords at capture
    viewport: {w,h,dpr},
    breakpoint: {label,width} | null,
    createdAt
  }]
}
mochiCommentTabs = [tabId, ...]   // background-managed injection set
```

## Risks / call-outs
- **Iframe responsive** depends on same-origin + no X-Frame-Options; fine for
  localhost dev (the target use case), degrades gracefully otherwise.
- **Selector stability** uses the modal's `uniqueSelector` (id → nth-of-type
  path); good enough to locate elements for an agent.
- Pins track elements by selector each frame; cheap, but very large pages with
  hundreds of comments would want batching (not a v1 concern).

## Out of scope (v1)
- Per-comment screenshots (selectors + routes are what agents need; images don't
  paste into coding agents). The export is pure text.
- Threaded/multi-user comments, cloud sync.

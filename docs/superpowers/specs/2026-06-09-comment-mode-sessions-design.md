# Comment Mode v2 — Sessions, navigation & dock UI

**Date:** 2026-06-09 · self-designed (non-technical user; build it, iterate on feedback)

## Goals (from user)
1. **Sessions are first-class** — saved, named, **domain/port-scoped**. A brand-new session starts from zero.
2. **Filter** sessions by *this site* vs *all sites (global)*; **switch** to any session.
3. **Route-wise comments** load within a session (pins per route).
4. **Navigation:** click a comment → smooth-scroll to that element/section; if it's on another route/page, **navigate there first, then scroll**.
5. **UI:** floating navigator; replace text buttons with **icons**; FAB reveals actions on hover with a **macOS dock-style** animation. Super smooth.

## Storage model
Keep `mochiCommentSession` (background-owned on/off + `commentTabs`) unchanged. Add a **content-owned** key `mochiComments`:

```
mochiComments = {
  v: 2,
  taughtScroll: bool,
  activeByOrigin: { [origin]: sessionId },   // active session per site
  pending: { commentId, ts } | null,         // scroll target that survives navigation
  sessions: {
    [id]: {
      id, name, origin, createdAt, updatedAt,
      comments: [ { id, n, text, route, url, origin, selector, tagName, role,
                    elementText, box, viewport, breakpoint, createdAt } ]
    }
  }
}
```
- **Active session** for the current origin = `sessions[activeByOrigin[origin]]`; auto-created (`"Session 1"`) on first use.
- **New session:** create fresh (origin = current), set active → blank slate.
- **Rename / Delete / Switch** operate on sessions; switch sets `activeByOrigin[origin]`.
- **Migration:** if `mochiComments` is absent but legacy `mochiCommentSession.comments` exist, group them by origin into one session each (`"Session 1"`).
- Comments still carry `origin`+`route`+`url`+`selector`; all comments in a session share the session's origin.

## Navigation (click-to-locate)
`navigateToComment(c)`:
1. If `document.querySelector(c.selector)` exists on the current page → smooth `scrollIntoView({block:"center"})` + flash a pin marker.
2. Else → write `pending = { commentId }`, set `activeByOrigin[targetOrigin] = c.sessionId`, then `location.href = c.url` (handles route **and** domain changes; full load is universal incl. SPA routes).
3. On bootstrap **and** on SPA route change, if `pending` matches the current route, poll briefly (~2.5s, rAF) for the element, scroll + flash, clear `pending`.

## UI
**Dock FAB** (bottom-right): one bubble. The FAB click = start/stop **commenting** (sticky pick, unchanged). A **dock** of round **icon** buttons sits above it, revealed on hover of the FAB area (or a tap toggle) with a **staggered spring** (`opacity`+`translateY`+`scale`, per-item delay, `cubic-bezier(.16,1,.3,1)`), each with a hover **tooltip**:
- 🧭 Navigator · 🖥 Responsive · 📋 Copy brief · ⛔ End. (New-comment = the FAB itself.)

**Floating Navigator** (draggable card, not a full-height drawer) with two views + a back transition:
- **Sessions view:** filter chips **[This site | All]**; rows = session name (rename inline), origin, comment count, "updated" hint; tap a row → open its **Comments view**; current session badge; **＋ New session**; per-row delete; a row action to **make active**.
- **Comments view:** header (← back, session name, make-active) → comments grouped by **route**; tap a comment → `navigateToComment`; per-row delete; footer **Copy brief** (this session). 

**macOS feel:** spring easing, backdrop blur, rounded corners, soft shadows, icon-only controls with tooltips.

## Preserve (do not regress)
Top-frame guard; closed shadow; sticky scale-aware picker (host-click passthrough, Esc on both docs); anchored pins (rAF); popover (Enter save / Esc / click-outside / resume); responsive frame (custom + scale-to-fit + auto-arm); SPA route detection (history patch + popstate/hashchange); cross-tab `storage.onChanged`; teardown removes **all** listeners; one-time scroll-teach.

## Versioning
Minor bump **0.8.0** (significant feature). Extension reload required as usual.

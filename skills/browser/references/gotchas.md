# Browser tooling gotchas (read before trusting results)

The canonical, durable note of hard-won quirks in the Mochi browser MCP. These
are mistakes that are easy to make and expensive to re-learn. Each one has the
fix. When in doubt, trust this file over intuition.

Tool names below are written without the namespace prefix. The full callable
name is `mcp__plugin_mochi_browser__<name>` (e.g. `browser_assert_no_errors`).

---

## 1. The console buffer is stale until you scope it

**Trap:** reading console messages without scoping returns the *whole buffer*,
including messages from before you navigated. An old clean buffer reads as a
false "no console errors" — a clean bill of health that is a lie.

**Fix:** always read with `sinceNavigation:true` (and/or clear) before you trust
"no console errors":

```
browser_console_messages {level:"error", sinceNavigation:true}
```

- `sinceNavigation:true` scopes to the current page load only.
- `level:"error"` **includes uncaught exceptions**, not just `console.error`.
- The one-call equivalent is `browser_assert_no_errors` (defaults to
  `sinceNavigation:true`) — prefer it as a gate.

---

## 2. Prefer selector clicks over coordinate clicks

**Trap:** `browser_click_at {x, y}` clicks a fixed pixel. The moment the layout
shifts — a banner loads, fonts swap, an ad reflows — those coordinates point at
the wrong thing (or nothing). Coordinate clicks drift.

**Fix:** prefer `browser_click` with an `intent` (selector / ARIA role+name
resolution). It survives layout shifts, caches the selector for next time, and
self-heals on replay. Reach for `browser_click_at` only when there is genuinely
no selectable element (canvas, map tile, custom-painted UI).

---

## 3. `emulate_viewport` changes JS layout; `window_resize` does not

**Trap:** assuming `browser_emulate_viewport` "only affects screenshots," or
using `browser_window_resize` to test responsive breakpoints. Conflating the two
is a classic mistake.

**Fix — know the difference:**

- **`browser_emulate_viewport`** drives CDP
  `Emulation.setDeviceMetricsOverride`. It **changes `window.innerWidth` /
  `window.innerHeight` and flips `matchMedia` / CSS media queries.** This is the
  tool for media-query and responsive testing — real JS layout responds to it.
- **`browser_window_resize`** only moves/resizes the OS-level Chrome window. It
  does **NOT** change `window.innerWidth` or `matchMedia`; the page's JS layout
  is untouched. Use it only when you need true OS window dimensions.

Reset emulation with `browser_clear_emulation`.

---

## 4. Confirm the live bundle hash after every deploy

**Trap:** you deploy, reload, and test — but the browser served a stale cached
bundle. Your "fix verified" was against the old code.

**Fix:** after any deploy, confirm the **live bundle hash == the built hash**
before trusting results:

```
browser_navigate {url, hardReload:true}      # cache-bypass load
browser_page_assets {types:["script"], hash:true}   # sha256 per asset + pageHash
```

Compare the returned `sha256` / `pageHash` against your build output. If they
don't match, you're testing stale code. `hardReload` and `disableCache` on
`browser_navigate` defeat the cache.

---

## 5. Long sessions: tokens expire — re-seed deterministically

**Trap:** in a long run, an access token in `localStorage` / a cookie expires
mid-flow. Subsequent actions silently 401 and look like app bugs.

**Fix:** re-seed state deterministically with `browser_set_storage`, then
hard-reload:

```
browser_set_storage {localStorage:{token:"…"}, cookies:[{name:"session", value:"…"}]}
browser_navigate {url, hardReload:true}
```

This also makes flows start from a known logged-in state without re-driving the
whole login UI every time.

---

## 6. "Internal server error" — read the response body, don't guess

**Trap:** an action returns "Internal server error" and you start guessing at
frontend causes. Most of the time it's a backend/env misconfig (e.g. SMTP not
configured, missing env var, DB unreachable).

**Fix:** read the actual response body. `browser_network_requests`
**auto-includes the response body for `>=400`/failed requests**:

```
browser_network_requests {sinceNavigation:true, includeBody:true}
```

`browser_assert_no_errors` also surfaces `.body` on failed-request entries. The
body almost always names the real cause.

---

## 7. Render != Works — prove the action did something

**Trap:** a control is visible and clickable, so you call it "working." Visible
and clickable is **not** verified. A dead button renders perfectly.

**Fix:** drive the control and observe the result:

- `browser_act_and_observe` classifies each action as
  **WORKS / NO-OP / ERROR / NAVIGATES**. A **NO-OP** (clickable but nothing
  changed — no DOM change, no URL change, no network) is a **dead control =
  defect**, not a pass.
- Gate every page load and every action with `browser_assert_no_errors`.
- For writes, prove persistence: reload / re-query, or use
  `browser_wait_for_response` to confirm the save request actually returned 2xx.

---

## 8. Coverage — enumerate before claiming "tested everything"

**Trap:** clicking a few obvious buttons and reporting "everything works."
Everything you didn't touch is **UNTESTED**, not passing.

**Fix:** enumerate every actionable control with `browser_audit_interactives`
*before* claiming coverage:

```
browser_audit_interactives {scope:"all"}   # selector/role/name/disabled per element
```

Then drive each one and record a verdict. The five verdicts are **WORKS**,
**NO-OP** (defect), **ERROR** (defect), **NAVIGATES**, **DISABLED**.

**The honesty rule:** never say "everything works." Say *"N of M controls
verified — here is each result, and here is what I could NOT verify and why."*
A run cannot be reported as **pass** while any control is UNTESTED / UNCERTAIN.
The `/qa exhaustive` honesty gate enforces this for you.

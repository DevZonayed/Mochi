# Testing Continuum (Phase 1 + 2)

Two layers of test:

| Layer | What it validates | Cost | When to run |
|---|---|---|---|
| **Synthetic pipeline** (`tests/run-synthetic.sh`) | All hooks, helpers, MCP server wire protocol, recall scoring, dream tombstones, feedback dedup, sentinel flow. No Claude required. | Free, ~5s | Every change to plugin internals |
| **Real-Claude scenario** (below, "Heavy test") | End-to-end behavior with a real model: bootstrap directive, STATE.md regeneration, recall-without-rereading, rollup quality. | Tokens, ~5 sessions | Before declaring a phase done |

---

## 1. Synthetic pipeline test (run first, every iteration)

```bash
# From the repo root:
bash plugins/continuum/tests/run-synthetic.sh
```

Exit code 0 means all 100 invariants passed. Failures print the assertion + the offending state.

This simulates Claude's hook lifecycle by feeding crafted JSON to each hook script and asserting on file outputs. It catches regressions in:
- **Phase 1**: bootstrap detection, link id sequencing, transcript gzip, sentinel flow, SessionStart token budget, status output, malformed-input tolerance
- **Phase 2**: recall keyword+tag scoring, recall over archived links, dream candidate selection, dream finalize (write digest + move originals + write tombstones), index append-only invariant under rollup, MCP server handshake + tools/list + tools/call, feedback dedup by normalized title, dry-run flush moves items to sent/
- **Comms layer (T35–T54)**: path helpers, config merge/defaults/atomic-write, allowlist normalize/isAllowed/group-grant, dedupe fingerprint symmetry, dedupe reconcileImport, store cursor read/write, store appendMessage idempotency + live-wins, store getSlice sort/clamp/byte-budget/continuation, store listChats allowlist-filtered, comms_recall scoring/caps/allowlist-scope (T44–T54)

---

## 2. Heavy real-Claude scenario

Use a **throwaway repo** so you can `rm -rf` it without regret. Plugin path stays the same.

```bash
# Run from the repo root so $PWD resolves the plugin dir.
PLUGIN_DIR="$PWD/plugins/continuum"
TEST_REPO=/tmp/continuum-heavy-test
rm -rf "$TEST_REPO" && mkdir "$TEST_REPO" && cd "$TEST_REPO" && git init -q
```

### Session 1 — Bootstrap

```bash
claude --plugin-dir "$PLUGIN_DIR"
```

Prompt:
> Set up this repo as a small Node/Express **todo API**. Use **basic email + password** login. Just sketch the structure — don't install packages yet.

Expect:
- Agent's first response acknowledges a system reminder from Continuum about bootstrapping.
- Agent creates `.continuum/STATE.md` + `chain/index.jsonl` + `chain/links/0001/`.
- Run `/continuum:status` → "1 link".

Verify before exiting:
```bash
ls .continuum/chain/links/0001/   # summary.md meta.json refs.json
cat .continuum/STATE.md            # should mention "basic email/password login"
```

Exit Claude (`/exit`).

### Session 2 — Requirement change + manual checkpoint

```bash
claude --plugin-dir "$PLUGIN_DIR"
```

Prompt:
> What do you know about this project?

Expect: agent answers from STATE.md + link 0001 *without* re-reading the codebase. **This validates S1 — zero-effort continuity.**

Then:
> Actually I want **MFA**, not basic password login. Update STATE.md, then run `/continuum:checkpoint` with tags `auth,supersede`.

Expect:
- New link `0002` written.
- New STATE.md says MFA only — **basic login decision is GONE, not crossed-out**.
- Sentinel cleared.

Exit (`/exit`) — this fires SessionEnd → archive + sentinel.

### Session 3 — Validate supersession across boundary (S3)

```bash
claude --plugin-dir "$PLUGIN_DIR"
```

Expect on session start: the SessionStart context block mentions the SessionEnd sentinel (because session 2 ended).

Prompt:
> Which authentication method are we using?

**Expected answer: MFA.** If the agent says "basic email/password" or "both," supersession is broken. Investigate the new link's summary.md — it must explicitly state the supersession.

Then:
> Write a checkpoint now to clear the pending sentinel from last session.

Run `/continuum:checkpoint` → link `0003`. Verify sentinel gone:
```bash
ls .continuum/.pending-checkpoint  # should error: no such file
```

### Session 4 — Forced PreCompact (S5)

In an active session, do enough back-and-forth (or paste a wall of text) to make `/compact` reasonable. Then:
```
/compact
```

Expect (server-side, no model context injection happens for PreCompact):
```bash
ls .continuum/archive/transcripts/   # +1 gzipped transcript
cat .continuum/.pending-checkpoint   # trigger: PreCompact, matcher: manual
```

In the post-compact session, run `/continuum:checkpoint` — agent should compose a summary from what it still has + can `zcat` the archive for detail.

### Session 5 — Token budget stays bounded (S2)

Manually inflate the chain to ~25 links by running `/continuum:checkpoint` repeatedly with small fake decisions. Then start a fresh Claude session and check:

```bash
node "$PLUGIN_DIR/lib/status.js"
```

The "≈Ntok" in SessionStart's footer should still be under `inject_token_cap` (4000). Older link summaries get dropped from the injection, never STATE.md.

---

### Phase 2 add-ons to the real-Claude scenario

After completing sessions 1–5 above, exercise the Phase 2 surface:

#### Session 6 — `/continuum:recall`

```
/continuum:recall mfa
```

Expect a ranked list with link 0002 first (matched tag + keyword). Verify the "_anchors:_" line surfaces any `refs.json` entries you populated at checkpoint time.

Then:
```
/continuum:recall auth rate
```

Should return ≥2 hits (auth-tagged + rate-limit-tagged links), score-sorted.

#### Session 7 — `mcp__continuum__recall` from inside agent reasoning

Mid-session, prompt:
> Without me telling you, find any past decision about authentication and summarize it.

Expect the agent to call `mcp__continuum__recall({query: "auth"})` programmatically (NOT the slash command). Verify with `/continuum:status` afterward — no new links should appear; recall is read-only.

#### Session 8 — `/continuum:dream`

Build up to 6+ active (non-digest, non-archived) links via several `/continuum:checkpoint` calls. Then:

```
/continuum:dream 5
```

Expect:
- A new digest link written.
- `chain/links/_archived/` populated with the 5 rolled-up directories.
- Tombstone lines appended to `index.jsonl` (one per archived id).
- `recall` still finds the archived links (verifies S5 across rollups).
- Next SessionStart only loads the digest + any still-active links — NOT the archived 5.

#### Session 9 — `/continuum:feedback`

Mid-session, after hitting any workaround:
```
/continuum:feedback file --title "Need /continuum:undo" --severity minor
```
(Body is composed from your conversation; the slash command shows the format.)

Then:
```
/continuum:feedback flush --dry-run
```

Verify: pending count → 0, sent count → 1. Drop `--dry-run` only when you actually want a GitHub issue created (requires `gh auth login`).

---

### Popup-messaging track (manual)

This part can't be fully synthetic-tested without Chrome. Run the synthetic e2e (`node tests/run-popup-synthetic.mjs`, 15 invariants) to validate the wire protocol; then manually verify in Chrome:

#### Prereqs
1. Load the Mochi extension in Chrome (`chrome://extensions` → Load unpacked → `extension/`).
2. Start the Mochi server: `npm start` from repo root (binds broker on `127.0.0.1:9009`).
3. Start Claude with the plugin in any repo: `claude --plugin-dir "$PWD/plugins/continuum"` (run from the Super-Tester repo root, or substitute the absolute path you cloned to).

#### Walkthrough

1. **Open the popup.** New "Claude Sessions" section appears at the bottom. Within ~1.5s your Claude session should show up with name `<repo-basename> · <branch>`.
2. **Rename from the Claude side.** In Claude: `/continuum:rename Bugfix-cart-bug`. The popup should update its name within 1.5s.
3. **Send a hint without browser context.** In the popup: select the session, uncheck "Include current tab URL…", type `try the discount-code path next`, click "Send hint". Status line shows ✓.
4. **Observe the agent.** In Claude, type any prompt that triggers a tool (e.g. `read package.json`). The agent's response should reference the hint — it sees the system reminder before deciding what to do.
5. **Send a hint WITH browser context.** Open a tab that throws a console error (e.g. `chrome.runtime` is undefined). Re-check the box, send another hint. The hint that lands in Claude's context should include the URL + recent error.
6. **Idle latency.** With no hints queued, every tool call should incur <5ms of hook overhead (the sentinel-flag fast-skip).

If the popup shows "No Claude sessions registered" even with Claude running, check: (a) broker is running on 9009, (b) Continuum hooks are firing — `tail -f` the SessionStart output or `ls /tmp/<your-project>/.continuum/.session-id`.

---

## What's NOT tested (deferred to Phase 3)

- Browser-MCP frontend verification (`PostToolUse` matched on frontend globs)
- Embedding-based semantic recall (`archive/embeddings/`)
- Debug renderer for archived transcripts

---

## Cleanup after tests

```bash
rm -rf /tmp/continuum-heavy-test
```

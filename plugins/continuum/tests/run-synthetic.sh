#!/usr/bin/env bash
# Synthetic end-to-end test for the continuum plugin's hook + helper pipeline.
# Simulates what Claude Code's hook runtime would do by feeding crafted JSON to
# each hook script and asserting on file outputs. No actual Claude session.
#
# Usage: bash tests/run-synthetic.sh
# Exit:  0 on all-pass, 1 on first failure.

set -u
# Point hook subprocesses at an unreachable broker so SessionStart's register
# call silently times out — otherwise the user's running Mochi broker on the
# default port 9009 accumulates ghost test sessions. (See bug 2026-05-18.)
export CONTINUUM_BROKER_URL="http://127.0.0.1:1"
export CONTINUUM_BROKER_TIMEOUT_MS="100"

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d -t continuum-synth.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
log()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

run_hook() {
  # $1 = hook script name (relative to plugin), $2 = json payload string
  local script="$1" payload="$2"
  echo "$payload" | node "$PLUGIN_DIR/$script" 2>&1
}

extract_ctx() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('hookSpecificOutput',{}).get('additionalContext',''))" 2>/dev/null
}

# ---- Setup throwaway repo ----------------------------------------------------
cd "$TMP"
git init -q
git commit -q --allow-empty -m "init"
REPO="$TMP"
TRANSCRIPT="$TMP/transcript.jsonl"
cat > "$TRANSCRIPT" <<'EOF'
{"role":"user","content":"hello"}
{"role":"assistant","content":"hi! decided to use MFA login."}
EOF

echo "[synthetic test: $REPO]"
echo

# ---- T1: SessionStart on empty repo → bootstrap directive --------------------
echo "T1 — SessionStart (no .continuum/) emits bootstrap directive"
OUT="$(run_hook hooks/session_start.js "{\"session_id\":\"s1\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
CTX="$(echo "$OUT" | extract_ctx)"
echo "$CTX" | grep -q "No context chain" && ok "bootstrap directive present" || { fail "missing bootstrap directive"; log "OUT: $OUT"; }
echo "$CTX" | grep -qE "bootstrap it NOW|finish bootstrap BEFORE" && ok "directive is imperative (no negotiation)" || fail "bootstrap directive is too soft — agent may defer"
[ -f "$REPO/.continuum/.session-id" ] && ok "session-id file written" || fail "session-id not written"

# ---- T2: write_link.js creates link 0001 ------------------------------------
echo
echo "T2 — write_link.js creates link 0001 with index entry"
mkdir -p "$REPO/.continuum/chain/links" "$REPO/.continuum/archive/transcripts"
touch "$REPO/.continuum/chain/index.jsonl"
ID="$(echo "## Decisions
- Use MFA" | node "$PLUGIN_DIR/lib/write_link.js" --project-dir "$REPO" --tags "bootstrap,auth")"
[ "$ID" = "0001" ] && ok "returned id=0001" || fail "expected 0001 got '$ID'"
[ -f "$REPO/.continuum/chain/links/0001/summary.md" ] && ok "summary.md written" || fail "summary.md missing"
[ -f "$REPO/.continuum/chain/links/0001/meta.json" ] && ok "meta.json written" || fail "meta.json missing"
grep -q '"id":1' "$REPO/.continuum/chain/index.jsonl" && ok "index.jsonl appended" || fail "index entry missing"

# ---- T3: second write_link increments id -----------------------------------
echo
echo "T3 — second write_link gets id 0002"
ID2="$(echo "Second link" | node "$PLUGIN_DIR/lib/write_link.js" --project-dir "$REPO" --tags "test")"
[ "$ID2" = "0002" ] && ok "returned id=0002" || fail "expected 0002 got '$ID2'"
LINES="$(wc -l < "$REPO/.continuum/chain/index.jsonl" | tr -d ' ')"
[ "$LINES" = "2" ] && ok "index has 2 lines" || fail "expected 2 lines got $LINES"

# ---- T4: SessionStart with bootstrapped chain loads STATE+links -----------
echo
echo "T4 — SessionStart on bootstrapped repo loads STATE.md + tail"
cat > "$REPO/.continuum/STATE.md" <<'EOF'
# State
Decisions: MFA, Postgres 16
EOF
OUT2="$(run_hook hooks/session_start.js "{\"session_id\":\"s2\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}")"
CTX2="$(echo "$OUT2" | extract_ctx)"
echo "$CTX2" | grep -q "Loaded context chain" && ok "loaded-chain header present" || fail "expected loaded-chain header"
echo "$CTX2" | grep -q "Decisions: MFA, Postgres 16" && ok "STATE.md content injected" || fail "STATE.md content missing"
echo "$CTX2" | grep -q "Link 0002" && ok "latest link injected" || fail "latest link missing"

# ---- T5: PreCompact archives + writes sentinel ----------------------------
echo
echo "T5 — PreCompact archives transcript + writes sentinel"
OUT3="$(run_hook hooks/pre_compact.js "{\"session_id\":\"s3\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"PreCompact\",\"matcher\":\"manual\"}")"
[ -f "$REPO/.continuum/.pending-checkpoint" ] && ok "sentinel file written" || fail "sentinel missing"
COUNT="$(ls "$REPO/.continuum/archive/transcripts/" | grep -c precompact || true)"
[ "$COUNT" -ge 1 ] && ok "archive file created" || fail "no archive file"

# ---- T6: SessionStart now surfaces the pending sentinel -------------------
echo
echo "T6 — next SessionStart surfaces pending sentinel"
OUT4="$(run_hook hooks/session_start.js "{\"session_id\":\"s4\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}")"
CTX4="$(echo "$OUT4" | extract_ctx)"
echo "$CTX4" | grep -q "Pending checkpoint detected" && ok "pending-sentinel warning injected" || fail "sentinel warning missing"

# ---- T7: write_link clears the sentinel -----------------------------------
echo
echo "T7 — write_link clears the pending-checkpoint sentinel"
echo "post-compact recovery link" | node "$PLUGIN_DIR/lib/write_link.js" --project-dir "$REPO" --tags "recovery" > /dev/null
[ ! -f "$REPO/.continuum/.pending-checkpoint" ] && ok "sentinel cleared" || fail "sentinel still present"

# ---- T8: SessionEnd archives + emits systemMessage -----------------------
echo
echo "T8 — SessionEnd archives + writes new sentinel + emits systemMessage"
OUT5="$(run_hook hooks/session_end.js "{\"session_id\":\"s5\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionEnd\",\"why_session_ended\":\"logout\"}")"
echo "$OUT5" | grep -q '"systemMessage"' && ok "systemMessage emitted" || fail "systemMessage missing"
echo "$OUT5" | grep -q "sessionend-logout" && ok "archive path mentioned" || fail "archive path missing in message"
[ -f "$REPO/.continuum/.pending-checkpoint" ] && ok "new sentinel for SessionEnd" || fail "SessionEnd didn't write sentinel"

# ---- T9: status.js reports correct counts ---------------------------------
echo
echo "T9 — status.js reports chain health"
STATUS="$(node "$PLUGIN_DIR/lib/status.js" --project-dir "$REPO")"
echo "$STATUS" | grep -qF "Chain:** 3 links" && ok "link count correct (3)" || { fail "wrong link count"; log "$STATUS"; }
echo "$STATUS" | grep -qF "Pending checkpoint" && ok "pending sentinel reported" || fail "sentinel not reported"

# ---- T10: status.js on un-bootstrapped repo ----------------------------------
echo
echo "T10 — status.js on un-bootstrapped repo reports clearly"
NEW="$(mktemp -d -t continuum-synth-empty.XXXXXX)"
git -C "$NEW" init -q
STATUS_EMPTY="$(node "$PLUGIN_DIR/lib/status.js" --project-dir "$NEW")"
echo "$STATUS_EMPTY" | grep -q "Not bootstrapped" && ok "un-bootstrapped clearly reported" || fail "missing un-bootstrapped notice"
rm -rf "$NEW"

# ---- T11: token-budget enforcement drops oldest link, keeps STATE -----------
echo
echo "T11 — token budget drops oldest link summary, never STATE.md"
# Make 5 huge fake links so they exceed the cap together with STATE.md
for i in 3 4 5 6 7; do
  PAD="$(printf 'lorem ipsum dolor sit amet, consectetur adipiscing elit %.0s' {1..500})"
  mkdir -p "$REPO/.continuum/chain/links/000$i"
  echo "$PAD" > "$REPO/.continuum/chain/links/000$i/summary.md"
  echo "{\"id\":$i,\"ts\":\"2026-05-18T1$i:00:00Z\",\"commit\":null,\"summary_tokens\":700,\"tags\":[\"bulk\"]}" >> "$REPO/.continuum/chain/index.jsonl"
done
# Crank newest_links_to_load to force overflow
cat > "$REPO/.continuum/config.json" <<'EOF'
{ "newest_links_to_load": 5, "inject_token_cap": 1500 }
EOF
OUT6="$(run_hook hooks/session_start.js "{\"session_id\":\"s6\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}")"
CTX6="$(echo "$OUT6" | extract_ctx)"
echo "$CTX6" | grep -q "Decisions: MFA, Postgres 16" && ok "STATE.md preserved under budget" || fail "STATE.md was dropped (BUG)"
echo "$CTX6" | grep -q "dropped to stay under token cap" && ok "drop-count reported" || fail "drop-count not reported"

# ---- T12: malformed sentinel doesn't crash SessionStart ----------------------
echo
echo "T12 — malformed sentinel is tolerated"
echo "this is not json" > "$REPO/.continuum/.pending-checkpoint"
OUT7="$(run_hook hooks/session_start.js "{\"session_id\":\"s7\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}")"
CTX7="$(echo "$OUT7" | extract_ctx)"
[ -n "$CTX7" ] && ok "SessionStart still emits context with bad sentinel" || fail "crashed on bad sentinel"

# ============================================================================
# Phase 2 invariants: recall, dream/rollup, feedback queue
# ============================================================================

# Build a fresh repo with 6 links for Phase 2 tests, so the Phase 1 chain above
# (heavily mutated, archived, etc) doesn't pollute these assertions.
P2REPO="$(mktemp -d -t continuum-synth-p2.XXXXXX)"
git -C "$P2REPO" init -q
git -C "$P2REPO" commit -q --allow-empty -m init
mkdir -p "$P2REPO/.continuum/chain/links" "$P2REPO/.continuum/archive/transcripts"
touch "$P2REPO/.continuum/chain/index.jsonl"

mklink () {
  # mklink <tags-csv> <summary-text>
  echo "$2" | node "$PLUGIN_DIR/lib/write_link.js" --project-dir "$P2REPO" --tags "$1" > /dev/null
}
mklink "bootstrap,auth"      "Initial baseline. Decided basic email/password login."
mklink "auth,mfa,decision"   "Switched to MFA via TOTP. Supersedes basic-login from link 0001."
mklink "db,postgres"         "Picked Postgres 16 with pgbouncer pooling."
mklink "ui,button"           "Primary CTA button redesigned. indigo-600 fill."
mklink "auth,rate-limit"     "Added auth rate-limit: 5 attempts/min/IP."
mklink "perf"                "Switched JSON parser to simdjson, 3x faster on large bodies."

# ---- T13: recall by keyword finds the right link ----------------------------
echo
echo "T13 — recall by keyword finds the right link"
RECALL="$(node "$PLUGIN_DIR/lib/recall_cli.js" --project-dir "$P2REPO" --json -- mfa)"
HITS=$(echo "$RECALL" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hitCount'])")
TOP=$(echo "$RECALL" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['id'] if d['hits'] else 'none')")
[ "$HITS" -ge 1 ] && [ "$TOP" = "2" ] && ok "recall 'mfa' → link 2 (hits=$HITS)" || fail "expected hit on link 2 got top=$TOP hits=$HITS"

# ---- T14: recall --tags filter ---------------------------------------------
echo
echo "T14 — recall --tags restricts results"
RECALL2="$(node "$PLUGIN_DIR/lib/recall_cli.js" --project-dir "$P2REPO" --json --tags db -- postgres)"
HITS2=$(echo "$RECALL2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hitCount'])")
TOP2=$(echo "$RECALL2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['id'] if d['hits'] else 'none')")
[ "$HITS2" = "1" ] && [ "$TOP2" = "3" ] && ok "tag-filtered recall → link 3" || fail "expected 1 hit on link 3 got hits=$HITS2 top=$TOP2"

# ---- T15: dream_prepare picks last N non-digest, non-archived ---------------
echo
echo "T15 — dream_prepare picks correct candidates"
PREP="$(node "$PLUGIN_DIR/lib/dream_prepare.js" --project-dir "$P2REPO" --n 4)"
IDS_JSON=$(echo "$PREP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(map(str,d['rollupCandidateIds'])))")
CAN=$(echo "$PREP" | python3 -c "import json,sys; print(json.load(sys.stdin)['canProceed'])")
[ "$IDS_JSON" = "3,4,5,6" ] && ok "candidates = 3,4,5,6 (n=4)" || fail "expected '3,4,5,6' got '$IDS_JSON'"
[ "$CAN" = "True" ] && ok "canProceed=true" || fail "canProceed=$CAN"

# ---- T16: dream_finalize writes digest + archives + tombstones --------------
echo
echo "T16 — dream_finalize writes digest + moves originals + writes tombstones"
DIGEST_ID=$(echo "## Phase digest
Consolidated: MFA via TOTP, Postgres 16, indigo CTA, 5/min rate-limit." | node "$PLUGIN_DIR/lib/dream_finalize.js" --project-dir "$P2REPO" --rollup-ids "3,4,5,6" --tags "phase-digest,bundle")
[ "$DIGEST_ID" = "0007" ] && ok "digest id = 0007" || fail "expected 0007 got '$DIGEST_ID'"
[ -d "$P2REPO/.continuum/chain/links/0007" ] && ok "digest dir present" || fail "digest dir missing"
for n in 3 4 5 6; do
  if [ -d "$P2REPO/.continuum/chain/links/_archived/000$n" ] && [ ! -d "$P2REPO/.continuum/chain/links/000$n" ]; then
    ok "link $n moved to _archived/"
  else
    fail "link $n not properly archived"
  fi
done
TOMB_COUNT=$(grep -c '"tombstone":true' "$P2REPO/.continuum/chain/index.jsonl")
[ "$TOMB_COUNT" = "4" ] && ok "4 tombstone entries in index" || fail "expected 4 tombstones got $TOMB_COUNT"

# ---- T17: recall still finds archived links (and marks them archived) ------
# Link 3 (postgres) was rolled up in T16 — querying its tag should still hit,
# and the hit must be flagged archived.
echo
echo "T17 — recall surfaces archived link with archived=True"
RECALL3="$(node "$PLUGIN_DIR/lib/recall_cli.js" --project-dir "$P2REPO" --json -- postgres)"
TOPID=$(echo "$RECALL3" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['id'] if d['hits'] else 'none')")
ARCHIVED=$(echo "$RECALL3" | python3 -c "import json,sys; d=json.load(sys.stdin); h=d['hits'][0] if d['hits'] else None; print(h['archived'] if h else 'no-hit')")
[ "$TOPID" = "3" ] && [ "$ARCHIVED" = "True" ] && ok "archived link 3 surfaced with archived=True" || fail "expected hit on archived link 3 got id=$TOPID archived=$ARCHIVED"

# ---- T18: session_start tail skips archived links ---------------------------
echo
echo "T18 — SessionStart tail shows only active links, not archived"
echo "# State (post-dream)" > "$P2REPO/.continuum/STATE.md"
OUT_P2="$(run_hook hooks/session_start.js "{\"session_id\":\"sp2\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"$P2REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}")"
CTX_P2="$(echo "$OUT_P2" | extract_ctx)"
echo "$CTX_P2" | grep -qF "Link 0007" && ok "digest (0007) appears in tail" || fail "digest missing from tail"
echo "$CTX_P2" | grep -qF "Link 0003" && fail "archived link 3 appears in tail (BUG)" || ok "archived 0003 absent from tail"

# ---- T19: MCP server initialize + tools/list + tools/call -------------------
echo
echo "T19 — MCP server handshake + tools/list + tools/call (recall)"
MCP_OUT=$(printf '%s\n%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"recall\",\"arguments\":{\"query\":\"perf\",\"project_dir\":\"$P2REPO\"}}}" \
  | node "$PLUGIN_DIR/mcp/server.js")
INIT_OK=$(echo "$MCP_OUT" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except: continue
    if d.get('id')==1 and 'result' in d and d['result'].get('protocolVersion'): print('ok'); break
" || true)
[ "$INIT_OK" = "ok" ] && ok "initialize OK" || fail "initialize failed"
TOOLS_OK=$(echo "$MCP_OUT" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except: continue
    if d.get('id')==2 and any(t['name']=='recall' for t in d['result']['tools']): print('ok'); break
" || true)
[ "$TOOLS_OK" = "ok" ] && ok "tools/list contains recall" || fail "tools/list missing recall"
CALL_OK=$(echo "$MCP_OUT" | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except: continue
    if d.get('id')==3 and d['result'].get('isError') is False and d['result'].get('structuredContent',{}).get('hitCount',0)>=1: print('ok'); break
" || true)
[ "$CALL_OK" = "ok" ] && ok "tools/call recall returned a hit" || fail "tools/call recall failed"

# ---- T20: feedback file + dedup --------------------------------------------
echo
echo "T20 — feedback file + dedup by normalized title hash"
FB_REPO="$(mktemp -d -t continuum-synth-fb.XXXXXX)"
git -C "$FB_REPO" init -q
R1=$(echo "Body of first" | node "$PLUGIN_DIR/lib/feedback_cli.js" file --project-dir "$FB_REPO" --title "Need /continuum:undo" --severity minor)
STATUS1=$(echo "$R1" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
[ "$STATUS1" = "queued" ] && ok "first file → queued" || fail "first file → $STATUS1"
R2=$(echo "Different body but same title" | node "$PLUGIN_DIR/lib/feedback_cli.js" file --project-dir "$FB_REPO" --title "  Need   /continuum:undo  " --severity major)
STATUS2=$(echo "$R2" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
[ "$STATUS2" = "duplicate-pending" ] && ok "whitespace-normalized title dedup'd" || fail "dedup failed: $STATUS2"

# ---- T21: feedback flush --dry-run moves to sent/ ---------------------------
echo
echo "T21 — feedback flush --dry-run moves item to sent/, no gh call"
FLUSH=$(node "$PLUGIN_DIR/lib/feedback_cli.js" flush --project-dir "$FB_REPO" --dry-run)
FLUSHED_N=$(echo "$FLUSH" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['flushed']))")
[ "$FLUSHED_N" = "1" ] && ok "1 item dry-flushed" || fail "expected 1 flushed got $FLUSHED_N"
LIST=$(node "$PLUGIN_DIR/lib/feedback_cli.js" list --project-dir "$FB_REPO")
PEND=$(echo "$LIST" | python3 -c "import json,sys; print(json.load(sys.stdin)['pendingCount'])")
SENT=$(echo "$LIST" | python3 -c "import json,sys; print(json.load(sys.stdin)['sentCount'])")
[ "$PEND" = "0" ] && [ "$SENT" = "1" ] && ok "post-flush: 0 pending, 1 sent" || fail "post-flush counts wrong: pending=$PEND sent=$SENT"

rm -rf "$P2REPO" "$FB_REPO"

# ============================================================================
# Phase 3 invariants: PostToolUse frontend hook, verification log, recall
# stemming, archive renderer
# ============================================================================

P3REPO="$(mktemp -d -t continuum-synth-p3.XXXXXX)"
git -C "$P3REPO" init -q
git -C "$P3REPO" commit -q --allow-empty -m init
mkdir -p "$P3REPO/.continuum/chain/links" "$P3REPO/.continuum/archive/transcripts" "$P3REPO/src/components"
touch "$P3REPO/.continuum/chain/index.jsonl"
# Enable frontend verification for this test repo (default is off per PRD §6).
echo '{"frontend_verify": true}' > "$P3REPO/.continuum/config.json"

# ---- T22: glob matcher ------------------------------------------------------
echo
echo "T22 — glob matcher invariants"
GLOB_OUT=$(node -e "
import('$PLUGIN_DIR/lib/glob.js').then(({matchGlob}) => {
  const cases = [
    ['src/foo.tsx', 'src/**/*.{tsx,jsx,vue,svelte,css}', true],
    ['src/a/b/c.css', 'src/**/*.{tsx,jsx,vue,svelte,css}', true],
    ['src/foo.ts', 'src/**/*.{tsx,jsx,vue,svelte,css}', false],
    ['lib/foo.tsx', 'src/**/*.{tsx,jsx,vue,svelte,css}', false],
  ];
  let bad = 0;
  for (const [p, g, want] of cases) {
    if (matchGlob(p, g) !== want) { console.log('GLOB FAIL', p, g); bad++; }
  }
  console.log(bad === 0 ? 'GLOB OK' : 'GLOB BAD ' + bad);
});
")
echo "$GLOB_OUT" | grep -qF "GLOB OK" && ok "glob matcher covers 4 cases" || fail "glob matcher: $GLOB_OUT"

# ---- T23: PostToolUse emits directive for .tsx edit ------------------------
echo
echo "T23 — PostToolUse emits directive for frontend edit"
OUT_FE=$(echo "{\"session_id\":\"sp3\",\"cwd\":\"$P3REPO\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$P3REPO/src/components/Btn.tsx\"}}" \
  | node "$PLUGIN_DIR/hooks/post_tool_use.js")
CTX_FE=$(echo "$OUT_FE" | python3 -c "import json,sys; print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'])" 2>/dev/null || echo "")
echo "$CTX_FE" | grep -q "src/components/Btn.tsx" && ok "directive mentions the edited file" || fail "directive missing file path"
echo "$CTX_FE" | grep -qF "browser_emulate_viewport" && ok "directive references browser MCP" || fail "directive missing MCP guidance"
echo "$CTX_FE" | grep -q "375\|768\|1280" && ok "directive lists viewport breakpoints" || fail "breakpoints missing"
[ -f "$P3REPO/.continuum/.frontend-changes.jsonl" ] && ok "frontend-changes log appended" || fail "log not written"

# ---- T24: PostToolUse silent for non-frontend file -------------------------
echo
echo "T24 — PostToolUse silent on non-frontend edit"
mkdir -p "$P3REPO/server"
OUT_BE=$(echo "{\"session_id\":\"sp3\",\"cwd\":\"$P3REPO\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$P3REPO/server/api.py\"}}" \
  | node "$PLUGIN_DIR/hooks/post_tool_use.js")
[ -z "$OUT_BE" ] && ok "no output for .py edit" || fail "unexpected output for .py: $OUT_BE"

# ---- T25: verify_record + verify_status cycle ------------------------------
echo
echo "T25 — verify_record + verify_status report counts"
node "$PLUGIN_DIR/lib/verify_record_cli.js" --project-dir "$P3REPO" --path "src/components/Btn.tsx" --viewport 375 --status pass > /dev/null
node "$PLUGIN_DIR/lib/verify_record_cli.js" --project-dir "$P3REPO" --path "src/components/Btn.tsx" --viewport 1280 --status fail --notes "overflows" > /dev/null
STAT=$(node "$PLUGIN_DIR/lib/verify_status_cli.js" --project-dir "$P3REPO")
echo "$STAT" | grep -qF "FAILURES (1)" && ok "verify_status reports failure count" || fail "FAILURES section missing"
echo "$STAT" | grep -q "overflows" && ok "failure note surfaced" || fail "failure note missing"

# ---- T26: write_link clears the frontend-changes log ----------------------
echo
echo "T26 — /continuum:checkpoint (write_link) clears .frontend-changes.jsonl"
echo "test link" | node "$PLUGIN_DIR/lib/write_link.js" --project-dir "$P3REPO" --tags "test" > /dev/null
[ ! -f "$P3REPO/.continuum/.frontend-changes.jsonl" ] && ok "log cleared by write_link" || fail "log still present after checkpoint"

# ---- T27: stemmed recall — singular query hits plural-tagged link --------
echo
echo "T27 — stemmed recall: singular query hits plural-tagged link"
S3REPO="$(mktemp -d -t continuum-synth-stem.XXXXXX)"
mkdir -p "$S3REPO/.continuum/chain/links/0001"
echo '{"id":1,"ts":"2026-05-18T10:00:00Z","commit":null,"summary_tokens":40,"tags":["decisions"]}' > "$S3REPO/.continuum/chain/index.jsonl"
echo "We decided on the auth approach." > "$S3REPO/.continuum/chain/links/0001/summary.md"
echo '{}' > "$S3REPO/.continuum/chain/links/0001/refs.json"
SR=$(node "$PLUGIN_DIR/lib/recall_cli.js" --project-dir "$S3REPO" --json -- decision)
HITS27=$(echo "$SR" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$HITS27" = "1" ] && ok "query 'decision' hits link tagged 'decisions'" || fail "expected 1 hit got $HITS27"
SR2=$(node "$PLUGIN_DIR/lib/recall_cli.js" --project-dir "$S3REPO" --json -- decided)
HITS27b=$(echo "$SR2" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$HITS27b" = "1" ] && ok "query 'decided' also hits via summary stem" || fail "expected 1 hit got $HITS27b"
rm -rf "$S3REPO"

# ---- T28: render_archive prints summary -----------------------------------
echo
echo "T28 — render_archive decompresses + summarizes"
cat > /tmp/_p3_tr.jsonl <<'EOF'
{"role":"user","content":"hi"}
{"role":"assistant","content":[{"type":"tool_use","name":"Read"}]}
{"role":"user","content":[{"type":"tool_result","is_error":true,"content":"bad"}]}
EOF
gzip -c /tmp/_p3_tr.jsonl > "$P3REPO/.continuum/archive/transcripts/2026-05-18T11-00-00Z__test.jsonl.gz"
rm /tmp/_p3_tr.jsonl
ROUT=$(node "$PLUGIN_DIR/lib/render_archive.js" --project-dir "$P3REPO" --latest)
echo "$ROUT" | grep -qF "Records:** 3" && ok "renderer counts records" || fail "renderer count missing"
echo "$ROUT" | grep -qF "Read: 1" && ok "renderer counts tool calls" || fail "tool counts missing"
echo "$ROUT" | grep -qF "Errors (1)" && ok "renderer surfaces errors" || fail "error count missing"

rm -rf "$P3REPO"

# ---- T29: no command file uses unexpanded env vars for plugin path ----------
# Real-Claude test (2026-05-18) showed neither $CLAUDE_PLUGIN_ROOT nor
# ${CLAUDE_SKILL_DIR} resolve inside slash command bash blocks. Commands MUST
# read .continuum/.plugin-root (written by SessionStart) instead.
echo
echo "T29 — no command file references unexpanded plugin-path env vars"
BAD_PR=$(grep -l '\$CLAUDE_PLUGIN_ROOT' "$PLUGIN_DIR"/commands/*.md 2>/dev/null | wc -l | tr -d ' ')
BAD_SD=$(grep -l 'CLAUDE_SKILL_DIR' "$PLUGIN_DIR"/commands/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$BAD_PR" = "0" ] && ok "no command uses \$CLAUDE_PLUGIN_ROOT" || fail "$BAD_PR file(s) still use \$CLAUDE_PLUGIN_ROOT"
[ "$BAD_SD" = "0" ] && ok "no command uses \${CLAUDE_SKILL_DIR}" || fail "$BAD_SD file(s) still use \${CLAUDE_SKILL_DIR}"
USES=$(grep -l 'cat \.continuum/\.plugin-root' "$PLUGIN_DIR"/commands/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$USES" = "7" ] && ok "all 7 commands use .continuum/.plugin-root" || fail "only $USES commands use the file path"

# ============================================================================
# 0.5.0 MEMORY layer: verification ledger + link provenance
# ============================================================================

V5REPO="$(mktemp -d -t continuum-synth-v5.XXXXXX)"
git -C "$V5REPO" init -q
git -C "$V5REPO" commit -q --allow-empty -m init
mkdir -p "$V5REPO/.continuum/chain/links" "$V5REPO/.continuum/archive/transcripts"
touch "$V5REPO/.continuum/chain/index.jsonl"

# ---- T30: verification ledger record → read reflects 1 element --------------
echo
echo "T30 — verification_ledger record + read reflect the element"
node "$PLUGIN_DIR/lib/verification_ledger_cli.js" record \
  --project-dir "$V5REPO" --app "Demo App" --route "/login" \
  --element '{"id":"submit-btn","selector":"#submit","verdict":"WORKS"}' > /dev/null
LEDGER=$(node "$PLUGIN_DIR/lib/verification_ledger_cli.js" read --project-dir "$V5REPO" --app "Demo App")
ELN=$(echo "$LEDGER" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['routes'].get('/login',{}).get('elements',[])))")
[ "$ELN" = "1" ] && ok "ledger has 1 element on /login" || fail "expected 1 element got $ELN"
APP_SLUG_FILE="$V5REPO/.continuum/verification/demo-app.json"
[ -f "$APP_SLUG_FILE" ] && ok "ledger stored at slugged path demo-app.json" || fail "slugged ledger file missing"

# ---- T31: coverage total==1 after one WORKS element ------------------------
echo
echo "T31 — coverage reports total==1, covered==1"
COV=$(node "$PLUGIN_DIR/lib/verification_ledger_cli.js" coverage --project-dir "$V5REPO" --app "Demo App")
TOT=$(echo "$COV" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")
CVD=$(echo "$COV" | python3 -c "import json,sys; print(json.load(sys.stdin)['covered'])")
[ "$TOT" = "1" ] && ok "coverage.total == 1" || fail "expected total 1 got $TOT"
[ "$CVD" = "1" ] && ok "coverage.covered == 1 (WORKS counts)" || fail "expected covered 1 got $CVD"

# ---- T32: an UNTESTED element makes coverage.untested > 0 ------------------
echo
echo "T32 — UNTESTED element raises coverage.untested"
node "$PLUGIN_DIR/lib/verification_ledger_cli.js" record \
  --project-dir "$V5REPO" --app "Demo App" --route "/login" \
  --element '{"id":"forgot-link","selector":"#forgot","verdict":"UNTESTED"}' > /dev/null
COV2=$(node "$PLUGIN_DIR/lib/verification_ledger_cli.js" coverage --project-dir "$V5REPO" --app "Demo App")
UNT=$(echo "$COV2" | python3 -c "import json,sys; print(json.load(sys.stdin)['untested'])")
TOT2=$(echo "$COV2" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")
CVD2=$(echo "$COV2" | python3 -c "import json,sys; print(json.load(sys.stdin)['covered'])")
[ "$UNT" -gt 0 ] && ok "coverage.untested > 0 (got $UNT)" || fail "expected untested>0 got $UNT"
[ "$TOT2" = "2" ] && [ "$CVD2" = "1" ] && ok "total=2, covered still 1 (untested excluded)" || fail "expected total=2 covered=1 got total=$TOT2 covered=$CVD2"

# ---- T33: write_link meta.json now carries bundle_hash provenance ----------
echo
echo "T33 — write_link meta.json contains bundle_hash key"
echo "provenance link" | node "$PLUGIN_DIR/lib/write_link.js" --project-dir "$V5REPO" --tags "test" > /dev/null
META="$V5REPO/.continuum/chain/links/0001/meta.json"
[ -f "$META" ] && ok "meta.json written" || fail "meta.json missing"
HAS_BH=$(python3 -c "import json,sys; d=json.load(open('$META')); print('yes' if 'bundle_hash' in d else 'no')")
[ "$HAS_BH" = "yes" ] && ok "meta.json has bundle_hash key (value may be null)" || fail "bundle_hash key missing from meta.json"
HAS_PV=$(python3 -c "import json,sys; d=json.load(open('$META')); print('yes' if 'plugin_version' in d else 'no')")
[ "$HAS_PV" = "yes" ] && ok "meta.json has plugin_version key" || fail "plugin_version key missing from meta.json"

rm -rf "$V5REPO"

# ---- T34: recall flags old links as stale (verify-before-assert) ------------
echo
echo "T34 — recall flags an old link as stale"
STREPO="$(mktemp -d -t continuum-synth-stale.XXXXXX)"
mkdir -p "$STREPO/.continuum/chain/links/0001" "$STREPO/.continuum/chain/links/0002"
# Link 1: ~400 days ago (stale). Link 2: today (fresh). Both match 'auth'.
OLD_TS="2025-05-01T10:00:00Z"
NEW_TS="$(python3 -c "import datetime; print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'))")"
printf '%s\n%s\n' \
  "{\"id\":1,\"ts\":\"$OLD_TS\",\"commit\":null,\"summary_tokens\":20,\"tags\":[\"auth\"]}" \
  "{\"id\":2,\"ts\":\"$NEW_TS\",\"commit\":null,\"summary_tokens\":20,\"tags\":[\"auth\"]}" \
  > "$STREPO/.continuum/chain/index.jsonl"
echo "Old auth decision." > "$STREPO/.continuum/chain/links/0001/summary.md"; echo '{}' > "$STREPO/.continuum/chain/links/0001/refs.json"
echo "Fresh auth decision." > "$STREPO/.continuum/chain/links/0002/summary.md"; echo '{}' > "$STREPO/.continuum/chain/links/0002/refs.json"
STJSON=$(node "$PLUGIN_DIR/lib/recall_cli.js" --project-dir "$STREPO" --json -- auth)
STALE1=$(echo "$STJSON" | python3 -c "import json,sys; d=json.load(sys.stdin); h={x['id']:x for x in d['hits']}; print(h.get(1,{}).get('stale'))")
STALE2=$(echo "$STJSON" | python3 -c "import json,sys; d=json.load(sys.stdin); h={x['id']:x for x in d['hits']}; print(h.get(2,{}).get('stale'))")
[ "$STALE1" = "True" ] && ok "old link flagged stale=true" || fail "old link not flagged stale (got $STALE1)"
[ "$STALE2" = "False" ] && ok "fresh link not flagged stale" || fail "fresh link wrongly flagged stale (got $STALE2)"
rm -rf "$STREPO"

# ============================================================================
# Phase 1 (comms): pure-JS data layer — paths, config, allowlist, dedupe, store
# ============================================================================

# ---- T35: comms path helpers resolve under .continuum/comms ----------------
echo
echo "T35 — comms path helpers"
T35_OUT=$(node -e "
import('$PLUGIN_DIR/lib/paths.js').then((m) => {
  const d = '/tmp/proj';
  const checks = [
    [m.commsDir(d), '/tmp/proj/.continuum/comms'],
    [m.commsConfigPath(d), '/tmp/proj/.continuum/comms/config.json'],
    [m.commsLocalConfigPath(d), '/tmp/proj/.continuum/comms/config.local.json'],
    [m.commsStatePath(d), '/tmp/proj/.continuum/comms/state.json'],
    [m.commsSeenPath(d), '/tmp/proj/.continuum/comms/.last-session-seen.json'],
    [m.commsIndexPath(d), '/tmp/proj/.continuum/comms/index.jsonl'],
    [m.commsAuthDir(d,'whatsapp','work'), '/tmp/proj/.continuum/comms/whatsapp/work/auth'],
    [m.commsChatDir(d,'whatsapp','work','c@g.us'), '/tmp/proj/.continuum/comms/store/whatsapp/work/c@g.us'],
    [m.commsMessagesPath(d,'whatsapp','work','c@g.us'), '/tmp/proj/.continuum/comms/store/whatsapp/work/c@g.us/messages.jsonl'],
    [m.commsCursorPath(d,'whatsapp','work','c@g.us'), '/tmp/proj/.continuum/comms/store/whatsapp/work/c@g.us/cursor.json'],
    [m.commsMetaPath(d,'whatsapp','work','c@g.us'), '/tmp/proj/.continuum/comms/store/whatsapp/work/c@g.us/meta.json'],
  ];
  let bad = 0;
  for (const [got, want] of checks) { if (got !== want) { console.log('PATH FAIL got', got, 'want', want); bad++; } }
  console.log(bad === 0 ? 'PATHS OK' : 'PATHS BAD ' + bad);
});
")
echo "$T35_OUT" | grep -qF "PATHS OK" && ok "comms path helpers resolve correctly" || { fail "comms paths: $T35_OUT"; }

# ---- T36: comms_config read/merge/defaults/decline/atomic-write ------------
echo
echo "T36 — comms_config merge + defaults + atomic write"
CFG_REPO="$(mktemp -d -t continuum-synth-cfg.XXXXXX)"
T36_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_config.js').then((m) => {
  import('$PLUGIN_DIR/lib/paths.js').then((P) => {
    const fs = require('node:fs');
    const d = '$CFG_REPO';
    let bad = 0;
    const eq = (a,b,label) => { if (JSON.stringify(a)!==JSON.stringify(b)) { console.log('FAIL',label,'got',JSON.stringify(a),'want',JSON.stringify(b)); bad++; } };

    // (a) no file -> defaults
    const def = m.readConfig(d);
    eq(def, {version:1, decided:false, declined:false, providers:{}}, 'defaults');

    // (b) short/old committed config -> version defaulted, missing keys filled
    fs.mkdirSync(P.commsDir(d), {recursive:true});
    fs.writeFileSync(P.commsConfigPath(d), JSON.stringify({decided:true, declined:true}));
    const declined = m.readConfig(d);
    eq(declined.version, 1, 'version-default-on-short-config');
    eq(declined.declined, true, 'declined-true');
    eq(declined.providers, {}, 'providers-default-filled');

    // (c) local overlay wins over committed (declined committed, enabled locally)
    fs.writeFileSync(P.commsLocalConfigPath(d), JSON.stringify({decided:true, declined:false, providers:{whatsapp:{accounts:{}}}}));
    const merged = m.readConfig(d);
    eq(merged.declined, false, 'local-wins-declined');
    eq(merged.providers.whatsapp, {accounts:{}}, 'local-wins-providers');

    // (d) writeConfig is atomic (no leftover tmp) and round-trips
    const cfg = {version:1, decided:true, declined:false, providers:{whatsapp:{accounts:{work:{capture:'session',mode:'strict',allowed_jids:['c@g.us']}}}}};
    m.writeConfig(d, cfg);
    const onDisk = JSON.parse(fs.readFileSync(P.commsConfigPath(d),'utf8'));
    eq(onDisk, cfg, 'writeConfig-roundtrip');
    const leftovers = fs.readdirSync(P.commsDir(d)).filter(f => f.includes('.tmp'));
    eq(leftovers, [], 'no-tmp-leftover');

    // (e) declineConfig helper writes exact decline shape
    const dec = m.declineConfig();
    eq(dec, {version:1, decided:true, declined:true}, 'decline-shape');

    // (f) null JSON in config file degrades to defaults (never-throw contract)
    // Remove local override so only the committed file (set to 'null') is read.
    try { fs.unlinkSync(P.commsLocalConfigPath(d)); } catch {}
    fs.writeFileSync(P.commsConfigPath(d), 'null');
    let nullThrew = false;
    let nullResult;
    try { nullResult = m.readConfig(d); } catch(e) { nullThrew = true; }
    eq(nullThrew, false, 'null-json-does-not-throw');
    eq(nullResult.providers, {}, 'null-json-falls-back-to-defaults');

    console.log(bad === 0 ? 'CONFIG OK' : 'CONFIG BAD ' + bad);
  });
});
")
echo "$T36_OUT" | grep -qF "CONFIG OK" && ok "comms_config merge/defaults/decline/atomic" || { fail "comms_config: $T36_OUT"; }
rm -rf "$CFG_REPO"

# ---- T37: comms_allowlist normalize + strict isAllowed + group grant -------
echo
echo "T37 — comms_allowlist normalizeJid + isAllowed + group grant"
T37_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_allowlist.js').then((m) => {
  let bad = 0;
  const eq = (a,b,label) => { if (JSON.stringify(a)!==JSON.stringify(b)) { console.log('FAIL',label,'got',JSON.stringify(a),'want',JSON.stringify(b)); bad++; } };

  // normalizeJid: strip device/agent suffix, lowercase, trim. @lid passes
  // through untouched in v1 (the real LID<->phone map is provider-side, v2).
  eq(m.normalizeJid(' 19999999999:12@s.whatsapp.net '), '19999999999@s.whatsapp.net', 'strip-device-and-trim');
  eq(m.normalizeJid('123-456@g.us'), '123-456@g.us', 'group-jid-untouched');
  eq(m.normalizeJid('44777@LID'), '44777@lid', 'lid-lowercased-stub');
  eq(m.normalizeJid(''), '', 'empty');
  eq(m.normalizeJid(null), '', 'null');

  // isAllowed: strict — only chats on this account's allowed_jids, normalized.
  const cfg = { version:1, decided:true, declined:false, providers:{ whatsapp:{ accounts:{
    work:{ capture:'session', mode:'strict', allowed_jids:['123-456@g.us', '19999999999@s.whatsapp.net'] }
  }}}};
  eq(m.isAllowed(cfg,'whatsapp','work','123-456@g.us'), true, 'allowed-group');
  eq(m.isAllowed(cfg,'whatsapp','work','19999999999:5@s.whatsapp.net'), true, 'allowed-dm-with-device');
  eq(m.isAllowed(cfg,'whatsapp','work','55500000@s.whatsapp.net'), false, 'not-on-list');
  // group-grant semantics §6.4: allowing the group does NOT allow a member's 1:1
  eq(m.isAllowed(cfg,'whatsapp','work','member999@s.whatsapp.net'), false, 'group-does-not-grant-member-dm');
  // unknown provider/account -> false (never throws)
  eq(m.isAllowed(cfg,'telegram','work','x@s.whatsapp.net'), false, 'unknown-provider');
  eq(m.isAllowed(cfg,'whatsapp','nope','123-456@g.us'), false, 'unknown-account');

  // assertAllowed: returns normalized jid when allowed, throws when not.
  eq(m.assertAllowed(cfg,'whatsapp','work','123-456@g.us'), '123-456@g.us', 'assert-returns-normalized');
  let threw = false; try { m.assertAllowed(cfg,'whatsapp','work','nope@s.whatsapp.net'); } catch { threw = true; }
  eq(threw, true, 'assert-throws-when-denied');

  // empty-JID bypass guard: an empty/blank entry in allowed_jids must NOT grant
  // access to null/empty/garbage jids (security invariant — §6.4 guard must not
  // trust its own allow-list contents).
  const cfgEmpty = { version:1, decided:true, declined:false, providers:{ whatsapp:{ accounts:{
    work:{ capture:'session', mode:'strict', allowed_jids:['', '   ', '123-456@g.us'] }
  }}}};
  eq(m.isAllowed(cfgEmpty,'whatsapp','work',''), false, 'empty-jid-not-granted-by-empty-entry');
  eq(m.isAllowed(cfgEmpty,'whatsapp','work',null), false, 'null-jid-not-granted-by-empty-entry');
  eq(m.isAllowed(cfgEmpty,'whatsapp','work','123-456@g.us'), true, 'valid-jid-still-allowed-alongside-empty-entries');
  let threwEmpty = false; try { m.assertAllowed(cfgEmpty,'whatsapp','work',''); } catch { threwEmpty = true; }
  eq(threwEmpty, true, 'assertAllowed-throws-on-empty-jid-even-with-empty-entry');

  console.log(bad === 0 ? 'ALLOW OK' : 'ALLOW BAD ' + bad);
});
")
echo "$T37_OUT" | grep -qF "ALLOW OK" && ok "comms_allowlist normalize/isAllowed/group-grant" || { fail "comms_allowlist: $T37_OUT"; }

# ---- T38: comms_dedupe fingerprint — symmetric, no ordinal -----------------
echo
echo "T38 — comms_dedupe fingerprint symmetry (§4.2)"
T38_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_dedupe.js').then((m) => {
  let bad = 0;
  const eq = (a,b,label) => { if (a!==b) { console.log('FAIL',label,'got',a,'want',b); bad++; } };
  const ne = (a,b,label) => { if (a===b) { console.log('FAIL',label,'unexpectedly equal',a); bad++; } };

  // shape: 'fp:' + 40 hex chars (sha1)
  const live = { chatId:'c@g.us', ts:1717700000, senderId:'19999999999@s.whatsapp.net', text:'ok', source:'live', msgId:'3EB0', media:null };
  const fp = m.fingerprint(live);
  eq(/^fp:[0-9a-f]{40}$/.test(fp), true, 'fp-shape');

  // SYMMETRIC: a live record and an import record of the same content+minute+
  // sender produce the SAME fingerprint (no ordinal, no msgId, no source).
  const imp = { chatId:'c@g.us', ts:1717700030, senderId:'19999999999@s.whatsapp.net', text:'ok', source:'import', msgId:'import:abc', media:null };
  eq(m.fingerprint(imp), fp, 'live-import-symmetric-same-minute');

  // sender is normalized before hashing (device suffix doesn't fork identity)
  const withDevice = { ...live, senderId:'19999999999:7@s.whatsapp.net' };
  eq(m.fingerprint(withDevice), fp, 'sender-normalized-into-fp');

  // different minute -> different fp
  const nextMin = { ...live, ts: 1717700000 + 60 };
  ne(m.fingerprint(nextMin), fp, 'minute-bucketed');

  // different text -> different fp
  ne(m.fingerprint({ ...live, text:'nope' }), fp, 'text-sensitive');

  // different chatId -> different fp (chatId is the LEAD discriminator)
  ne(m.fingerprint({...live, chatId:'other@g.us'}), fp, 'chatId-sensitive');

  // media path: text empty, fingerprint uses media.mediaKey when present
  const med = { chatId:'c@g.us', ts:1717700000, senderId:'19999999999@s.whatsapp.net', text:'', media:{ mediaKey:'KEY1' }, source:'live', msgId:'x' };
  const med2 = { ...med, source:'import', msgId:'import:y' };
  eq(m.fingerprint(med), m.fingerprint(med2), 'media-key-symmetric');
  ne(m.fingerprint(med), fp, 'media-vs-text-differ');

  console.log(bad === 0 ? 'FP OK' : 'FP BAD ' + bad);
});
")
echo "$T38_OUT" | grep -qF "FP OK" && ok "comms_dedupe fingerprint symmetric + no-ordinal" || { fail "comms_dedupe fp: $T38_OUT"; }

# ---- T39: comms_dedupe reconcileImport — greedy 1:1, intra-minute ordinal --
echo
echo "T39 — comms_dedupe reconcileImport greedy 1:1 + ordinal"
T39_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_dedupe.js').then((m) => {
  let bad = 0;
  const eq = (a,b,label) => { if (JSON.stringify(a)!==JSON.stringify(b)) { console.log('FAIL',label,'got',JSON.stringify(a),'want',JSON.stringify(b)); bad++; } };

  const mk = (over) => ({ chatId:'c@g.us', accountId:'work', provider:'whatsapp', senderId:'19999999999@s.whatsapp.net', text:'ok', media:null, fromMe:false, kind:'text', reply_to:null, ...over });

  // Existing: ONE live 'ok' at 1717700000 (minute M). Import has TWO 'ok' in
  // that same minute (N=2 > M=1). Greedy 1:1: import[0] matches the live record
  // (dropped as dup, live wins); import[1] is unmatched -> NEW record with an
  // ordinal-folded synthetic msgId.
  const existing = [ mk({ ts:1717700000, msgId:'LIVE1', source:'live' }) ];
  const imports = [
    mk({ ts:1717700010, source:'import' }),  // export line order = ordinal source
    mk({ ts:1717700020, source:'import' }),
  ];
  const r = m.reconcileImport(existing, imports);

  eq(r.added.length, 1, 'one-new-import-record');
  eq(r.merged.length, 2, 'merged-has-live-plus-one-import');
  // live record survives untouched
  eq(r.merged.some(x => x.msgId === 'LIVE1' && x.source === 'live'), true, 'live-wins-kept');
  // the new import record has a synthetic import: msgId carrying the ordinal
  const newRec = r.added[0];
  eq(/^import:[0-9a-f]{40}$/.test(newRec.msgId), true, 'synthetic-msgId-shape');
  eq(newRec.source, 'import', 'new-record-source-import');

  // Idempotent re-import: running the SAME import again adds nothing new.
  const r2 = m.reconcileImport(r.merged, imports);
  eq(r2.added.length, 0, 'reimport-idempotent-no-new');

  // N <= M case: 1 import 'ok', existing already has 2 live 'ok' -> 0 added.
  const existing2 = [ mk({ts:1717700000,msgId:'L1',source:'live'}), mk({ts:1717700005,msgId:'L2',source:'live'}) ];
  const r3 = m.reconcileImport(existing2, [ mk({ts:1717700001,source:'import'}) ]);
  eq(r3.added.length, 0, 'N<=M-no-new');

  // Core ordinal guarantee: N>=2 new records (no existing) all get DISTINCT
  // synthetic msgIds. Without the ordinal in the hash all three would collide.
  const r4 = m.reconcileImport([], [
    mk({ ts:1717700000, source:'import' }),
    mk({ ts:1717700010, source:'import' }),
    mk({ ts:1717700020, source:'import' }),
  ]);
  eq(r4.added.length, 3, 'three-new-same-minute-all-added');
  const ids4 = r4.added.map(x => x.msgId);
  const unique4 = new Set(ids4).size;
  eq(unique4, 3, 'three-new-same-minute-all-distinct-msgIds');

  console.log(bad === 0 ? 'RECON OK' : 'RECON BAD ' + bad);
});
")
echo "$T39_OUT" | grep -qF "RECON OK" && ok "comms_dedupe reconcileImport greedy 1:1 + ordinal" || { fail "comms_dedupe reconcile: $T39_OUT"; }

# ---- T40: comms_store readCursor/writeCursor (atomic, default shape) -------
echo
echo "T40 — comms_store cursor read/write"
CUR_REPO="$(mktemp -d -t continuum-synth-cur.XXXXXX)"
T40_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_store.js').then((m) => {
  import('$PLUGIN_DIR/lib/paths.js').then((P) => {
    const fs = require('node:fs');
    const d = '$CUR_REPO';
    let bad = 0;
    const eq = (a,b,label) => { if (JSON.stringify(a)!==JSON.stringify(b)) { console.log('FAIL',label,'got',JSON.stringify(a),'want',JSON.stringify(b)); bad++; } };

    // absent cursor -> zeroed default shape, never throws
    const def = m.readCursor(d,'whatsapp','work','c@g.us');
    eq(def, {newestId:null,newestTs:0,oldestId:null,oldestTs:0,count:0}, 'cursor-default');

    // write + round-trip; tmp file is cleaned up (atomic rename)
    const cur = {newestId:'B',newestTs:200,oldestId:'A',oldestTs:100,count:2};
    m.writeCursor(d,'whatsapp','work','c@g.us', cur);
    eq(m.readCursor(d,'whatsapp','work','c@g.us'), cur, 'cursor-roundtrip');
    const dir = P.commsChatDir(d,'whatsapp','work','c@g.us');
    eq(fs.readdirSync(dir).filter(f=>f.includes('.tmp')), [], 'no-tmp-leftover');

    console.log(bad === 0 ? 'CUR OK' : 'CUR BAD ' + bad);
  });
});
")
echo "$T40_OUT" | grep -qF "CUR OK" && ok "comms_store cursor read/write" || { fail "comms_store cursor: $T40_OUT"; }
rm -rf "$CUR_REPO"

# ---- T41: comms_store appendMessage — dedupe + cursor + live-wins ----------
echo
echo "T41 — comms_store appendMessage idempotency + live-wins"
APP_REPO="$(mktemp -d -t continuum-synth-app.XXXXXX)"
T41_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_store.js').then((m) => {
  import('$PLUGIN_DIR/lib/comms_dedupe.js').then((D) => {
    const d = '$APP_REPO';
    let bad = 0;
    const eq = (a,b,label) => { if (a!==b) { console.log('FAIL',label,'got',a,'want',b); bad++; } };
    const base = { provider:'whatsapp', accountId:'work', chatId:'c@g.us', fromMe:false, senderId:'19999999999@s.whatsapp.net', senderName:'Alice', tsIso:'2026-06-06T18:13:20Z', kind:'text', media:null, reply_to:null };
    const withFp = (o) => ({ ...o, fingerprint: D.fingerprint(o) });

    // first live append
    const r1 = m.appendMessage(d, withFp({ ...base, msgId:'M1', ts:1717700000, text:'hi', source:'live' }));
    eq(r1.appended, true, 'first-appended');
    eq(m.readCursor(d,'whatsapp','work','c@g.us').count, 1, 'count-1');

    // TIER 1: same (provider,accountId,chatId,msgId) re-delivery -> no-op
    const r2 = m.appendMessage(d, withFp({ ...base, msgId:'M1', ts:1717700000, text:'hi', source:'live' }));
    eq(r2.appended, false, 'tier1-dup-noop');
    eq(r2.reason, 'duplicate-msgid', 'tier1-reason');
    eq(m.readCursor(d,'whatsapp','work','c@g.us').count, 1, 'count-still-1');

    // TIER 2: an IMPORT with same content+minute+sender (diff msgId) but a live
    // record already present -> dropped (live wins). Same fingerprint as M1.
    // ts:1717700030 is in the same minute as M1 (ts:1717700000) so fingerprints match.
    const imp = withFp({ ...base, msgId:'import:zzz', ts:1717700030, text:'hi', source:'import' });
    const r3 = m.appendMessage(d, imp);
    eq(r3.appended, false, 'tier2-import-dropped');
    eq(r3.reason, 'duplicate-fingerprint-live-wins', 'tier2-reason');
    eq(m.readCursor(d,'whatsapp','work','c@g.us').count, 1, 'count-still-1-after-import-dup');

    // a genuinely new message advances the cursor newest
    const r4 = m.appendMessage(d, withFp({ ...base, msgId:'M2', ts:1717700100, text:'later', source:'live' }));
    eq(r4.appended, true, 'second-appended');
    const cur = m.readCursor(d,'whatsapp','work','c@g.us');
    eq(cur.count, 2, 'count-2');
    eq(cur.newestId, 'M2', 'newest-id');
    eq(cur.newestTs, 1717700100, 'newest-ts');
    eq(cur.oldestId, 'M1', 'oldest-id');
    eq(cur.oldestTs, 1717700000, 'oldest-ts');

    // EDGE CASE (a): two distinct same-source live messages with identical content
    // in the same minute. Each has a distinct real msgId (cleared Tier 1). Tier 2
    // must NOT suppress the second — they are genuinely different user messages
    // (e.g. user texted 'ok' then 'ok' again). Both must be appended and counted.
    const base2 = { ...base, chatId:'c2@g.us' }; // separate chat to avoid cross-test pollution
    const rA = m.appendMessage(d, withFp({ ...base2, msgId:'REAL_AAA', ts:1717700005, text:'ok', source:'live' }));
    eq(rA.appended, true, 'same-src-dup-text-first-appended');
    eq(m.readCursor(d,'whatsapp','work','c2@g.us').count, 1, 'same-src-count-1');
    // second 'ok' in same minute — same fingerprint, distinct msgId, same source
    const rB = m.appendMessage(d, withFp({ ...base2, msgId:'REAL_BBB', ts:1717700015, text:'ok', source:'live' }));
    eq(rB.appended, true, 'same-src-dup-text-second-NOT-dropped');
    eq(m.readCursor(d,'whatsapp','work','c2@g.us').count, 2, 'same-src-count-2-both-appended');

    // EDGE CASE (b): import stored first, then live record of same logical message
    // arrives (reverse live-wins). Per spec §4.2 live wins unconditionally; the
    // import record must be superseded (removed) and the live record stored in its
    // place. count must NOT inflate — one logical message stays one record.
    const base3 = { ...base, chatId:'c3@g.us' };
    // Step 1: import stored first (simulates history import before live delivery)
    const rImp = m.appendMessage(d, withFp({ ...base3, msgId:'import:hist', ts:1717700200, text:'hello', source:'import' }));
    eq(rImp.appended, true, 'reverse-lw-import-first-appended');
    eq(m.readCursor(d,'whatsapp','work','c3@g.us').count, 1, 'reverse-lw-count-1');
    // Step 2: live re-delivery of the same logical message arrives later.
    // The import record is superseded; live wins and replaces it — count stays 1.
    const rLive = m.appendMessage(d, withFp({ ...base3, msgId:'LIVE_ZZZ', ts:1717700210, text:'hello', source:'live' }));
    eq(rLive.appended, true, 'reverse-lw-live-wins-appended');
    eq(m.readCursor(d,'whatsapp','work','c3@g.us').count, 1, 'reverse-lw-count-stays-1-not-inflated');
    // Readback: the store must hold exactly ONE record and it must be the live one.
    const c3Msgs = m.readAllMessages(d,'whatsapp','work','c3@g.us');
    eq(c3Msgs.length, 1, 'reverse-lw-store-has-exactly-1-record');
    eq(c3Msgs[0].msgId, 'LIVE_ZZZ', 'reverse-lw-stored-record-is-live');
    eq(c3Msgs[0].source, 'live', 'reverse-lw-stored-record-source-is-live');

    // EDGE CASE (b2): reverse live-wins with TWO pre-existing same-fp import records
    // (intra-minute 'ok'/'ok' case — reconcileImport mints distinct ordinal msgIds
    // but identical fingerprint). A single live re-delivery must supersede exactly
    // ONE import (1:1 greedy match), leaving the second import intact. Verified by
    // seeding import:a and import:b (same fp), then appending one live: the store
    // must end with exactly TWO records (one live + one import), not one (silent
    // loss) and not three (inflation). This is the §4.2 correctness-critical path.
    const base5 = { ...base, chatId:'c5@g.us' };
    const fp5 = D.fingerprint({ ...base5, ts:1717700400, text:'ok', source:'import' });
    // Seed two distinct import records that share the same fingerprint
    m.appendMessage(d, { ...base5, msgId:'import:aa', ts:1717700400, text:'ok', source:'import', fingerprint: fp5 });
    m.appendMessage(d, { ...base5, msgId:'import:bb', ts:1717700410, text:'ok', source:'import', fingerprint: fp5 });
    eq(m.readCursor(d,'whatsapp','work','c5@g.us').count, 2, 'two-fp-imports-seeded');
    // Live arrives for the same logical fingerprint
    const rLive5 = m.appendMessage(d, { ...base5, msgId:'LIVE5', ts:1717700405, text:'ok', source:'live', fingerprint: fp5 });
    eq(rLive5.appended, true, 'two-import-fp-live-wins-appended');
    const c5Msgs = m.readAllMessages(d,'whatsapp','work','c5@g.us');
    // MUST be 2: one import superseded by live, one import left intact (no silent loss)
    eq(c5Msgs.length, 2, 'two-fp-imports-live-wins-count-2-not-1');
    const c5Live = c5Msgs.filter(r => r.source === 'live');
    const c5Imp  = c5Msgs.filter(r => r.source === 'import');
    eq(c5Live.length, 1, 'two-fp-imports-exactly-one-live-record');
    eq(c5Imp.length,  1, 'two-fp-imports-exactly-one-import-record-kept');
    eq(c5Live[0].msgId, 'LIVE5', 'two-fp-imports-live-record-is-LIVE5');
    eq(m.readCursor(d,'whatsapp','work','c5@g.us').count, 2, 'two-fp-imports-cursor-count-2');

    // EDGE CASE (c): loop-ordering — store already has BOTH an import-dup AND a
    // real-dup (same fingerprint, same source) for the same fingerprint. An
    // incoming IMPORT must scan past the import match (would be a same-source
    // collision — must NOT suppress) to find the real-dup (live record) and drop
    // correctly. Verifies the subtle loop ordering in the Tier-2 scan.
    const base4 = { ...base, chatId:'c4@g.us' };
    const fp4 = D.fingerprint({ ...base4, ts:1717700300, text:'yo', source:'live' });
    // Seed: one live record + one distinct-msgId live record (same content, same minute)
    // These simulate two real user messages with same content — both stored.
    m.appendMessage(d, { ...base4, msgId:'REAL_A4', ts:1717700300, text:'yo', source:'live', fingerprint: fp4 });
    m.appendMessage(d, { ...base4, msgId:'REAL_B4', ts:1717700305, text:'yo', source:'live', fingerprint: fp4 });
    eq(m.readCursor(d,'whatsapp','work','c4@g.us').count, 2, 'loop-ord-seed-count-2');
    // Now an import arrives with the same fingerprint. It should be dropped because
    // a live record exists (forward live-wins path). The scan must encounter the
    // REAL_A4 live match first and return duplicate-fingerprint-live-wins.
    const rImpC4 = m.appendMessage(d, { ...base4, msgId:'import:c4z', ts:1717700302, text:'yo', source:'import', fingerprint: fp4 });
    eq(rImpC4.appended, false, 'loop-ord-import-dropped-when-live-exists');
    eq(rImpC4.reason, 'duplicate-fingerprint-live-wins', 'loop-ord-reason');
    eq(m.readCursor(d,'whatsapp','work','c4@g.us').count, 2, 'loop-ord-count-unchanged');

    console.log(bad === 0 ? 'APPEND OK' : 'APPEND BAD ' + bad);
  });
});
")
echo "$T41_OUT" | grep -qF "APPEND OK" && ok "comms_store appendMessage dedupe + cursor + live-wins" || { fail "comms_store append: $T41_OUT"; }
rm -rf "$APP_REPO"

# ---- T42: comms_store getSlice — sort/clamp/byte-budget/continuation -------
echo
echo "T42 — comms_store getSlice caps + continuation"
SL_REPO="$(mktemp -d -t continuum-synth-sl.XXXXXX)"
T42_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_store.js').then((m) => {
  import('$PLUGIN_DIR/lib/comms_dedupe.js').then((D) => {
    const d = '$SL_REPO';
    let bad = 0;
    const eq = (a,b,label) => { if (a!==b) { console.log('FAIL',label,'got',a,'want',b); bad++; } };
    const base = { provider:'whatsapp', accountId:'work', chatId:'c@g.us', fromMe:false, senderId:'19999999999@s.whatsapp.net', senderName:'Alice', kind:'text', media:null, reply_to:null, source:'live' };
    // append 50 messages, ts 1000..1049 (insert OUT of order to prove read-sort)
    const order = [...Array(50).keys()].sort(()=>0); // 0..49
    for (const i of [25,0,49,10,...order]) {
      const o = { ...base, msgId:'M'+i, ts:1000+i, tsIso:new Date((1000+i)*1000).toISOString(), text:'msg '+i };
      m.appendMessage(d, { ...o, fingerprint: D.fingerprint(o) });
    }

    // default limit 20, newest-first (ts desc)
    const s = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'c@g.us' });
    eq(s.messages.length, 20, 'default-limit-20');
    eq(s.messages[0].msgId, 'M49', 'newest-first');
    eq(s.messages[19].msgId, 'M30', '20th-is-M30');

    // HARD max clamp: ask for 9999 -> clamped to 200 (only 50 exist here).
    // Pass a generous byteBudget so the byte-budget gate does not interfere with
    // this limit-clamping assertion (50 msgs × ~332 bytes = ~16 600 B > default
    // 16 KB budget, so the default budget would cut it to 49 when *4 is active).
    const big = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'c@g.us', limit:9999, byteBudget:1024*1024 });
    eq(big.limitApplied, 200, 'hard-clamp-200');
    eq(big.messages.length, 50, 'returns-all-50-under-cap');

    // byte budget: a tiny budget truncates and hands back a continuation cursor.
    // Each stored message JSON is ~330 bytes; sz = estimateTokens(...)*4 ≈ 332.
    // Budget=300: first message always included (guard skips when out.length===0),
    // second would push bytes to ~664 > 300, so exactly 1 message is returned.
    // This assertion discriminates the byte-budget unit: without the *4 multiplier
    // sz≈83 (token count) and 3 messages would fit under 300, so the test would
    // return 3 — confirming the *4 is load-bearing for the byte-budget invariant.
    const tiny = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'c@g.us', limit:200, byteBudget:300 });
    eq(tiny.messages.length < 50, true, 'byte-budget-truncates');
    eq(tiny.messages.length, 1, 'byte-budget-exact-1');
    eq(typeof tiny.continuation === 'string' && tiny.continuation.length > 0, true, 'continuation-emitted');

    // continuation paging: next page resumes strictly older than last returned
    const lastTs = tiny.messages[tiny.messages.length-1].ts;
    const page2 = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'c@g.us', limit:200, continuation: tiny.continuation });
    eq(page2.messages.every(x => x.ts < lastTs), true, 'continuation-resumes-older');

    // empty chat -> empty slice, no continuation, no throw
    const empty = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'absent@g.us' });
    eq(empty.messages.length, 0, 'empty-chat');
    eq(empty.continuation, null, 'empty-no-continuation');

    console.log(bad === 0 ? 'SLICE OK' : 'SLICE BAD ' + bad);
  });
});
")
echo "$T42_OUT" | grep -qF "SLICE OK" && ok "comms_store getSlice sort/clamp/byte-budget/continuation" || { fail "comms_store slice: $T42_OUT"; }
rm -rf "$SL_REPO"

# ---- T43: comms_store listChats — allowlist-filtered + meta + cursor -------
echo
echo "T43 — comms_store listChats (allowlist filtered)"
LC_REPO="$(mktemp -d -t continuum-synth-lc.XXXXXX)"
T43_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_store.js').then((m) => {
  import('$PLUGIN_DIR/lib/comms_dedupe.js').then((D) => {
    import('$PLUGIN_DIR/lib/paths.js').then((P) => {
      const fs = require('node:fs');
      const d = '$LC_REPO';
      let bad = 0;
      const eq = (a,b,label) => { if (JSON.stringify(a)!==JSON.stringify(b)) { console.log('FAIL',label,'got',JSON.stringify(a),'want',JSON.stringify(b)); bad++; } };
      const mk = (chatId, ts, text) => { const o = { provider:'whatsapp', accountId:'work', chatId, msgId:'M'+ts, ts, tsIso:new Date(ts*1000).toISOString(), fromMe:false, senderId:'19999999999@s.whatsapp.net', senderName:'A', kind:'text', text, media:null, reply_to:null, source:'live' }; return { ...o, fingerprint: D.fingerprint(o) }; };

      // three chats stored: two allowlisted ('c@g.us', 'b@g.us'), one not ('x@g.us')
      // c@g.us has newestTs=1100; b@g.us has newestTs=500 (older) — exercises DESC sort.
      // b@g.us has NO meta.json — exercises name/chatKind null fallback.
      m.appendMessage(d, mk('c@g.us', 1000, 'hi'));
      m.appendMessage(d, mk('c@g.us', 1100, 'yo'));
      m.appendMessage(d, mk('x@g.us', 1200, 'secret'));
      m.appendMessage(d, mk('b@g.us', 500, 'older'));
      // give c@g.us a meta.json (name + chatKind); b@g.us intentionally has none
      fs.writeFileSync(P.commsMetaPath(d,'whatsapp','work','c@g.us'),
        JSON.stringify({ name:'Team', chatKind:'group', updatedAt:1100 }));

      // allowedJids structural filter: only c@g.us and b@g.us are returned; x@g.us is excluded
      const allowed = ['123@s.whatsapp.net','c@g.us','b@g.us'].map(s=>s);
      const chats = m.listChats(d, allowed);
      eq(chats.length, 2, 'only-allowlisted-chats-returned');

      // Sort invariant: newestTs DESC — c@g.us (1100) must come before b@g.us (500)
      eq(chats[0].chatId, 'c@g.us', 'first-chat-is-newest');
      eq(chats[1].chatId, 'b@g.us', 'second-chat-is-older');

      // c@g.us: meta fields populated from meta.json
      eq(chats[0].name, 'Team', 'name-from-meta');
      eq(chats[0].chatKind, 'group', 'chatKind-from-meta');
      eq(chats[0].count, 2, 'count-from-cursor');
      eq(chats[0].newestTs, 1100, 'newestTs-from-cursor');

      // b@g.us: no meta.json -> name and chatKind must be null (not undefined or missing)
      eq(chats[1].name, null, 'no-meta-name-is-null');
      eq(chats[1].chatKind, null, 'no-meta-chatKind-is-null');
      eq(chats[1].count, 1, 'no-meta-count-from-cursor');
      eq(chats[1].newestTs, 500, 'no-meta-newestTs');

      // null allowedJids -> nothing leaks (strict-by-default)
      eq(m.listChats(d, null).length, 0, 'null-allowed-returns-none');

      console.log(bad === 0 ? 'LIST OK' : 'LIST BAD ' + bad);
    });
  });
});
")
echo "$T43_OUT" | grep -qF "LIST OK" && ok "comms_store listChats allowlist-filtered" || { fail "comms_store listChats: $T43_OUT"; }
rm -rf "$LC_REPO"

# ============================================================================
# Phase 2 (comms): comms_recall — scored, capped, allowlist-scoped retrieval
# ============================================================================

CR_REPO="$(mktemp -d -t continuum-synth-cr.XXXXXX)"
mkdir -p "$CR_REPO/.continuum/comms"

_CR_ALLOWED_GROUP="123-456@g.us"
_CR_ALLOWED_DM="19999999999@s.whatsapp.net"
_CR_DENIED="18880000000@s.whatsapp.net"
cat > "$CR_REPO/.continuum/comms/config.json" <<EOF
{
  "version": 1,
  "decided": true,
  "declined": false,
  "providers": {
    "whatsapp": {
      "accounts": {
        "work": {
          "capture": "session",
          "mode": "strict",
          "allowed_jids": ["$_CR_ALLOWED_GROUP", "$_CR_ALLOWED_DM"]
        }
      }
    }
  }
}
EOF

_CR_STORE="$CR_REPO/.continuum/comms/store/whatsapp/work"
_cr_seed() { # $1=chatId $2=msgId $3=ts $4=tsIso $5=senderName $6=senderId $7=text
  local dir="$_CR_STORE/$1"
  mkdir -p "$dir"
  printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"%s","fingerprint":"fp:%s","fromMe":false,"senderId":"%s","senderName":"%s","ts":%s,"tsIso":"%s","kind":"text","text":"%s","media":null,"reply_to":null,"source":"live"}\n' \
    "$1" "$2" "$2" "$6" "$5" "$3" "$4" "$7" >> "$dir/messages.jsonl"
}

_cr_seed "$_CR_ALLOWED_GROUP" "G1" 1717700000 "2026-06-06T18:13:20Z" "Alice" "$_CR_ALLOWED_DM" "lunch plans for friday"
_cr_seed "$_CR_ALLOWED_GROUP" "G2" 1717700600 "2026-06-06T18:23:20Z" "Bob"   "$_CR_ALLOWED_DM" "we should deploy the deploy script after the deploy window"
_cr_seed "$_CR_ALLOWED_GROUP" "G3" 1717800000 "2026-06-07T22:00:00Z" "Alice" "$_CR_ALLOWED_DM" "deploy is done"
_cr_seed "$_CR_ALLOWED_DM"    "D1" 1717700100 "2026-06-06T18:15:00Z" "Carol" "$_CR_ALLOWED_DM" "migrating to postgres 16 next sprint"
mkdir -p "$_CR_STORE/$_CR_DENIED"
printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"X1","fingerprint":"fp:X1","fromMe":false,"senderId":"%s","senderName":"Mallory","ts":1717700200,"tsIso":"2026-06-06T18:16:40Z","kind":"text","text":"secret deploy in the denied chat","media":null,"reply_to":null,"source":"live"}\n' \
  "$_CR_DENIED" "$_CR_DENIED" >> "$_CR_STORE/$_CR_DENIED/messages.jsonl"

_CR_CALL() {
  node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  const opts = JSON.parse(process.argv[1]);
  const r = commsRecall('$CR_REPO', opts);
  console.log(JSON.stringify(r));
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
" "$1"
}

# ---- T44: comms_recall 'deploy' top hit is G2 (highest TF) ------------------
echo
echo "T44 — comms_recall 'deploy' ranks the multi-mention message first"
_CR_R1=$(_CR_CALL '{"query":"deploy"}')
_CR_TOPID=$(echo "$_CR_R1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
[ "$_CR_TOPID" = "G2" ] && ok "top hit msgId == G2" || { fail "expected G2 got $_CR_TOPID"; log "$_CR_R1"; }

# ---- T45: §10 hit shape — chatId, tsIso, senderName, excerpt, msgId --------
echo
echo "T45 — each hit carries chatId, tsIso, senderName, excerpt, msgId (§10)"
_CR_SHAPE=$(echo "$_CR_R1" | python3 -c "
import json,sys
d=json.load(sys.stdin); h=d['hits'][0]
need=['chatId','tsIso','senderName','excerpt','msgId']
miss=[k for k in need if k not in h or h[k] in (None,'')]
print('OK' if not miss else 'MISS:'+','.join(miss))
")
[ "$_CR_SHAPE" = "OK" ] && ok "hit shape complete per §10" || fail "hit shape: $_CR_SHAPE"

# ---- T46: allowlist scope — denied chat never surfaces ----------------------
echo
echo "T46 — 'deploy' message in non-allowlisted chat never surfaces"
_CR_DENIED_CHECK=$(echo "$_CR_R1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('FOUND' if any(h['chatId']=='$_CR_DENIED' or h['msgId']=='X1' for h in d['hits']) else 'CLEAN')
")
[ "$_CR_DENIED_CHECK" = "CLEAN" ] && ok "denied chat excluded from results" || fail "LEAK: denied chat surfaced"

# ---- T47: default limit 10, hard max clamp 200 (§4.3) -----------------------
echo
echo "T47 — over-limit clamped to 200 and default limit is 10 (§4.3)"
_CR_CLAMP=$(_CR_CALL '{"query":"deploy","limit":99999}' | python3 -c "import json,sys; print(json.load(sys.stdin)['limit'])")
[ "$_CR_CLAMP" = "200" ] && ok "limit 99999 clamped to 200" || fail "expected clamp to 200 got $_CR_CLAMP"
_CR_DEF=$(_CR_CALL '{"query":"deploy"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['limit'])")
[ "$_CR_DEF" = "10" ] && ok "default limit is 10" || fail "expected default 10 got $_CR_DEF"

# ---- T48: chatId filter scopes results to one chat --------------------------
echo
echo "T48 — chatId filter scopes results to that chat only"
_CR_R5=$(_CR_CALL "{\"query\":\"postgres\",\"chatId\":\"$_CR_ALLOWED_DM\"}")
_CR_PGID=$(echo "$_CR_R5" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
_CR_PGN=$(echo "$_CR_R5" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_PGID" = "D1" ] && [ "$_CR_PGN" = "1" ] && ok "postgres → D1 in the DM only" || fail "expected D1/1 got $_CR_PGID/$_CR_PGN"

# ---- T49: since/until window filters by ts ----------------------------------
echo
echo "T49 — since/until filter messages by epoch ts"
_CR_R6=$(_CR_CALL '{"query":"deploy","since":1717750000}')
_CR_N6=$(echo "$_CR_R6" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
_CR_TOP6=$(echo "$_CR_R6" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
[ "$_CR_N6" = "1" ] && [ "$_CR_TOP6" = "G3" ] && ok "since filter keeps only G3" || fail "expected 1/G3 got $_CR_N6/$_CR_TOP6"
_CR_R6B=$(_CR_CALL '{"query":"deploy","until":1717750000}')
_CR_N6B=$(echo "$_CR_R6B" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
_CR_TOP6B=$(echo "$_CR_R6B" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
_CR_UNTIL_HAS_G3=$(echo "$_CR_R6B" | python3 -c "import json,sys; print('YES' if any(h['msgId']=='G3' for h in json.load(sys.stdin)['hits']) else 'NO')")
[ "$_CR_N6B" = "1" ] && [ "$_CR_TOP6B" = "G2" ] && [ "$_CR_UNTIL_HAS_G3" = "NO" ] && ok "until filter keeps G2, excludes G3" || fail "expected 1/G2/no-G3 got $_CR_N6B/$_CR_TOP6B/G3=$_CR_UNTIL_HAS_G3"

# ---- T50: no-match query returns empty hits, no crash -----------------------
echo
echo "T50 — non-matching query returns hitCount 0"
_CR_N7=$(_CR_CALL '{"query":"kubernetes"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_N7" = "0" ] && ok "no match → 0 hits, no error" || fail "expected 0 got $_CR_N7"

# ---- T51: provider filter scopes to that provider only ----------------------
echo
echo "T51 — provider filter restricts to that provider"
_CR_N8=$(_CR_CALL '{"query":"deploy","provider":"whatsapp"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_N8" -ge 1 ] && ok "provider=whatsapp returns hits (got $_CR_N8)" || fail "expected >=1 hits for provider=whatsapp got $_CR_N8"
_CR_N8B=$(_CR_CALL '{"query":"deploy","provider":"telegram"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_N8B" = "0" ] && ok "provider=telegram (none) returns 0 hits" || fail "expected 0 hits for unknown provider got $_CR_N8B"

# ---- T52: accountId filter scopes to that account only ----------------------
echo
echo "T52 — accountId filter restricts to that account"
_CR_N9=$(_CR_CALL '{"query":"deploy","accountId":"work"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_N9" -ge 1 ] && ok "accountId=work returns hits (got $_CR_N9)" || fail "expected >=1 hits for accountId=work got $_CR_N9"
_CR_N9B=$(_CR_CALL '{"query":"deploy","accountId":"personal"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_N9B" = "0" ] && ok "accountId=personal (none) returns 0 hits" || fail "expected 0 hits for unknown accountId got $_CR_N9B"

# ---- T53: missing/empty query throws 'query required' -----------------------
echo
echo "T53 — missing or empty query throws 'query required'"
_CR_ERR_EMPTY=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  try { commsRecall('$CR_REPO', { query: '' }); console.log('NO_THROW'); }
  catch(e) { console.log(e.message.includes('query required') ? 'THREW_OK' : 'THREW_WRONG:' + e.message); }
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
")
[ "$_CR_ERR_EMPTY" = "THREW_OK" ] && ok "empty query throws 'query required'" || fail "expected THREW_OK got $_CR_ERR_EMPTY"
_CR_ERR_MISSING=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  try { commsRecall('$CR_REPO', {}); console.log('NO_THROW'); }
  catch(e) { console.log(e.message.includes('query required') ? 'THREW_OK' : 'THREW_WRONG:' + e.message); }
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
")
[ "$_CR_ERR_MISSING" = "THREW_OK" ] && ok "missing query throws 'query required'" || fail "expected THREW_OK got $_CR_ERR_MISSING"

# ---- T54: duplicate/equivalent allowlist entries do not inflate hitCount ----
echo
echo "T54 — duplicate/equivalent allowlist entries don't inflate hitCount"
_CR_DUP_REPO="$(mktemp -d -t continuum-synth-crd.XXXXXX)"
mkdir -p "$_CR_DUP_REPO/.continuum/comms/store/whatsapp/work/$_CR_ALLOWED_DM"
cat > "$_CR_DUP_REPO/.continuum/comms/config.json" <<DUPEOF
{
  "version": 1,
  "decided": true,
  "declined": false,
  "providers": {
    "whatsapp": {
      "accounts": {
        "work": {
          "capture": "session",
          "mode": "strict",
          "allowed_jids": ["$_CR_ALLOWED_DM", "19999999999:12@s.whatsapp.net"]
        }
      }
    }
  }
}
DUPEOF
printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"DUP1","fingerprint":"fp:DUP1","fromMe":false,"senderId":"%s","senderName":"Carol","ts":1717700100,"tsIso":"2026-06-06T18:15:00Z","kind":"text","text":"postgres migration","media":null,"reply_to":null,"source":"live"}\n' \
  "$_CR_ALLOWED_DM" "$_CR_ALLOWED_DM" >> "$_CR_DUP_REPO/.continuum/comms/store/whatsapp/work/$_CR_ALLOWED_DM/messages.jsonl"
_CR_HC11A=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  const r = commsRecall('$_CR_DUP_REPO', {query:'postgres'});
  console.log(JSON.stringify(r));
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_HC11A" = "1" ] && ok "device-suffix dup in allowlist: hitCount==1 (not inflated)" || fail "expected hitCount 1 got $_CR_HC11A (shard scanned twice)"
_CR_DUP2_REPO="$(mktemp -d -t continuum-synth-crd2.XXXXXX)"
mkdir -p "$_CR_DUP2_REPO/.continuum/comms/store/whatsapp/work/$_CR_ALLOWED_DM"
cat > "$_CR_DUP2_REPO/.continuum/comms/config.json" <<DUP2EOF
{
  "version": 1,
  "decided": true,
  "declined": false,
  "providers": {
    "whatsapp": {
      "accounts": {
        "work": {
          "capture": "session",
          "mode": "strict",
          "allowed_jids": ["$_CR_ALLOWED_DM", "$_CR_ALLOWED_DM"]
        }
      }
    }
  }
}
DUP2EOF
printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"DUP2","fingerprint":"fp:DUP2","fromMe":false,"senderId":"%s","senderName":"Carol","ts":1717700100,"tsIso":"2026-06-06T18:15:00Z","kind":"text","text":"postgres migration","media":null,"reply_to":null,"source":"live"}\n' \
  "$_CR_ALLOWED_DM" "$_CR_ALLOWED_DM" >> "$_CR_DUP2_REPO/.continuum/comms/store/whatsapp/work/$_CR_ALLOWED_DM/messages.jsonl"
_CR_HC11B=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  const r = commsRecall('$_CR_DUP2_REPO', {query:'postgres'});
  console.log(JSON.stringify(r));
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$_CR_HC11B" = "1" ] && ok "verbatim-duplicate JID in allowlist: hitCount==1 (not inflated)" || fail "expected hitCount 1 got $_CR_HC11B (shard scanned twice)"
rm -rf "$CR_REPO" "$_CR_DUP_REPO" "$_CR_DUP2_REPO"

# ============================================================================
# Phase 5: comms init-gate, idempotent gitignore, state files, slash commands
# ============================================================================

# ---- T55: comms_state writers + read side used by the hook ------------------
echo
echo "T55 — comms_state: setAccountStatus + setSeen + read side"
C55REPO="$(mktemp -d -t continuum-synth-c55.XXXXXX)"
mkdir -p "$C55REPO/.continuum/comms"
T55_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_state.js').then((m) => {
  const fs = require('node:fs');
  const d = '$C55REPO';
  // MCP writes link status:
  m.setAccountStatus(d, 'whatsapp', 'work', 'connected');
  m.setAccountStatus(d, 'whatsapp', 'home', 'needs_login');
  const st = m.readState(d);
  const status_ok = st.whatsapp.work.status === 'connected'
    && st.whatsapp.home.status === 'needs_login'
    && typeof st.whatsapp.work.updatedAt === 'number';
  // accountStatuses flattens for the hook:
  const flat = m.accountStatuses(st);
  const flat_ok = flat.some(x => x.provider==='whatsapp' && x.accountId==='home' && x.status==='needs_login');
  // watermark write/read:
  m.setSeen(d, 'whatsapp', 'work', '123@g.us', 1717700000);
  const seen = m.readSeen(d);
  const seen_ok = seen['whatsapp/work/123@g.us'] === 1717700000;
  // absent files degrade to empty objects (hook must not throw):
  const emptySt = m.readState('/tmp/no-such-dir-c55');
  const emptySeen = m.readSeen('/tmp/no-such-dir-c55');
  const empty_ok = JSON.stringify(emptySt)==='{}' && JSON.stringify(emptySeen)==='{}';
  // fault-tolerance: invalid JSON in state.json degrades to {} (catch branch):
  const stPath = d + '/.continuum/comms/state.json';
  const seenPath = d + '/.continuum/comms/.last-session-seen.json';
  fs.writeFileSync(stPath, 'THIS IS NOT JSON');
  const badJsonSt = m.readState(d);
  const badJsonSt_ok = JSON.stringify(badJsonSt) === '{}';
  fs.writeFileSync(seenPath, 'THIS IS NOT JSON');
  const badJsonSeen = m.readSeen(d);
  const badJsonSeen_ok = JSON.stringify(badJsonSeen) === '{}';
  // fault-tolerance: array JSON in state.json / seen degrades to {} (array guard):
  fs.writeFileSync(stPath, '[1,2,3]');
  const arraySt = m.readState(d);
  const arraySt_ok = JSON.stringify(arraySt) === '{}';
  // accountStatuses on array-fallback {} must yield an empty list (no garbage):
  const arrayFlat = m.accountStatuses(arraySt);
  const arrayFlat_ok = arrayFlat.length === 0;
  fs.writeFileSync(seenPath, '[1,2,3]');
  const arraySeen = m.readSeen(d);
  const arraySeen_ok = JSON.stringify(arraySeen) === '{}';
  const fault_ok = badJsonSt_ok && badJsonSeen_ok && arraySt_ok && arrayFlat_ok && arraySeen_ok;
  console.log((status_ok && flat_ok && seen_ok && empty_ok && fault_ok) ? 'STATE OK'
    : 'STATE BAD st='+status_ok+' flat='+flat_ok+' seen='+seen_ok+' empty='+empty_ok+' fault='+fault_ok
      +' badJsonSt='+badJsonSt_ok+' badJsonSeen='+badJsonSeen_ok
      +' arraySt='+arraySt_ok+' arrayFlat='+arrayFlat_ok+' arraySeen='+arraySeen_ok);
}).catch(e => console.log('STATE THREW', e.message));
")
echo "$T55_OUT" | grep -qF "STATE OK" && ok "comms_state writers + read side correct" || { fail "comms_state: $T55_OUT"; }
rm -rf "$C55REPO"

# ---- T56: session_start appends comms ignores to a PRE-EXISTING .gitignore ---
echo
echo "T56 — gitignore writer is idempotent-append (comms lines added to existing file)"
G56REPO="$(mktemp -d -t continuum-synth-g56.XXXXXX)"
git -C "$G56REPO" init -q
# Pre-existing .continuum/.gitignore WITHOUT the comms lines (simulates a repo
# bootstrapped before this change). Must keep its old lines AND gain comms ones.
mkdir -p "$G56REPO/.continuum"
printf '%s\n' "# Auto-written by continuum. Transient / page-derived data — do not commit." "verification/" "runs/" > "$G56REPO/.continuum/.gitignore"
run_hook hooks/session_start.js "{\"session_id\":\"sg56\",\"cwd\":\"$G56REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" > /dev/null
GI="$G56REPO/.continuum/.gitignore"
grep -qxF "comms/*" "$GI" && ok "comms/* present after append" || fail "comms/* missing from existing .gitignore"
grep -qxF "!comms/config.json" "$GI" && ok "!comms/config.json exception present" || fail "config.json exception missing"
grep -qxF "verification/" "$GI" && ok "pre-existing lines preserved" || fail "pre-existing lines clobbered"
# Idempotency: a SECOND session must not duplicate the comms lines.
run_hook hooks/session_start.js "{\"session_id\":\"sg56b\",\"cwd\":\"$G56REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" > /dev/null
DUP=$(grep -cxF "comms/*" "$GI")
[ "$DUP" = "1" ] && ok "comms/* not duplicated on 2nd run" || fail "comms/* duplicated ($DUP times)"
rm -rf "$G56REPO"

# ---- T57: first-session single-emit — bootstrap directive still emitted ------
echo
echo "T57 — single terminal emit: bootstrap directive present on a fresh repo, exactly one JSON object"
F57REPO="$(mktemp -d -t continuum-synth-f57.XXXXXX)"
git -C "$F57REPO" init -q
F57_OUT="$(run_hook hooks/session_start.js "{\"session_id\":\"sf57\",\"cwd\":\"$F57REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
# Exactly one hookSpecificOutput object on stdout (no double-emit from a leftover early path):
EMITS=$(echo "$F57_OUT" | grep -oF '"hookSpecificOutput"' | wc -l | tr -d ' ')
[ "$EMITS" = "1" ] && ok "exactly one emit on first session" || fail "expected 1 emit got $EMITS"
F57_CTX="$(echo "$F57_OUT" | extract_ctx)"
echo "$F57_CTX" | grep -q "No context chain" && ok "bootstrap directive still present via accumulator" || fail "bootstrap directive lost in refactor"
# Task-30 co-emission contract: a fresh (un-bootstrapped) AND undecided repo must emit
# BOTH the bootstrap directive AND the comms ASK in the same single context payload.
# This locks down the wiring of commsGate into the accumulator so a regression that
# dropped the comms clause (or re-introduced an early-exit before commsGate runs) is caught.
echo "$F57_CTX" | grep -q "hasn't decided about communication-channel sync" && ok "comms ASK co-emitted with bootstrap directive in one payload" || fail "comms ASK missing from fresh-repo context (Task-30 co-emission contract broken)"
rm -rf "$F57REPO"

# ---- T58: comms gate branches (ASK source-aware / declined / onboard / fresh) -
echo
echo "T58 — comms gate: ASK on startup, silent on resume, declined silent, onboard, freshness"
gate_ctx() {  # $1=repo $2=source ; bootstrap the chain so we're past the bootstrap branch
  run_hook hooks/session_start.js "{\"session_id\":\"sgate\",\"cwd\":\"$1\",\"hook_event_name\":\"SessionStart\",\"source\":\"$2\"}" | extract_ctx
}
mk_gate_repo() {  # bootstrapped repo so commsGate is reached
  local r; r="$(mktemp -d -t continuum-synth-gate.XXXXXX)"
  git -C "$r" init -q
  mkdir -p "$r/.continuum/chain/links/0001" "$r/.continuum/comms"
  echo '{"id":1,"ts":"2026-05-18T10:00:00Z","commit":null,"summary_tokens":10,"tags":["bootstrap"]}' > "$r/.continuum/chain/index.jsonl"
  echo "x" > "$r/.continuum/chain/links/0001/summary.md"; echo '{}' > "$r/.continuum/chain/links/0001/refs.json"
  echo "# S" > "$r/.continuum/STATE.md"
  echo "$r"
}

# (a) undecided + startup → ASK
GA="$(mk_gate_repo)"
# no comms/config.json → undecided
gate_ctx "$GA" startup | grep -q "hasn't decided about communication-channel sync" && ok "ASK emitted on startup when undecided" || fail "ASK missing on startup"
# (a2) undecided + clear → ASK (clear is the second ASK-triggering source; a future edit
#      that drops 'clear' from the condition would remove this source-aware contract).
gate_ctx "$GA" clear | grep -q "hasn't decided about communication-channel sync" && ok "ASK emitted on clear when undecided" || fail "ASK missing on clear (source-aware contract broken)"
# (b) undecided + resume → silent (no ASK)
gate_ctx "$GA" resume | grep -q "hasn't decided about communication-channel sync" && fail "ASK wrongly emitted on resume" || ok "silent on resume when undecided"
# (b2) undecided + compact → silent (no ASK)
gate_ctx "$GA" compact | grep -q "hasn't decided about communication-channel sync" && fail "ASK wrongly emitted on compact" || ok "silent on compact when undecided"
rm -rf "$GA"

# (c) declined → silent on startup
GB="$(mk_gate_repo)"
echo '{"version":1,"decided":true,"declined":true}' > "$GB/.continuum/comms/config.json"
GBCTX="$(gate_ctx "$GB" startup)"
echo "$GBCTX" | grep -q "hasn't decided about communication-channel sync" && fail "ASK emitted despite declined" || ok "declined → no ASK"
echo "$GBCTX" | grep -qi "comms-setup" && fail "onboard emitted despite declined" || ok "declined → no onboard"
rm -rf "$GB"

# (d) decided + account needs_login → ONBOARD
GC="$(mk_gate_repo)"
echo '{"version":1,"decided":true,"declined":false,"providers":{"whatsapp":{"accounts":{"work":{"capture":"session","mode":"strict","allowed_jids":["123@g.us"]}}}}}' > "$GC/.continuum/comms/config.json"
echo '{"whatsapp":{"work":{"status":"needs_login","updatedAt":1717700000}}}' > "$GC/.continuum/comms/state.json"
gate_ctx "$GC" startup | grep -q "comms-setup" && ok "onboard directive emitted when account needs_login" || fail "onboard missing for needs_login"
rm -rf "$GC"

# (d2) decided + enabled but NO providers configured → distinct "no provider linked yet" ONBOARD message
# (covers the configured.length === 0 branch — different message text from the needs_login branch).
GC2="$(mk_gate_repo)"
echo '{"version":1,"decided":true,"declined":false,"providers":{}}' > "$GC2/.continuum/comms/config.json"
GC2CTX="$(gate_ctx "$GC2" startup)"
echo "$GC2CTX" | grep -q "comms-setup" && ok "onboard emitted when decided+enabled but no provider configured" || fail "onboard missing when no provider configured"
echo "$GC2CTX" | grep -q "no provider is linked yet" && ok "onboard text is the 'no provider' variant (not needs_login text)" || fail "expected 'no provider is linked yet' message text"
rm -rf "$GC2"

# (e) decided + connected + new messages → freshness note
GD="$(mk_gate_repo)"
echo '{"version":1,"decided":true,"declined":false,"providers":{"whatsapp":{"accounts":{"work":{"capture":"session","mode":"strict","allowed_jids":["123@g.us"]}}}}}' > "$GD/.continuum/comms/config.json"
echo '{"whatsapp":{"work":{"status":"connected","updatedAt":1717700000}}}' > "$GD/.continuum/comms/state.json"
mkdir -p "$GD/.continuum/comms/store/whatsapp/work/123@g.us"
echo '{"newestId":"m9","newestTs":1717800000,"oldestId":"m1","oldestTs":1717700000,"count":9}' > "$GD/.continuum/comms/store/whatsapp/work/123@g.us/cursor.json"
# watermark behind the cursor → there ARE new messages
echo '{"whatsapp/work/123@g.us":1717700500}' > "$GD/.continuum/comms/.last-session-seen.json"
gate_ctx "$GD" startup | grep -qi "new message" && ok "freshness note emitted when cursor ahead of watermark" || fail "freshness note missing"
rm -rf "$GD"

# (e2) decided + connected + NO new messages (watermark at/ahead of cursor) → silent
# Negative assertion: a regression that made the freshness note always-fire (or always-silent)
# would break this. Cursor newestTs == watermark means nothing new since last session.
GE="$(mk_gate_repo)"
echo '{"version":1,"decided":true,"declined":false,"providers":{"whatsapp":{"accounts":{"work":{"capture":"session","mode":"strict","allowed_jids":["123@g.us"]}}}}}' > "$GE/.continuum/comms/config.json"
echo '{"whatsapp":{"work":{"status":"connected","updatedAt":1717700000}}}' > "$GE/.continuum/comms/state.json"
mkdir -p "$GE/.continuum/comms/store/whatsapp/work/123@g.us"
echo '{"newestId":"m9","newestTs":1717800000,"oldestId":"m1","oldestTs":1717700000,"count":9}' > "$GE/.continuum/comms/store/whatsapp/work/123@g.us/cursor.json"
# watermark AT the cursor newestTs → no new messages since last session
echo '{"whatsapp/work/123@g.us":1717800000}' > "$GE/.continuum/comms/.last-session-seen.json"
GE_CTX="$(gate_ctx "$GE" startup)"
echo "$GE_CTX" | grep -qi "new message" && fail "freshness note wrongly fired when watermark == cursor newestTs (silent branch broken)" || ok "silent when watermark at cursor (no new messages)"
# Also confirm no ASK or onboard sneaks in (we are decided+enabled+connected).
echo "$GE_CTX" | grep -q "hasn't decided about communication-channel sync" && fail "ASK appeared in decided+connected context" || ok "no spurious ASK when decided+connected+current"
rm -rf "$GE"

# ---- T59: comms slash commands exist, are MCP-driven, env-var-clean ----------
echo
echo "T59 — /mochi:comms-* command files present, well-formed, no unexpanded env vars"
CMDDIR="$PLUGIN_DIR/commands"
for c in comms-setup comms-sync comms-recall comms-import comms-status; do
  [ -f "$CMDDIR/$c.md" ] && ok "$c.md exists" || fail "$c.md missing"
done
# Every comms command must declare the comms MCP tools in allowed-tools (not Bash helpers):
for c in comms-setup comms-sync comms-recall comms-import comms-status; do
  grep -q "mcp__plugin_mochi_comms__" "$CMDDIR/$c.md" && ok "$c references comms MCP tools" || fail "$c does not reference comms MCP tools"
done
# Must NOT use unexpanded plugin-path env vars (same rule T29 enforces repo-wide):
BAD_COMMS=$(grep -lE '\$CLAUDE_PLUGIN_ROOT|CLAUDE_SKILL_DIR' "$CMDDIR"/comms-*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$BAD_COMMS" = "0" ] && ok "comms commands use no unexpanded env vars" || fail "$BAD_COMMS comms command(s) use env vars"
# Each must have YAML frontmatter with a description line:
for c in comms-setup comms-sync comms-recall comms-import comms-status; do
  head -1 "$CMDDIR/$c.md" | grep -qx -- "---" && grep -q "^description:" "$CMDDIR/$c.md" && ok "$c has frontmatter+description" || fail "$c frontmatter malformed"
done

# ---- T60: ordering contract — bootstrap directive precedes comms ASK -----------
# (single-emit, bootstrap-present, and comms-ASK-present are already covered by T57;
#  T60 adds only the positional ordering assertion that T57 does not make.)
echo
echo "T60 — ordering: bootstrap directive appears BEFORE comms ASK in the single context payload"
F60REPO="$(mktemp -d -t continuum-synth-f60.XXXXXX)"
git -C "$F60REPO" init -q
F60_OUT="$(run_hook hooks/session_start.js "{\"session_id\":\"sf60\",\"cwd\":\"$F60REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
F60_CTX="$(echo "$F60_OUT" | extract_ctx)"
# ORDERING: bootstrap must appear BEFORE the comms ASK in the single context string
BPOS60=$(echo "$F60_CTX" | grep -n "No context chain" | head -1 | cut -d: -f1)
APOS60=$(echo "$F60_CTX" | grep -n "hasn't decided about communication-channel sync" | head -1 | cut -d: -f1)
[ -n "$BPOS60" ] && [ -n "$APOS60" ] && [ "$BPOS60" -lt "$APOS60" ] && ok "bootstrap precedes comms ASK (ordering contract)" || fail "ordering wrong: bootstrap=$BPOS60 ask=$APOS60"
rm -rf "$F60REPO"

# ---- Summary -----------------------------------------------------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"
echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

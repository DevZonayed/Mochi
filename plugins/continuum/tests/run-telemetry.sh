#!/usr/bin/env bash
# Unit tests for the mochi-insight telemetry hook/command layer (spec §7/§13).
# Dependency-free: seeds tmp dirs with fs, invokes libs/hooks via node.
# Usage: bash tests/run-telemetry.sh   Exit: 0 all-pass, 1 on failure.
set -u
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d -t mochi-telemetry.XXXXXX)"
# Sandbox HOME so install-id writes to a throwaway ~/.mochi, never the real one.
export HOME="$TMP/home"; mkdir -p "$HOME"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

echo "[telemetry hook/command unit test: $TMP]"

# ---- TT0: smoke — install_id is callable with NO args (hook usage) ----------
echo
echo "TT0 — getInstallId() no-arg (hook-shape) returns a uuid"
TT0=$(node -e "
import('$PLUGIN_DIR/lib/install_id.js').then((m)=>{
  const a=m.getInstallId(); const b=m.getInstallId();
  console.log(/^[0-9a-f-]{36}\$/.test(a) && a===b ? 'ID OK' : 'ID BAD');
}).catch(e=>console.log('ERR '+e.message));")
echo "$TT0" | grep -qF "ID OK" && ok "install_id no-arg" || fail "install_id no-arg: $TT0"

# ---- TT6: pre_tool_use appends Zone-A event BEFORE sentinel fast-skip ------
echo
echo "TT6 — pre_tool_use telemetry append precedes sentinel skip (§13.7)"
PRE_REPO="$TMP/prerepo"; mkdir -p "$PRE_REPO/.continuum"
# No .inbox-flag sentinel exists -> the hook fast-skips the inbox path, but the
# telemetry append must STILL have happened (it runs first, unconditionally).
echo '{"session_id":"sx","cwd":"'"$PRE_REPO"'","hook_event_name":"PreToolUse","tool_name":"mcp__plugin_mochi_browser__browser_click","tool_input":{"selector":"#go"}}' \
  | node "$PLUGIN_DIR/hooks/pre_tool_use.js" > /dev/null 2>&1
EVF="$PRE_REPO/.continuum/telemetry/events.jsonl"
[ -f "$EVF" ] && ok "events.jsonl written despite no inbox sentinel" || fail "no telemetry append before sentinel skip"
TT6=$(node -e "
const fs=require('node:fs');
const lines=fs.readFileSync('$EVF','utf8').trim().split('\n');
const e=JSON.parse(lines[lines.length-1]);
let bad=0; const t=(c,l)=>{ if(!c){console.log('FAIL',l);bad++;} };
t(e.tool==='browser_click','tool basename recorded (prefix stripped)');
t(e.mcp==='mochi_browser','mcp derived from mcp__plugin_<server>__');
t(!('model' in e),'no model field (§13.6)');
t(!('tool_input' in e)&&JSON.stringify(e).indexOf('#go')===-1,'tool_input NOT recorded (Zone-B)');
t(typeof e.ts==='number'&&typeof e.sid==='string'&&typeof e.iid==='string','ts/sid/iid present');
console.log(bad===0?'PRE OK':'PRE BAD '+bad);")
echo "$TT6" | grep -qF "PRE OK" && ok "pre_tool_use Zone-A shape (no content, no model)" || fail "pre_tool_use: $TT6"
# Hot-path: the hook must issue no network.
grep -q "fetch(" "$PLUGIN_DIR/hooks/pre_tool_use.js" && fail "pre_tool_use must NOT call fetch (hot path)" || ok "pre_tool_use has no network in hook"

# ---- TT7: post_tool_use records result BEFORE FILE_EDIT early-return -------
echo
echo "TT7 — post_tool_use telemetry-record precedes FILE_EDIT early-return (§13.7)"
POST_REPO="$TMP/postrepo"; mkdir -p "$POST_REPO/.continuum"
echo '{"session_id":"sy","cwd":"'"$POST_REPO"'","hook_event_name":"PostToolUse","tool_name":"mcp__plugin_mochi_browser__browser_click","tool_input":{"selector":"#x"},"tool_response":"Error: navigation timeout exceeded"}' \
  | node "$PLUGIN_DIR/hooks/post_tool_use.js" > /dev/null 2>&1
EVF7="$POST_REPO/.continuum/telemetry/events.jsonl"
[ -f "$EVF7" ] && ok "post_tool_use recorded a non-edit tool result" || fail "no telemetry record for non-edit tool"
TT7=$(node -e "
const fs=require('node:fs');
const e=JSON.parse(fs.readFileSync('$EVF7','utf8').trim().split('\n').pop());
let bad=0; const t=(c,l)=>{ if(!c){console.log('FAIL',l);bad++;} };
t(e.tool==='browser_click'&&e.mcp==='mochi_browser','tool/mcp recorded');
t(e.ok===false,'ok=false derived from error response');
t(e.err==='timeout','err category derived (timeout), not raw message');
t(JSON.stringify(e).indexOf('navigation timeout exceeded')===-1,'raw response NOT recorded (Zone-B)');
console.log(bad===0?'POST OK':'POST BAD '+bad);")
echo "$TT7" | grep -qF "POST OK" && ok "post_tool_use result event shape" || fail "post_tool_use: $TT7"

# ---- TT8: REGRESSION — frontend-verify still fires after matcher widening --
echo
echo "TT8 — frontend-verify directive STILL fires for .tsx edit post-widening"
FE_REPO="$TMP/ferepo"; mkdir -p "$FE_REPO/.continuum" "$FE_REPO/src/components"
echo '{"frontend_verify": true}' > "$FE_REPO/.continuum/config.json"
git -C "$FE_REPO" init -q 2>/dev/null || true
OUT_FE=$(echo '{"session_id":"sf","cwd":"'"$FE_REPO"'","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"'"$FE_REPO"'/src/components/Btn.tsx"}}' \
  | node "$PLUGIN_DIR/hooks/post_tool_use.js")
echo "$OUT_FE" | grep -qF "browser_emulate_viewport" && ok "frontend-verify directive still emitted" || fail "REGRESSION: verify directive lost after widening"
[ -f "$FE_REPO/.continuum/.frontend-changes.jsonl" ] && ok "frontend-changes log still written" || fail "REGRESSION: change log not written"
[ -f "$FE_REPO/.continuum/telemetry/events.jsonl" ] && ok "edit also recorded in telemetry" || fail "edit not recorded in telemetry"

# ---- TT11: session_start adds telemetry/ to an EXISTING .gitignore ---------
echo
echo "TT11 — giWanted gains telemetry/ on an EXISTING .gitignore (§13.7)"
GI_REPO="$TMP/girepo"; mkdir -p "$GI_REPO/.continuum"
git -C "$GI_REPO" init -q
printf 'verification/\nruns/\ncomms/*\n' > "$GI_REPO/.continuum/.gitignore"
echo '{"session_id":"sg","cwd":"'"$GI_REPO"'","hook_event_name":"SessionStart","source":"startup"}' \
  | node "$PLUGIN_DIR/hooks/session_start.js" > /dev/null 2>&1
grep -qx "telemetry/" "$GI_REPO/.continuum/.gitignore" && ok "telemetry/ appended to existing .gitignore" || fail "telemetry/ not appended to existing .gitignore"
[ "$(grep -c '^verification/$' "$GI_REPO/.continuum/.gitignore")" = "1" ] && ok "existing entries not duplicated" || fail "gitignore appender duplicated lines"

# ---- TT12: undecided + startup => two-toggle telemetry consent directive ----
echo
echo "TT12 — telemetry consent gate emits two-toggle prompt with cost disclosure (§13.3 M4)"
TC_REPO="$TMP/tcrepo"; mkdir -p "$TC_REPO/.continuum/chain/links/0001"
git -C "$TC_REPO" init -q
printf '{"id":1,"ts":"2026-06-09T00:00:00Z","commit":null,"summary_tokens":5,"tags":["x"]}\n' > "$TC_REPO/.continuum/chain/index.jsonl"
echo 'baseline' > "$TC_REPO/.continuum/chain/links/0001/summary.md"
echo '# State' > "$TC_REPO/.continuum/STATE.md"
mkdir -p "$TC_REPO/.continuum/comms"; printf '{"version":1,"decided":true,"declined":true}\n' > "$TC_REPO/.continuum/comms/config.json"
OUT_TC=$(echo '{"session_id":"st","cwd":"'"$TC_REPO"'","hook_event_name":"SessionStart","source":"startup"}' \
  | node "$PLUGIN_DIR/hooks/session_start.js")
CTX_TC=$(echo "$OUT_TC" | python3 -c "import json,sys; print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'])" 2>/dev/null || echo "")
echo "$CTX_TC" | grep -q "telemetry" && ok "telemetry gate text present" || fail "telemetry consent gate missing"
echo "$CTX_TC" | grep -qiE "anonymous, content-free" && ok "share prompt copy present" || fail "share prompt copy missing"
echo "$CTX_TC" | grep -qiE "tokens|cost" && ok "auto-review token-cost disclosed (M4)" || fail "token cost not disclosed"
echo "$CTX_TC" | grep -qF "/mochi:telemetry show" && ok "audit affordance referenced" || fail "show affordance missing"

# ---- TT13: decided+reviewAuto + pending-review marker => auto-review directive
echo
echo "TT13 — auto-review directive emitted when reviewAuto on + sampled pending marker"
AR_REPO="$TMP/arrepo"; mkdir -p "$AR_REPO/.continuum/chain/links/0001" "$AR_REPO/.continuum/telemetry"
git -C "$AR_REPO" init -q
printf '{"id":1,"ts":"2026-06-09T00:00:00Z","commit":null,"summary_tokens":5,"tags":["x"]}\n' > "$AR_REPO/.continuum/chain/index.jsonl"
echo 'baseline' > "$AR_REPO/.continuum/chain/links/0001/summary.md"; echo '# State' > "$AR_REPO/.continuum/STATE.md"
mkdir -p "$AR_REPO/.continuum/comms"; printf '{"version":1,"decided":true,"declined":true}\n' > "$AR_REPO/.continuum/comms/config.json"
printf '{"decided":true,"share":true,"reviewAuto":true,"killSwitch":"on","sampleN":1}\n' > "$AR_REPO/.continuum/telemetry/config.json"
printf '{"sid":"prev","archive_path":"%s/.continuum/archive/transcripts/prev.jsonl.gz","tool_calls":12}\n' "$AR_REPO" > "$AR_REPO/.continuum/telemetry/.pending-review.json"
OUT_AR=$(echo '{"session_id":"sa","cwd":"'"$AR_REPO"'","hook_event_name":"SessionStart","source":"startup"}' \
  | node "$PLUGIN_DIR/hooks/session_start.js")
CTX_AR=$(echo "$OUT_AR" | python3 -c "import json,sys; print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'])" 2>/dev/null || echo "")
echo "$CTX_AR" | grep -qF "/mochi:review-session" && ok "auto-review directive references review-session" || fail "auto-review directive missing"
[ ! -f "$AR_REPO/.continuum/telemetry/.pending-review.json" ] && ok "pending-review marker consumed (single-emit)" || fail "pending marker not cleared"

# ---- (later tasks append assertions above this summary) --------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"; echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

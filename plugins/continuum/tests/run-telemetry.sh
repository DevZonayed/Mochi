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

# ---- (later tasks append assertions above this summary) --------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"; echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

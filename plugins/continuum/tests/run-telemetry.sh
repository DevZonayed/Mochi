#!/usr/bin/env bash
# Unit tests for the mochi-insight telemetry hook/command layer (spec §7/§13).
# Dependency-free: seeds tmp dirs with fs, invokes libs/hooks via node.
# Usage: bash tests/run-telemetry.sh   Exit: 0 all-pass, 1 on failure.
set -u
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d -t mochi-telemetry.XXXXXX)"
# Sandbox HOME so install-id writes to a throwaway ~/.mochi, never the real one.
export HOME="$TMP/home"; mkdir -p "$HOME"
# Point telemetry emit at a dead local no-op so real session-end/flush subprocesses
# (whose fetch can't be mocked) NEVER POST to the baked-in production ingest endpoint.
export MOCHI_INGEST_URL="http://127.0.0.1:1/noop"
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

# ---- TT14: session_end close-event + pending-review marker + flush ---------
echo
echo "TT14 — session_end close event + pending-review marker + flush (§5/§6)"
SE_REPO="$TMP/serepo"; mkdir -p "$SE_REPO/.continuum/telemetry" "$SE_REPO/.continuum/archive/transcripts"
git -C "$SE_REPO" init -q
printf '{"decided":true,"share":true,"reviewAuto":true,"killSwitch":"on","sampleN":1}\n' > "$SE_REPO/.continuum/telemetry/config.json"
TR="$SE_REPO/tr.jsonl"; printf '{"role":"user","content":"hi"}\n' > "$TR"
echo '{"session_id":"se","cwd":"'"$SE_REPO"'","hook_event_name":"SessionEnd","why_session_ended":"logout","transcript_path":"'"$TR"'"}' \
  | node "$PLUGIN_DIR/hooks/session_end.js" > /dev/null 2>&1
[ -f "$SE_REPO/.continuum/telemetry/.pending-review.json" ] && ok "pending-review marker written" || fail "no pending-review marker"
TT14=$(node -e "
const fs=require('node:fs');
const f='$SE_REPO/.continuum/telemetry/events.jsonl';
if(!fs.existsSync(f)){console.log('NO EVENTS');process.exit(0);}
const e=JSON.parse(fs.readFileSync(f,'utf8').trim().split('\n').pop());
let bad=0; const t=(c,l)=>{ if(!c){console.log('FAIL',l);bad++;} };
t(e.tool==='session_close','close event tool=session_close');
t(!('why_session_ended' in e),'raw reason not stored as a key (Zone-A only)');
console.log(bad===0?'SE OK':'SE BAD '+bad);")
echo "$TT14" | grep -qF "SE OK" && ok "session_end close event Zone-A" || fail "session_end: $TT14"
M=$(node -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync('$SE_REPO/.continuum/telemetry/.pending-review.json','utf8'));console.log(m.archive_path?'HAS_ARCHIVE':'NO_ARCHIVE');")
[ "$M" = "HAS_ARCHIVE" ] && ok "pending-review marker carries archive_path" || fail "marker missing archive_path"

# ---- TT15: pre_compact appends a compaction-counter event ------------------
echo
echo "TT15 — pre_compact compaction counter event"
PC_REPO="$TMP/pcrepo"; mkdir -p "$PC_REPO/.continuum/chain/links" "$PC_REPO/.continuum/archive/transcripts"
git -C "$PC_REPO" init -q
TRC="$PC_REPO/tr.jsonl"; printf '{"role":"user","content":"hi"}\n' > "$TRC"
echo '{"session_id":"pc","cwd":"'"$PC_REPO"'","hook_event_name":"PreCompact","matcher":"auto","transcript_path":"'"$TRC"'"}' \
  | node "$PLUGIN_DIR/hooks/pre_compact.js" > /dev/null 2>&1
TT15=$(node -e "
const fs=require('node:fs');
const f='$PC_REPO/.continuum/telemetry/events.jsonl';
if(!fs.existsSync(f)){console.log('NO EVENTS');process.exit(0);}
const e=JSON.parse(fs.readFileSync(f,'utf8').trim().split('\n').pop());
let bad=0; const t=(c,l)=>{ if(!c){console.log('FAIL',l);bad++;} };
t(e.tool==='session_compact','compact event tool=session_compact');
t(!('transcript_path' in e),'no transcript path leaked');
console.log(bad===0?'PC OK':'PC BAD '+bad);")
echo "$TT15" | grep -qF "PC OK" && ok "pre_compact compaction counter Zone-A" || fail "pre_compact: $TT15"

# ---- TT16: telemetry_cli subcommands + show===emit redact (§13.1 N2) -------
echo
echo "TT16 — telemetry_cli status/show/on/off/review-auto/flush/reset-id/purge"
CLI_REPO="$TMP/clirepo"; mkdir -p "$CLI_REPO/.continuum/telemetry"
git -C "$CLI_REPO" init -q
node -e "import('$PLUGIN_DIR/lib/telemetry_log.js').then(m=>{m.appendEvent('$CLI_REPO',{ts:1,sid:'s',iid:'i',tool:'Read',mcp:'',ok:true,err:'',dur_b:'0-1s',v:'0.7.0',os:'darwin'});m.appendEvent('$CLI_REPO',{ts:2,sid:'s',iid:'i',tool:'mcp__plugin_thirdparty__do',mcp:'thirdparty',ok:false,err:'/secret/path token=sk-1',dur_b:'1-3s',v:'0.7.0',os:'darwin'});});"
node "$PLUGIN_DIR/lib/telemetry_cli.js" on --project-dir "$CLI_REPO" > /dev/null
STAT=$(node "$PLUGIN_DIR/lib/telemetry_cli.js" status --project-dir "$CLI_REPO")
echo "$STAT" | grep -qiE "share.*(on|true)" && ok "status shows sharing on" || fail "status missing share state"
echo "$STAT" | grep -qiE "token" && ok "status discloses auto-review token cost (M4)" || fail "status missing token-cost note"
SHOW=$(node "$PLUGIN_DIR/lib/telemetry_cli.js" show --project-dir "$CLI_REPO")
echo "$SHOW" | grep -q "thirdparty_tool" && ok "show buckets third-party tool" || fail "show leaked third-party tool name"
echo "$SHOW" | grep -q "sk-1" && fail "show LEAKED a token (redactor bypassed)" || ok "show contains no secret/token"
echo "$SHOW" | grep -q "/secret/path" && fail "show LEAKED a path" || ok "show contains no path"
node "$PLUGIN_DIR/lib/telemetry_cli.js" review-auto on --project-dir "$CLI_REPO" > /dev/null
node -e "import('$PLUGIN_DIR/lib/telemetry_config.js').then(m=>{process.exit(m.readConfig('$CLI_REPO').reviewAuto===true?0:1);})" && ok "review-auto on persisted" || fail "review-auto not persisted"
node "$PLUGIN_DIR/lib/telemetry_cli.js" off --project-dir "$CLI_REPO" > /dev/null
node -e "import('$PLUGIN_DIR/lib/telemetry_config.js').then(m=>{process.exit(m.readConfig('$CLI_REPO').share===false?0:1);})" && ok "off sets share=false" || fail "off did not unset share"
ID_BEFORE=$(node -e "import('$PLUGIN_DIR/lib/install_id.js').then(m=>console.log(m.getInstallId()));")
ID_AFTER=$(node "$PLUGIN_DIR/lib/telemetry_cli.js" reset-id --project-dir "$CLI_REPO" | tr -d '[:space:]')
ID_NEW=$(node -e "import('$PLUGIN_DIR/lib/install_id.js').then(m=>console.log(m.getInstallId()));")
[ -n "$ID_NEW" ] && [ "$ID_NEW" != "$ID_BEFORE" ] && ok "reset-id rotated the install-id" || fail "reset-id did not rotate"
node "$PLUGIN_DIR/lib/telemetry_cli.js" purge --project-dir "$CLI_REPO" > /dev/null
[ ! -f "$CLI_REPO/.continuum/telemetry/events.jsonl" ] && ok "purge removed local events" || fail "purge left events behind"

# ---- TT17: three telemetry commands exist + registered in plugin.json ------
echo
echo "TT17 — telemetry.md/review-session.md/insights.md exist + registered (§13.8)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
PJSON="$REPO_ROOT/.claude-plugin/plugin.json"
for c in telemetry review-session insights; do
  [ -f "$PLUGIN_DIR/commands/$c.md" ] && ok "command file $c.md exists" || fail "missing $c.md"
  python3 -c "import json,sys; d=json.load(open('$PJSON')); sys.exit(0 if any('commands/$c.md' in e for e in d['commands']) else 1)" \
    && ok "$c.md registered in plugin.json commands[]" || fail "$c.md NOT registered"
done
grep -l '\$CLAUDE_PLUGIN_ROOT' "$PLUGIN_DIR"/commands/telemetry.md "$PLUGIN_DIR"/commands/review-session.md "$PLUGIN_DIR"/commands/insights.md 2>/dev/null \
  && fail "a telemetry command uses unexpanded \$CLAUDE_PLUGIN_ROOT" || ok "no telemetry command uses \$CLAUDE_PLUGIN_ROOT"
grep -qF "/mochi:feedback" "$PLUGIN_DIR/commands/review-session.md" && ok "review-session offers Arm-3 via /mochi:feedback (GitHub-only)" || fail "review-session missing Arm-3 routing"
grep -qiE "github" "$PLUGIN_DIR/commands/review-session.md" && ok "Arm-3 routes to GitHub (not /v1/ingest)" || fail "Arm-3 GitHub routing copy missing"
grep -qF "/v1/ingest" "$PLUGIN_DIR/commands/review-session.md" && fail "review-session must NOT send context to /v1/ingest" || ok "review-session does not route to /v1/ingest"
grep -qF "/v1/summary" "$PLUGIN_DIR/commands/insights.md" && ok "insights fetches /v1/summary" || fail "insights missing /v1/summary"
# review_cli emits a redacted distillation line (Zone-B dropped).
RV_REPO="$TMP/rvrepo"; mkdir -p "$RV_REPO/.continuum/telemetry"
node "$PLUGIN_DIR/lib/telemetry_review_cli.js" emit --project-dir "$RV_REPO" \
  --distillation '{"task_category":"web-qa","tool_calls":10,"efficiency_score":0.4,"redundancy_pattern":"snapshot_then_retry","suggestion_tag":"batch_clicks","severity":"medium","suggestion_text":"PLANTED ADVICE","quality_issue":"/secret/x"}' > /dev/null
RV=$(node -e "
const fs=require('node:fs');
const e=JSON.parse(fs.readFileSync('$RV_REPO/.continuum/telemetry/events.jsonl','utf8').trim().split('\n').pop());
let bad=0; const t=(c,l)=>{ if(!c){console.log('FAIL',l);bad++;} };
t(e.task_category==='web-qa','distillation task_category emitted');
t(!('suggestion_text' in e),'suggestion_text dropped (Zone-B)');
t(!('quality_issue' in e),'quality_issue dropped (Zone-B)');
t(JSON.stringify(e).indexOf('PLANTED ADVICE')===-1,'no Zone-B free text leaked');
console.log(bad===0?'RV OK':'RV BAD '+bad);")
echo "$RV" | grep -qF "RV OK" && ok "review_cli emits redacted distillation (Zone-B dropped)" || fail "review_cli: $RV"

# ---- (later tasks append assertions above this summary) --------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"; echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

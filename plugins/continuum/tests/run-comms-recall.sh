#!/usr/bin/env bash
# Unit tests for lib/comms_recall.js — stemmed-token search over per-chat
# messages.jsonl shards. Honors §10 hit shape + §4.3 caps + allowlist scope.
# Dependency-free: seeds .continuum/comms with fs, invokes the lib via node.
#
# Usage: bash tests/run-comms-recall.sh
# Exit:  0 on all-pass, 1 on first failure.

set -u
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d -t comms-recall.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

REPO="$TMP/repo"
mkdir -p "$REPO/.continuum/comms"

# config.json: two allowlisted chats under whatsapp/work
ALLOWED_GROUP="123-456@g.us"
ALLOWED_DM="19999999999@s.whatsapp.net"
DENIED="18880000000@s.whatsapp.net"
cat > "$REPO/.continuum/comms/config.json" <<EOF
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
          "allowed_jids": ["$ALLOWED_GROUP", "$ALLOWED_DM"]
        }
      }
    }
  }
}
EOF

# Helper: write one messages.jsonl line into a chat shard
STORE="$REPO/.continuum/comms/store/whatsapp/work"
seed_msg() { # $1=chatId $2=msgId $3=ts $4=tsIso $5=senderName $6=senderId $7=text
  local dir="$STORE/$1"
  mkdir -p "$dir"
  printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"%s","fingerprint":"fp:%s","fromMe":false,"senderId":"%s","senderName":"%s","ts":%s,"tsIso":"%s","kind":"text","text":"%s","media":null,"reply_to":null,"source":"live"}\n' \
    "$1" "$2" "$2" "$6" "$5" "$3" "$4" "$7" >> "$dir/messages.jsonl"
}

# Allowed group: 3 messages, one strongly about "deploy"
seed_msg "$ALLOWED_GROUP" "G1" 1717700000 "2026-06-06T18:13:20Z" "Alice" "$ALLOWED_DM" "lunch plans for friday"
seed_msg "$ALLOWED_GROUP" "G2" 1717700600 "2026-06-06T18:23:20Z" "Bob"   "$ALLOWED_DM" "we should deploy the deploy script after the deploy window"
seed_msg "$ALLOWED_GROUP" "G3" 1717800000 "2026-06-07T22:00:00Z" "Alice" "$ALLOWED_DM" "deploy is done"
# Allowed DM: one message about postgres
seed_msg "$ALLOWED_DM" "D1" 1717700100 "2026-06-06T18:15:00Z" "Carol" "$ALLOWED_DM" "migrating to postgres 16 next sprint"
# DENIED chat: a deploy message that must NEVER surface
mkdir -p "$STORE/$DENIED"
printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"X1","fingerprint":"fp:X1","fromMe":false,"senderId":"%s","senderName":"Mallory","ts":1717700200,"tsIso":"2026-06-06T18:16:40Z","kind":"text","text":"secret deploy in the denied chat","media":null,"reply_to":null,"source":"live"}\n' \
  "$DENIED" "$DENIED" >> "$STORE/$DENIED/messages.jsonl"

CALL() { # invoke commsRecall with a JSON opts arg, print JSON result
  node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  const opts = JSON.parse(process.argv[1]);
  const r = commsRecall('$REPO', opts);
  console.log(JSON.stringify(r));
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
" "$1"
}

echo "[comms recall unit test: $REPO]"
echo

# ---- C1: query 'deploy' top hit is G2 (highest TF) -------------------------
echo "C1 — recall 'deploy' ranks the multi-mention message first"
R1=$(CALL '{"query":"deploy"}')
TOPID=$(echo "$R1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
[ "$TOPID" = "G2" ] && ok "top hit msgId == G2" || { fail "expected G2 got $TOPID"; echo "  $R1"; }

# ---- C2: §10 hit shape — chatId, tsIso, senderName, excerpt, msgId ---------
echo
echo "C2 — each hit carries chatId, tsIso, senderName, excerpt, msgId"
SHAPE=$(echo "$R1" | python3 -c "
import json,sys
d=json.load(sys.stdin); h=d['hits'][0]
need=['chatId','tsIso','senderName','excerpt','msgId']
miss=[k for k in need if k not in h or h[k] in (None,'')]
print('OK' if not miss else 'MISS:'+','.join(miss))
")
[ "$SHAPE" = "OK" ] && ok "hit shape complete per §10" || fail "hit shape: $SHAPE"

# ---- C3: allowlist scope — denied chat never surfaces ----------------------
echo
echo "C3 — a 'deploy' message in a non-allowlisted chat is never returned"
ANY_DENIED=$(echo "$R1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('FOUND' if any(h['chatId']=='$DENIED' or h['msgId']=='X1' for h in d['hits']) else 'CLEAN')
")
[ "$ANY_DENIED" = "CLEAN" ] && ok "denied chat excluded from results" || fail "LEAK: denied chat surfaced"

# ---- C4: default limit is 10, hard max clamp is 200 ------------------------
echo
echo "C4 — over-limit request clamped to 200 (§4.3)"
CLAMP=$(CALL '{"query":"deploy","limit":99999}' | python3 -c "import json,sys; print(json.load(sys.stdin)['limit'])")
[ "$CLAMP" = "200" ] && ok "limit 99999 clamped to 200" || fail "expected clamp to 200 got $CLAMP"
DEF=$(CALL '{"query":"deploy"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['limit'])")
[ "$DEF" = "10" ] && ok "default limit is 10" || fail "expected default 10 got $DEF"

# ---- C5: chatId filter restricts to one chat -------------------------------
echo
echo "C5 — chatId filter scopes results to that chat only"
R5=$(CALL "{\"query\":\"postgres\",\"chatId\":\"$ALLOWED_DM\"}")
PGID=$(echo "$R5" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
PGN=$(echo "$R5" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$PGID" = "D1" ] && [ "$PGN" = "1" ] && ok "postgres → D1 in the DM only" || fail "expected D1/1 got $PGID/$PGN"

# ---- C6: since/until window filters by ts ----------------------------------
echo
echo "C6 — since/until filter messages by epoch ts"
# Only G3 (ts 1717800000) is after 1717750000
R6=$(CALL '{"query":"deploy","since":1717750000}')
N6=$(echo "$R6" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
TOP6=$(echo "$R6" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
[ "$N6" = "1" ] && [ "$TOP6" = "G3" ] && ok "since filter keeps only G3" || fail "expected 1/G3 got $N6/$TOP6"
# until: only messages with ts <= 1717750000 survive; G3 (ts 1717800000) is excluded.
# G1 (ts 1717700000) is about "lunch" so it won't match "deploy"; only G2 matches.
R6B=$(CALL '{"query":"deploy","until":1717750000}')
N6B=$(echo "$R6B" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
TOP6B=$(echo "$R6B" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['hits'][0]['msgId'] if d['hits'] else 'none')")
UNTIL_HAS_G3=$(echo "$R6B" | python3 -c "import json,sys; print('YES' if any(h['msgId']=='G3' for h in json.load(sys.stdin)['hits']) else 'NO')")
[ "$N6B" = "1" ] && [ "$TOP6B" = "G2" ] && [ "$UNTIL_HAS_G3" = "NO" ] && ok "until filter keeps G2, excludes G3" || fail "expected 1/G2/no-G3 got $N6B/$TOP6B/G3=$UNTIL_HAS_G3"

# ---- C7: no-match query returns empty hits, no crash -----------------------
echo
echo "C7 — non-matching query returns hitCount 0"
R7=$(CALL '{"query":"kubernetes"}')
N7=$(echo "$R7" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$N7" = "0" ] && ok "no match → 0 hits, no error" || fail "expected 0 got $N7"

# ---- C8: provider filter scopes results to that provider only --------------
echo
echo "C8 — provider filter restricts to that provider"
# whatsapp provider has deploy messages; a non-existent provider returns 0 hits
R8=$(CALL '{"query":"deploy","provider":"whatsapp"}')
N8=$(echo "$R8" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$N8" -ge 1 ] && ok "provider=whatsapp returns hits (got $N8)" || fail "expected >=1 hits for provider=whatsapp got $N8"
R8B=$(CALL '{"query":"deploy","provider":"telegram"}')
N8B=$(echo "$R8B" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$N8B" = "0" ] && ok "provider=telegram (no such provider) returns 0 hits" || fail "expected 0 hits for unknown provider got $N8B"

# ---- C9: accountId filter scopes results to that account only --------------
echo
echo "C9 — accountId filter restricts to that account"
# 'work' account has deploy messages; an unknown account returns 0 hits
R9=$(CALL '{"query":"deploy","accountId":"work"}')
N9=$(echo "$R9" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$N9" -ge 1 ] && ok "accountId=work returns hits (got $N9)" || fail "expected >=1 hits for accountId=work got $N9"
R9B=$(CALL '{"query":"deploy","accountId":"personal"}')
N9B=$(echo "$R9B" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$N9B" = "0" ] && ok "accountId=personal (no such account) returns 0 hits" || fail "expected 0 hits for unknown accountId got $N9B"

# ---- C10: missing/empty query throws with 'query required' -----------------
echo
echo "C10 — missing or empty query throws"
ERR_EMPTY=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  try { commsRecall('$REPO', { query: '' }); console.log('NO_THROW'); }
  catch(e) { console.log(e.message.includes('query required') ? 'THREW_OK' : 'THREW_WRONG:' + e.message); }
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
")
[ "$ERR_EMPTY" = "THREW_OK" ] && ok "empty query throws 'query required'" || fail "expected THREW_OK got $ERR_EMPTY"
ERR_MISSING=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  try { commsRecall('$REPO', {}); console.log('NO_THROW'); }
  catch(e) { console.log(e.message.includes('query required') ? 'THREW_OK' : 'THREW_WRONG:' + e.message); }
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
")
[ "$ERR_MISSING" = "THREW_OK" ] && ok "missing query throws 'query required'" || fail "expected THREW_OK got $ERR_MISSING"

# ---- C11: duplicate/equivalent allowlist entries do not inflate hits --------
# A device-suffixed variant ('19999999999:12@s.whatsapp.net') alongside the
# base JID ('19999999999@s.whatsapp.net') both normalize to the same chatId.
# Without dedup, the shard would be scanned twice and hitCount would be 2 for
# a single stored message. The same applies to verbatim duplicate entries.
echo
echo "C11 — duplicate/equivalent allowlist entries don't inflate hitCount"
# Build a temporary repo with a config that lists the DM JID twice:
# once as its base form and once with a device suffix (both normalize identically).
DUP_REPO="$(mktemp -d -t comms-recall-dup.XXXXXX)"
mkdir -p "$DUP_REPO/.continuum/comms/store/whatsapp/work/$ALLOWED_DM"
cat > "$DUP_REPO/.continuum/comms/config.json" <<DUPEOF
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
          "allowed_jids": ["$ALLOWED_DM", "19999999999:12@s.whatsapp.net"]
        }
      }
    }
  }
}
DUPEOF
# Seed exactly ONE message in the shard.
printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"DUP1","fingerprint":"fp:DUP1","fromMe":false,"senderId":"%s","senderName":"Carol","ts":1717700100,"tsIso":"2026-06-06T18:15:00Z","kind":"text","text":"postgres migration","media":null,"reply_to":null,"source":"live"}\n' \
  "$ALLOWED_DM" "$ALLOWED_DM" >> "$DUP_REPO/.continuum/comms/store/whatsapp/work/$ALLOWED_DM/messages.jsonl"

DUP_CALL() {
  node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  const opts = JSON.parse(process.argv[1]);
  const r = commsRecall('$DUP_REPO', opts);
  console.log(JSON.stringify(r));
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
" "$1"
}

# (a) device-suffix variant: two allowlist entries that normalize to the same JID
R11A=$(DUP_CALL '{"query":"postgres"}')
HC11A=$(echo "$R11A" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$HC11A" = "1" ] && ok "device-suffix dup in allowlist: hitCount==1 (not inflated)" || { fail "expected hitCount 1 got $HC11A (shard scanned twice)"; echo "  $R11A"; }

# (b) verbatim duplicate: same JID listed twice in allowed_jids
DUP2_REPO="$(mktemp -d -t comms-recall-dup2.XXXXXX)"
mkdir -p "$DUP2_REPO/.continuum/comms/store/whatsapp/work/$ALLOWED_DM"
cat > "$DUP2_REPO/.continuum/comms/config.json" <<DUP2EOF
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
          "allowed_jids": ["$ALLOWED_DM", "$ALLOWED_DM"]
        }
      }
    }
  }
}
DUP2EOF
printf '{"provider":"whatsapp","accountId":"work","chatId":"%s","msgId":"DUP2","fingerprint":"fp:DUP2","fromMe":false,"senderId":"%s","senderName":"Carol","ts":1717700100,"tsIso":"2026-06-06T18:15:00Z","kind":"text","text":"postgres migration","media":null,"reply_to":null,"source":"live"}\n' \
  "$ALLOWED_DM" "$ALLOWED_DM" >> "$DUP2_REPO/.continuum/comms/store/whatsapp/work/$ALLOWED_DM/messages.jsonl"

R11B=$(node -e "
import('$PLUGIN_DIR/lib/comms_recall.js').then(({commsRecall}) => {
  const r = commsRecall('$DUP2_REPO', {query:'postgres'});
  console.log(JSON.stringify(r));
}).catch((e) => { console.log('ERR:' + e.message); process.exit(1); });
")
HC11B=$(echo "$R11B" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$HC11B" = "1" ] && ok "verbatim-duplicate JID in allowlist: hitCount==1 (not inflated)" || { fail "expected hitCount 1 got $HC11B (shard scanned twice)"; echo "  $R11B"; }

rm -rf "$DUP_REPO" "$DUP2_REPO"

# ---- Summary ---------------------------------------------------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"
echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

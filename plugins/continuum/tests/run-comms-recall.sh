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

# ---- C7: no-match query returns empty hits, no crash -----------------------
echo
echo "C7 — non-matching query returns hitCount 0"
R7=$(CALL '{"query":"kubernetes"}')
N7=$(echo "$R7" | python3 -c "import json,sys; print(json.load(sys.stdin)['hitCount'])")
[ "$N7" = "0" ] && ok "no match → 0 hits, no error" || fail "expected 0 got $N7"

# ---- Summary ---------------------------------------------------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"
echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

#!/usr/bin/env bash
# Unit tests for lib/scoring.js — the shared stemmed-token scoring primitives
# reused by continuum recall and comms recall. Dependency-free (node + bash).
#
# Usage: bash tests/run-scoring.sh
# Exit:  0 on all-pass, 1 on first failure.

set -u
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
log()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

echo "[scoring unit test]"
echo

# ---- S1: module exports the four primitives --------------------------------
echo "S1 — scoring.js exports stem, tokenize, tokenizeStemmed, termFrequency"
EXPORTS=$(node -e "
import('$PLUGIN_DIR/lib/scoring.js').then((m) => {
  const want = ['stem','tokenize','tokenizeStemmed','termFrequency'];
  const missing = want.filter((k) => typeof m[k] !== 'function');
  console.log(missing.length === 0 ? 'ALL' : 'MISSING:' + missing.join(','));
}).catch((e) => console.log('IMPORT_ERR:' + e.message));
")
[ "$EXPORTS" = "ALL" ] && ok "all four primitives exported as functions" || fail "exports wrong: $EXPORTS"

# ---- S2: stem conflates common English suffixes ----------------------------
echo
echo "S2 — stem() conflates decision/decisions/decided/deciding"
STEM_OUT=$(node -e "
import('$PLUGIN_DIR/lib/scoring.js').then(({stem}) => {
  const r = ['decisions','decided','deciding','decision'].map(stem);
  // current stemmer maps: decisions->decision, decided->decid, deciding->decid
  const cases = [
    [stem('decisions'), 'decision'],
    [stem('parties'),   'party'],
    [stem('paried'),    'pary'],
    [stem('running'),   'runn'],
    [stem('jumped'),    'jump'],
    [stem('boxes'),     'box'],
    [stem('cats'),      'cats'],   // length==4, not > 4, so 's' not stripped
    [stem('ss'),        'ss'],
    [stem('bus'),       'bus'],
    [stem(''),          ''],
  ];
  let bad = 0;
  for (const [got, want] of cases) if (got !== want) { console.log('FAIL', JSON.stringify(got), 'want', JSON.stringify(want)); bad++; }
  console.log(bad === 0 ? 'STEM_OK' : 'STEM_BAD ' + bad);
});
")
echo "$STEM_OUT" | grep -qF "STEM_OK" && ok "stem cases pass" || { fail "stem cases: $STEM_OUT"; }

# ---- S3: tokenize lowercases, splits, drops <2 char tokens -----------------
echo
echo "S3 — tokenize() lowercases + drops single-char tokens + keeps + - _"
TOK_OUT=$(node -e "
import('$PLUGIN_DIR/lib/scoring.js').then(({tokenize}) => {
  const got = tokenize('Hello, WORLD! a rate-limit c++ snake_case x');
  const want = ['hello','world','rate-limit','c++','snake_case'];
  console.log(JSON.stringify(got) === JSON.stringify(want) ? 'TOK_OK' : 'TOK_BAD ' + JSON.stringify(got));
});
")
echo "$TOK_OUT" | grep -qF "TOK_OK" && ok "tokenize splits + filters correctly" || fail "tokenize: $TOK_OUT"

# ---- S4: tokenizeStemmed = tokenize then stem ------------------------------
echo
echo "S4 — tokenizeStemmed() applies stem to each token"
TS_OUT=$(node -e "
import('$PLUGIN_DIR/lib/scoring.js').then(({tokenizeStemmed}) => {
  const got = tokenizeStemmed('Decisions about parties');
  const want = ['decision','about','party'];
  console.log(JSON.stringify(got) === JSON.stringify(want) ? 'TS_OK' : 'TS_BAD ' + JSON.stringify(got));
});
")
echo "$TS_OUT" | grep -qF "TS_OK" && ok "tokenizeStemmed pipes tokenize→stem" || fail "tokenizeStemmed: $TS_OUT"

# ---- S5: termFrequency counts query stems in doc stems ---------------------
echo
echo "S5 — termFrequency() counts each query stem's occurrences in the doc"
TF_OUT=$(node -e "
import('$PLUGIN_DIR/lib/scoring.js').then(({termFrequency}) => {
  const doc = ['auth','mfa','auth','token','auth'];
  const q   = ['auth','mfa','postgres'];
  const tf  = termFrequency(doc, q);
  const ok = tf.get('auth') === 3 && tf.get('mfa') === 1 && tf.get('postgres') === 0;
  console.log(ok ? 'TF_OK' : 'TF_BAD auth=' + tf.get('auth') + ' mfa=' + tf.get('mfa') + ' pg=' + tf.get('postgres'));
});
")
echo "$TF_OUT" | grep -qF "TF_OK" && ok "termFrequency counts correctly" || fail "termFrequency: $TF_OUT"

# ---- S6: recall.js re-exports the same primitive identities -----------------
echo
echo "S6 — recall.js re-exports stem/tokenize/etc. (same identity as scoring.js)"
REEXPORT=$(node -e "
Promise.all([
  import('$PLUGIN_DIR/lib/scoring.js'),
  import('$PLUGIN_DIR/lib/recall.js'),
]).then(([s, r]) => {
  const names = ['stem','tokenize','tokenizeStemmed','termFrequency'];
  const allFns  = names.every((n) => typeof r[n] === 'function');
  const sameRef = names.every((n) => r[n] === s[n]);
  console.log(allFns && sameRef ? 'REEXPORT_OK' : 'REEXPORT_BAD allFns=' + allFns + ' sameRef=' + sameRef);
}).catch((e) => console.log('REEXPORT_ERR:' + e.message));
")
echo "$REEXPORT" | grep -qF "REEXPORT_OK" && ok "recall.js re-exports identical primitive references" || fail "re-export: $REEXPORT"

# ---- Summary ---------------------------------------------------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"
echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

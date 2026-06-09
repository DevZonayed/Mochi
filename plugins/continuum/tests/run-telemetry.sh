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

# ---- (later tasks append assertions above this summary) --------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"; echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

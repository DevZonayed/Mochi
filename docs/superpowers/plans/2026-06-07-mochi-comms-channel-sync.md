# Mochi Comms Channel Sync — Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox dash-bracket syntax for tracking.

Goal: Ship mochi's own zero-install, channel-strict, per-repo communication-channel sync and recall (WhatsApp first via Baileys) as a third bundled MCP server.

Architecture: A new bundled comms MCP server (Baileys behind a channel-agnostic provider interface) captures allowlisted messages into a per-repo file store under .continuum/comms, deduped and recallable on demand; an init-gate in session_start.js drives plug-and-play onboarding. Pure-JS data layer first, then the MCP+provider, then continuum integration.

Tech Stack: Node 22+ ESM, esbuild bundling, @whiskeysockets/baileys@6.7.23, qrcode, @modelcontextprotocol/sdk, dependency-free synthetic tests.

Spec: docs/superpowers/specs/2026-06-07-mochi-comms-channel-sync-design.md

## Shared Contracts (authoritative — used identically everywhere)

These names are fixed across all phases. Where a draft diverged, it has been reconciled to the value below.

- **Msg shape** (the normalized record appended to the store):
  `{ provider, accountId, chatId, msgId, fingerprint, fromMe, senderId, senderName, ts, tsIso, kind, text, media, reply_to, source }`
  where `ts` is epoch seconds (number), `source ∈ "live"|"backfill"|"import"`, `media` is `null` or `{ mimetype, fileName, sizeBytes }`.
- **Data-layer function names:** `appendMessage`, `getSlice`, `listChats`, `readCursor`, `writeCursor` (comms_store); `fingerprint`, `reconcileImport` (comms_dedupe); `readConfig`, `writeConfig`, `declineConfig` (comms_config); `normalizeJid`, `isAllowed`, `assertAllowed` (comms_allowlist); `readState`, `readSeen`, `accountStatuses`, `setAccountStatus`, `setSeen` (comms_state); `commsRecall` (comms_recall).
- **Scoring primitives** live in **`plugins/continuum/lib/scoring.js`** (single source of truth): `stem`, `tokenize`, `tokenizeStemmed`, `termFrequency`. `recall.js` imports and re-exports them; `comms_recall.js` imports them. (Phase 1's earlier "export-in-place from recall.js" approach was superseded by this extraction.)
- **Path helper names** (all in `plugins/continuum/lib/paths.js`, all take an explicit `projectDir`, never `process.cwd()`): `commsDir`, `commsConfigPath`, `commsLocalConfigPath`, `commsStatePath`, `commsSeenPath`, `commsAuthDir(projectDir, provider, accountId)`, `commsChatDir(projectDir, provider, accountId, chatId)`, `commsMessagesPath`, `commsCursorPath`, `commsMetaPath`, `commsIndexPath`.
  - `commsIndexPath` resolves to **`.continuum/comms/index.jsonl`** (reconciled from Phase 1's `store/index.json` to Phase 5's `index.jsonl`).
- **Project-dir resolution (§3.1):** comms MCP resolves write target as `args.project_dir → COMMS_PROJECT_DIR env`; never cwd. Missing both → throw.
- **Caps (§4.3):** `getSlice` default limit 20 / hard max 200; `commsRecall` default limit 10 / hard max 200; both clamp (never honor) over-limit requests.
- **MCP tool namespace:** comms slash commands call `mcp__plugin_mochi_comms__*` tools.

## File Structure

Every file created or modified across all phases, with its one-line responsibility.

**Pure-JS data + recall layer (`plugins/continuum/lib/`):**
- `paths.js` — *modified*: add comms path helpers (`commsDir`/`commsConfigPath`/`commsLocalConfigPath`/`commsStatePath`/`commsSeenPath`/`commsAuthDir`/`commsChatDir`/`commsMessagesPath`/`commsCursorPath`/`commsMetaPath`/`commsIndexPath`).
- `comms_config.js` — *new*: per-repo config read (local-over-committed merge + defaults), atomic write, decline shape.
- `comms_allowlist.js` — *new*: `normalizeJid` (incl. @lid stub), strict `isAllowed`, group-grant semantics, `assertAllowed`.
- `comms_dedupe.js` — *new*: symmetric cross-source `fingerprint` (no ordinal) + greedy 1:1 `reconcileImport`.
- `comms_store.js` — *new*: append-only file store — `readCursor`/`writeCursor`, `appendMessage` (two-tier dedupe + live-wins), `getSlice` (read-time sort + caps + continuation), `listChats` (allowlist-filtered).
- `scoring.js` — *new*: shared stemmed-token scoring primitives (`stem`/`tokenize`/`tokenizeStemmed`/`termFrequency`) extracted verbatim from `recall.js`.
- `recall.js` — *modified*: import + re-export scoring primitives from `scoring.js` (behavior unchanged).
- `comms_recall.js` — *new*: allowlist-scoped, capped, stemmed-token search over per-chat shards (`commsRecall`).
- `comms_state.js` — *new*: `state.json` + watermark read/write helpers for the fs-only hook (`readState`/`readSeen`/`accountStatuses`/`setAccountStatus`/`setSeen`).

**Comms MCP server + WhatsApp provider (`server/src/comms/`):**
- `normalize.js` — *new*: WhatsApp WAMessage → normalized Msg (wrappers, Long ts, group participant, reply_to, media classify).
- `provider.js` — *new*: `CommsProvider` interface + `ProviderRegistry` (per-provider singleton, name dispatch).
- `whatsapp.js` — *new*: WhatsAppProvider — pino-free console-logger shim, single-writer lockfile, capture pipeline, link (QR/pairing-once), connection.update routing + close-reason reconnect; baileys/qrcode imported lazily.
- `index.js` — *new*: comms MCP stdio server — §10 tool defs, env→arg projectDir resolution, registry dispatch, eager reconnect, `buildServer`/`main`.

**Server tests (`server/`):**
- `_comms_normalize.test.mjs` — *new*: normalize unit tests.
- `_comms_provider.test.mjs` — *new*: provider/registry unit tests.
- `_comms_wa_lock.test.mjs` — *new*: logger + lockfile unit tests.
- `_comms_wa_capture.test.mjs` — *new*: capture pipeline against a mock socket.
- `_comms_wa_lifecycle.test.mjs` — *new*: QR/pairing/connection.update/close lifecycle.
- `_comms_server.test.mjs` — *new*: MCP tool layer + projectDir resolution.
- `_comms_smoke.mjs` — *new*: stdio boot smoke (initialize + tools/list against `src/`).
- `_comms_build_config.test.mjs` — *new*: assert build scripts + pinned deps + forbidden-deps-absent.
- `_comms_mcp_entry.test.mjs` — *new*: assert `.mcp.json` comms entry shape.
- `_comms_ci_verify.test.mjs` — *new*: assert CI verifies the comms bundle.
- `_comms_bundle_smoke.test.mjs` — *new*: gating §12 — build, boot under bare node, list tools, assert pure-JS baileys subtree.

**Build / packaging / CI:**
- `server/package.json` — *modified*: split `build` into `build:browser`/`build:comms`, add baileys@6.7.23 + qrcode deps, gate all comms tests in `test`.
- `server/package-lock.json` — *modified*: lock the new deps.
- `.mcp.json` — *modified*: register the `comms` stdio MCP server with `COMMS_PROJECT_DIR`.
- `.github/workflows/build.yml` — *modified*: verify step asserts `server/dist/comms.bundle.mjs`.
- `server/dist/comms.bundle.mjs` (+ `.LEGAL.txt`) — *new (built artifact)*: bundled comms server, committed.

**Continuum integration (`plugins/continuum/`):**
- `hooks/session_start.js` — *modified*: single terminal `emitContextOnce` (bootstrap appends, no early exit); idempotent `.gitignore` appender (`comms/*` + `!comms/config.json`); source-aware `commsGate` (ASK/ONBOARD/freshness).
- `commands/comms-setup.md` — *new*: agent-driven channel onboarding (QR/pairing → pick chats → allowlist).
- `commands/comms-sync.md` — *new*: force a connect + backfill pass.
- `commands/comms-recall.md` — *new*: keyword search returning scored snippets.
- `commands/comms-import.md` — *new*: back-fill from a WhatsApp "Export chat" .txt.
- `commands/comms-status.md` — *new*: link status + allowlisted chats + counts.

**Tests (shared dependency-free harness, `plugins/continuum/tests/`):**
- `run-synthetic.sh` — *modified*: append comms unit + hook tests (paths, config, allowlist, dedupe, store, state, gitignore, emit refactor, gate, commands, reachability).
- `run-scoring.sh` — *new*: scoring-primitive unit tests + recall re-export check.
- `run-comms-recall.sh` — *new*: comms recall scoring/shape/caps/allowlist/window tests.

> **Test-numbering note.** Both Phase 1 and Phase 5 drafts introduced overlapping `T35+` numbers in `run-synthetic.sh` because each was authored against the original (un-extended) harness. In this assembled plan the data-layer suite (Phase 1) lands first as **T35–T43** (paths, config, allowlist, dedupe-fp, dedupe-reconcile, store-cursor, store-append, store-getSlice, store-listChats), and the integration suite (Phase 5) appends **after** it as **T44–T51** (state, gitignore, single-emit, gate, commands, first-session reachability). The Phase 1 "scoring exports from recall.js" test (its old T44) is removed — scoring now lives in `scoring.js` and is covered by `run-scoring.sh`. Implementers MUST append each new block immediately before the `# ---- Summary` separator, in task order, and use the next free `T<NN>` number rather than the literal number printed in a draft.

## Phase 1 — Pure-JS, dependency-free comms data layer (no Baileys, no MCP)

All tasks add to `plugins/continuum/lib/` and are unit-tested through the existing dependency-free harness `plugins/continuum/tests/run-synthetic.sh` (bash `ok`/`fail` helpers; ESM modules exercised via `node -e "import('…').then(…)"`, the T22 style). Run the whole suite with `bash plugins/continuum/tests/run-synthetic.sh`. Paths in this phase are relative to the repo root `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney`.

---

### Task 1: Comms path helpers (extend paths.js)

**Files:**
- Modify: `plugins/continuum/lib/paths.js` (append new exports after `estimateTokens`, currently ends at line 117)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append a new `T35` block before the `# ---- Summary` block at line 503)

- [ ] Step 1: Write the failing test. Open `plugins/continuum/tests/run-synthetic.sh` and insert this block immediately before the `# ---- Summary` separator at line 503:
```bash
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
```

> Contract reconciliation: `commsIndexPath` resolves to `.continuum/comms/index.jsonl` (Phase 5's value), NOT the Phase 1 draft's `store/index.json`.

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T35"`. Expected failure: `✗ comms paths: ... PATHS BAD 11` (every helper is `undefined`, so `got` is `undefined` for all 11 — prints `PATH FAIL got undefined want …` ×11 then `PATHS BAD 11`).

- [ ] Step 3: Write minimal implementation. Append to `plugins/continuum/lib/paths.js` (after line 117, the end of `estimateTokens`):
```javascript

// ---------------------------------------------------------------------------
// Comms (per-repo communication-channel sync) path helpers. All persistence
// lives under .continuum/comms/ (resolved per spec §3.1 from an explicit
// projectDir — never process.cwd()). config.json is COMMITTED; everything
// else under comms/ is gitignored (auth, store, state, watermark, local cfg).
// ---------------------------------------------------------------------------
export function commsDir(projectDir) {
  return path.join(continuumRoot(projectDir), "comms");
}
export function commsConfigPath(projectDir) {
  return path.join(commsDir(projectDir), "config.json");
}
export function commsLocalConfigPath(projectDir) {
  return path.join(commsDir(projectDir), "config.local.json");
}
export function commsStatePath(projectDir) {
  return path.join(commsDir(projectDir), "state.json");
}
export function commsSeenPath(projectDir) {
  return path.join(commsDir(projectDir), ".last-session-seen.json");
}
export function commsIndexPath(projectDir) {
  return path.join(commsDir(projectDir), "index.jsonl");
}
export function commsAuthDir(projectDir, provider, accountId) {
  return path.join(commsDir(projectDir), provider, accountId, "auth");
}
export function commsChatDir(projectDir, provider, accountId, chatId) {
  return path.join(commsDir(projectDir), "store", provider, accountId, chatId);
}
export function commsMessagesPath(projectDir, provider, accountId, chatId) {
  return path.join(commsChatDir(projectDir, provider, accountId, chatId), "messages.jsonl");
}
export function commsCursorPath(projectDir, provider, accountId, chatId) {
  return path.join(commsChatDir(projectDir, provider, accountId, chatId), "cursor.json");
}
export function commsMetaPath(projectDir, provider, accountId, chatId) {
  return path.join(commsChatDir(projectDir, provider, accountId, chatId), "meta.json");
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T35"`. Expected PASS: `✓ comms path helpers resolve correctly`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/paths.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): path helpers under .continuum/comms (paths.js)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: comms_config.js — read/merge local-over-committed + defaults + decline shape + atomic write

**Files:**
- Create: `plugins/continuum/lib/comms_config.js`
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T36` after the `T35` block)

- [ ] Step 1: Write the failing test. Insert after the `T35` block in `run-synthetic.sh`:
```bash
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

    console.log(bad === 0 ? 'CONFIG OK' : 'CONFIG BAD ' + bad);
  });
});
")
echo "$T36_OUT" | grep -qF "CONFIG OK" && ok "comms_config merge/defaults/decline/atomic" || { fail "comms_config: $T36_OUT"; }
rm -rf "$CFG_REPO"
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T36"`. Expected failure: `✗ comms_config: ... Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../lib/comms_config.js'`.

- [ ] Step 3: Write minimal implementation. Create `plugins/continuum/lib/comms_config.js`:
```javascript
// Per-repo comms intent + allowlist config. config.json is COMMITTED (no
// secrets); config.local.json is a gitignored per-user override that wins on
// merge (spec §6.1/§6.2). All reads are fault-tolerant: a missing or malformed
// file degrades to defaults rather than throwing — the init hook reads this
// fs-only and must never crash a session start.

import fs from "node:fs";
import path from "node:path";
import { commsConfigPath, commsLocalConfigPath, commsDir } from "./paths.js";

const DEFAULTS = { version: 1, decided: false, declined: false, providers: {} };

function readJsonOr(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

// readConfig: committed config.json with config.local.json merged OVER it
// (local wins, top-level shallow merge), then defaults filled for any missing
// key. `version` always defaults to 1 so older/short configs still parse.
// `providers` prefers local, else committed, else {} (deep-prefer per §6.2).
export function readConfig(projectDir) {
  const committed = readJsonOr(commsConfigPath(projectDir), {});
  const local = readJsonOr(commsLocalConfigPath(projectDir), {});
  return {
    ...DEFAULTS,
    ...committed,
    ...local,
    providers: local.providers ?? committed.providers ?? {},
  };
}

// writeConfig: atomic write of config.json (write tmp + rename — rename is
// atomic on the same filesystem, mirroring the append-only/safe-write ethos of
// archive.js). Never writes config.local.json (that's the user's to manage).
export function writeConfig(projectDir, cfg) {
  const dir = commsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = commsConfigPath(projectDir);
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, dest);
  return dest;
}

// The exact shape written when a user declines comms for this repo (spec §6.1).
export function declineConfig() {
  return { version: 1, decided: true, declined: true };
}
```

> Contract reconciliation: this single `comms_config.js` is canonical (Phase 5's duplicate creation of the same module is dropped — see Phase 5 note). It combines Phase 1's `declineConfig` + atomic-write contract with Phase 5's `providers` deep-prefer merge.

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T36"`. Expected PASS: `✓ comms_config merge/defaults/decline/atomic`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_config.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): config read/merge (local-over-committed) + atomic write

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: comms_allowlist.js — normalizeJid (incl. @lid stub), isAllowed, group-grant semantics, assertAllowed

**Files:**
- Create: `plugins/continuum/lib/comms_allowlist.js`
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T37` after the `T36` block)

- [ ] Step 1: Write the failing test. Insert after the `T36` block in `run-synthetic.sh`:
```bash
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

  console.log(bad === 0 ? 'ALLOW OK' : 'ALLOW BAD ' + bad);
});
")
echo "$T37_OUT" | grep -qF "ALLOW OK" && ok "comms_allowlist normalize/isAllowed/group-grant" || { fail "comms_allowlist: $T37_OUT"; }
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T37"`. Expected failure: `✗ comms_allowlist: ... Cannot find module '.../lib/comms_allowlist.js'`.

- [ ] Step 3: Write minimal implementation. Create `plugins/continuum/lib/comms_allowlist.js`:
```javascript
// Channel-strict access decisions (spec §6.4). Two structural guarantees:
//   - Capture side: a message whose normalized chatId isn't allowlisted is
//     dropped BEFORE write (the store never persists non-allowlisted chats).
//   - Read side: list/get/recall only ever return allowlisted chats.
// normalizeJid canonicalizes a JID so one identity isn't stored/checked twice.
// In v1 the @lid <-> phone-JID mapping is a STUB (real mapping is provider-side
// via jidNormalizedUser, Phase 2): @lid is only lowercased/trimmed here.

// Strip a WhatsApp device/agent suffix (":NN") from the user part, lowercase
// the domain, trim. "19999999999:12@s.whatsapp.net" -> "19999999999@s.whatsapp.net".
export function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  let s = jid.trim().toLowerCase();
  if (!s) return "";
  const at = s.indexOf("@");
  if (at === -1) return s;
  let user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const colon = user.indexOf(":");
  if (colon !== -1) user = user.slice(0, colon);
  return `${user}@${domain}`;
}

function accountAllowed(cfg, provider, accountId) {
  const acct = cfg?.providers?.[provider]?.accounts?.[accountId];
  if (!acct || !Array.isArray(acct.allowed_jids)) return new Set();
  return new Set(acct.allowed_jids.map(normalizeJid));
}

// isAllowed: strict membership of the normalized jid in this account's
// allowed_jids. Allowing a @g.us grants ONLY that group chat (its chatId);
// a member's 1:1 DM still needs that member's own JID listed (§6.4 m5).
export function isAllowed(cfg, provider, accountId, jid) {
  const allowed = accountAllowed(cfg, provider, accountId);
  if (allowed.size === 0) return false;
  return allowed.has(normalizeJid(jid));
}

// assertAllowed: returns the normalized jid if allowed, else throws. Used on
// the write path so a non-allowlisted message can never be appended.
export function assertAllowed(cfg, provider, accountId, jid) {
  const norm = normalizeJid(jid);
  if (!isAllowed(cfg, provider, accountId, jid)) {
    throw new Error(`comms_allowlist: ${provider}/${accountId} not allowed: ${norm || "(empty jid)"}`);
  }
  return norm;
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T37"`. Expected PASS: `✓ comms_allowlist normalize/isAllowed/group-grant`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_allowlist.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): strict allowlist (normalizeJid + isAllowed + group-grant)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: comms_dedupe.js — symmetric fingerprint (no ordinal)

**Files:**
- Create: `plugins/continuum/lib/comms_dedupe.js` (fingerprint only this task; `reconcileImport` added in Task 5)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T38` after the `T37` block)

- [ ] Step 1: Write the failing test. Insert after the `T37` block in `run-synthetic.sh`:
```bash
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

  // media path: text empty, fingerprint uses media.mediaKey when present
  const med = { chatId:'c@g.us', ts:1717700000, senderId:'19999999999@s.whatsapp.net', text:'', media:{ mediaKey:'KEY1' }, source:'live', msgId:'x' };
  const med2 = { ...med, source:'import', msgId:'import:y' };
  eq(m.fingerprint(med), m.fingerprint(med2), 'media-key-symmetric');
  ne(m.fingerprint(med), fp, 'media-vs-text-differ');

  console.log(bad === 0 ? 'FP OK' : 'FP BAD ' + bad);
});
")
echo "$T38_OUT" | grep -qF "FP OK" && ok "comms_dedupe fingerprint symmetric + no-ordinal" || { fail "comms_dedupe fp: $T38_OUT"; }
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T38"`. Expected failure: `✗ comms_dedupe fp: ... Cannot find module '.../lib/comms_dedupe.js'`.

- [ ] Step 3: Write minimal implementation. Create `plugins/continuum/lib/comms_dedupe.js`:
```javascript
// Two-tier dedupe primitives (spec §4.2). Tier 1 (within-source identity by
// (provider,accountId,chatId,msgId)) is enforced in comms_store. This module
// owns the cross-source identity: a CANONICAL, SYMMETRIC fingerprint so a live
// record and an imported record of the same content+minute+sender collide —
// and the greedy 1:1 reconciliation that resolves intra-minute collisions
// without silent loss.

import crypto from "node:crypto";
import { normalizeJid } from "./comms_allowlist.js";

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// fingerprint = "fp:" + sha1( chatId | floor(ts/60) | normalizedSenderId |
//   sha1(text || media.mediaKey || "") ). NO ordinal, NO msgId, NO source —
// so it is identical across live/backfill/import (symmetric by construction).
export function fingerprint(msg) {
  const minute = Math.floor((Number(msg.ts) || 0) / 60);
  const sender = normalizeJid(msg.senderId || "");
  const content = (msg.text && msg.text.length)
    ? msg.text
    : (msg.media && msg.media.mediaKey ? msg.media.mediaKey : "");
  const body = sha1(content);
  return "fp:" + sha1(`${msg.chatId || ""}|${minute}|${sender}|${body}`);
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T38"`. Expected PASS: `✓ comms_dedupe fingerprint symmetric + no-ordinal`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_dedupe.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): symmetric cross-source fingerprint (no ordinal, §4.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: comms_dedupe.js — reconcileImport greedy 1:1 matching + intra-minute ordinal

**Files:**
- Modify: `plugins/continuum/lib/comms_dedupe.js` (add `reconcileImport`)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T39` after the `T38` block)

- [ ] Step 1: Write the failing test. Insert after the `T38` block in `run-synthetic.sh`:
```bash
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

  console.log(bad === 0 ? 'RECON OK' : 'RECON BAD ' + bad);
});
")
echo "$T39_OUT" | grep -qF "RECON OK" && ok "comms_dedupe reconcileImport greedy 1:1 + ordinal" || { fail "comms_dedupe reconcile: $T39_OUT"; }
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T39"`. Expected failure: `✗ comms_dedupe reconcile: ... TypeError: m.reconcileImport is not a function`.

- [ ] Step 3: Write minimal implementation. Append to `plugins/continuum/lib/comms_dedupe.js`:
```javascript

// reconcileImport(existing, imports) -> { merged, added }.
// Greedy, time-ordered 1:1 matching per (chatId, minute, normalizedSenderId,
// text) bucket (spec §4.2). Within a bucket each existing live/backfill record
// is consumed at most once; import lines beyond the existing count (N>M) become
// NEW records. The ordinal-within-minute (position among same-minute import
// lines in this bucket) is folded into the synthetic msgId ONLY — never into
// fp — so new same-minute import records stay unique among themselves. live/
// backfill win over import on any 1:1 match.
export function reconcileImport(existingMsgs, importMsgs) {
  const existing = Array.isArray(existingMsgs) ? existingMsgs : [];
  const imports = Array.isArray(importMsgs) ? importMsgs : [];

  const bucketKey = (msg) => {
    const minute = Math.floor((Number(msg.ts) || 0) / 60);
    const sender = normalizeJid(msg.senderId || "");
    const content = (msg.text && msg.text.length)
      ? msg.text
      : (msg.media && msg.media.mediaKey ? msg.media.mediaKey : "");
    return `${msg.chatId || ""}|${minute}|${sender}|${content}`;
  };

  // Count existing capacity per bucket (records the import can match against).
  const capacity = new Map();
  for (const e of existing) {
    const k = bucketKey(e);
    capacity.set(k, (capacity.get(k) || 0) + 1);
  }

  // Walk imports in export-line order (input order is the ordinal source).
  const seenInBucket = new Map(); // bucket -> ordinal counter (0-based)
  const added = [];
  for (const raw of imports) {
    const k = bucketKey(raw);
    const ordinal = seenInBucket.get(k) || 0;
    seenInBucket.set(k, ordinal + 1);

    const cap = capacity.get(k) || 0;
    if (ordinal < cap) continue; // matched a live/backfill record — live wins

    // Unmatched (N>M): mint a NEW import record. Ordinal lives in msgId only.
    const sender = normalizeJid(raw.senderId || "");
    const msgId = "import:" + sha1(`${raw.chatId || ""}|${raw.ts}|${ordinal}|${sender}|${raw.text || ""}`);
    const rec = { ...raw, msgId, source: "import" };
    added.push(rec);
  }

  return { merged: existing.concat(added), added };
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T39"`. Expected PASS: `✓ comms_dedupe reconcileImport greedy 1:1 + ordinal`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_dedupe.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): reconcileImport greedy 1:1 + intra-minute ordinal (§4.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: comms_store.js — readCursor/writeCursor (atomic)

**Files:**
- Create: `plugins/continuum/lib/comms_store.js` (cursor I/O this task; append/getSlice/listChats follow)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T40` after the `T39` block)

- [ ] Step 1: Write the failing test. Insert after the `T39` block in `run-synthetic.sh`:
```bash
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
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T40"`. Expected failure: `✗ comms_store cursor: ... Cannot find module '.../lib/comms_store.js'`.

- [ ] Step 3: Write minimal implementation. Create `plugins/continuum/lib/comms_store.js`:
```javascript
// File-based, append-only message store (spec §4). One messages.jsonl per chat;
// order is reconstructed at READ time by sorting on ts (live/backfill/import
// are all pure appends — the append-only contract is never violated by mid-file
// insertion). cursor.json holds the per-chat newest/oldest watermark + count.
// HARD efficiency caps (§4.3) are enforced server-side in getSlice, independent
// of caller input.

import fs from "node:fs";
import path from "node:path";
import {
  commsChatDir,
  commsMessagesPath,
  commsCursorPath,
} from "./paths.js";

const CURSOR_DEFAULT = { newestId: null, newestTs: 0, oldestId: null, oldestTs: 0, count: 0 };

function atomicWrite(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// readCursor: cursor.json or a zeroed default. Never throws.
export function readCursor(projectDir, provider, accountId, chatId) {
  const f = commsCursorPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(f)) return { ...CURSOR_DEFAULT };
  try { return { ...CURSOR_DEFAULT, ...JSON.parse(fs.readFileSync(f, "utf8")) }; }
  catch { return { ...CURSOR_DEFAULT }; }
}

// writeCursor: atomic cursor.json write.
export function writeCursor(projectDir, provider, accountId, chatId, cursor) {
  const f = commsCursorPath(projectDir, provider, accountId, chatId);
  atomicWrite(f, JSON.stringify(cursor, null, 2) + "\n");
  return f;
}

// internal: read all message records for a chat (append-only jsonl).
function readAllMessages(projectDir, provider, accountId, chatId) {
  const f = commsMessagesPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// exported so later tasks (append/getSlice) and tests can share it.
export { readAllMessages, atomicWrite, commsChatDir };
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T40"`. Expected PASS: `✓ comms_store cursor read/write`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_store.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): store cursor read/write (atomic) skeleton

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: comms_store.js — appendMessage (append-only + cursor update + two-tier dedupe + live-wins)

**Files:**
- Modify: `plugins/continuum/lib/comms_store.js` (add `appendMessage`)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T41` after the `T40` block)

- [ ] Step 1: Write the failing test. Insert after the `T40` block in `run-synthetic.sh`:
```bash
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
    const imp = withFp({ ...base, msgId:'import:zzz', ts:1717700040, text:'hi', source:'import' });
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

    console.log(bad === 0 ? 'APPEND OK' : 'APPEND BAD ' + bad);
  });
});
")
echo "$T41_OUT" | grep -qF "APPEND OK" && ok "comms_store appendMessage dedupe + cursor + live-wins" || { fail "comms_store append: $T41_OUT"; }
rm -rf "$APP_REPO"
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T41"`. Expected failure: `✗ comms_store append: ... TypeError: m.appendMessage is not a function`.

- [ ] Step 3: Write minimal implementation. Append to `plugins/continuum/lib/comms_store.js`:
```javascript

import { fingerprint } from "./comms_dedupe.js";

// appendMessage: append-only insert with TWO-TIER dedupe (spec §4.2) and cursor
// maintenance. Idempotent on (provider,accountId,chatId,msgId) [tier 1] and on
// fingerprint [tier 2]; on a tier-2 fingerprint collision, a live/backfill
// record WINS over an import dup (the import is dropped). Returns
// { appended:boolean, reason? }.
export function appendMessage(projectDir, msg) {
  const { provider, accountId, chatId } = msg;
  const fp = msg.fingerprint || fingerprint(msg);
  const existing = readAllMessages(projectDir, provider, accountId, chatId);

  // Tier 1: within-source identity by msgId.
  for (const e of existing) {
    if (e.msgId === msg.msgId) {
      return { appended: false, reason: "duplicate-msgid" };
    }
  }
  // Tier 2: cross-source identity by fingerprint. live/backfill win over import.
  for (const e of existing) {
    if (e.fingerprint === fp) {
      const existingIsReal = e.source === "live" || e.source === "backfill";
      const incomingIsImport = msg.source === "import";
      if (existingIsReal && incomingIsImport) {
        return { appended: false, reason: "duplicate-fingerprint-live-wins" };
      }
      // otherwise treat as the same logical message already stored
      return { appended: false, reason: "duplicate-fingerprint" };
    }
  }

  const record = { ...msg, fingerprint: fp };
  const file = commsMessagesPath(projectDir, provider, accountId, chatId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");

  // Update cursor from the full set (cheap; allowlist keeps volume bounded).
  const all = existing.concat([record]);
  let newest = all[0], oldest = all[0];
  for (const r of all) {
    if ((r.ts || 0) >= (newest.ts || 0)) newest = r;
    if ((r.ts || 0) <= (oldest.ts || 0)) oldest = r;
  }
  writeCursor(projectDir, provider, accountId, chatId, {
    newestId: newest.msgId, newestTs: newest.ts || 0,
    oldestId: oldest.msgId, oldestTs: oldest.ts || 0,
    count: all.length,
  });

  return { appended: true };
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T41"`. Expected PASS: `✓ comms_store appendMessage dedupe + cursor + live-wins`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_store.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): appendMessage append-only + two-tier dedupe + live-wins

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: comms_store.js — getSlice (read-time ts-desc sort + HARD limit clamp + byte budget + continuation)

**Files:**
- Modify: `plugins/continuum/lib/comms_store.js` (add `getSlice`)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T42` after the `T41` block)

- [ ] Step 1: Write the failing test. Insert after the `T41` block in `run-synthetic.sh`:
```bash
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

    // HARD max clamp: ask for 9999 -> clamped to 200 (only 50 exist here)
    const big = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'c@g.us', limit:9999 });
    eq(big.limitApplied, 200, 'hard-clamp-200');
    eq(big.messages.length, 50, 'returns-all-50-under-cap');

    // byte budget: a tiny budget truncates and hands back a continuation cursor
    const tiny = m.getSlice(d, { provider:'whatsapp', accountId:'work', chatId:'c@g.us', limit:200, byteBudget:300 });
    eq(tiny.messages.length < 50, true, 'byte-budget-truncates');
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
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T42"`. Expected failure: `✗ comms_store slice: ... TypeError: m.getSlice is not a function`.

- [ ] Step 3: Write minimal implementation. Append to `plugins/continuum/lib/comms_store.js`:
```javascript

import { estimateTokens } from "./paths.js";

const DEFAULT_LIMIT = 20;
const HARD_MAX_LIMIT = 200;     // §4.3 — over-limit requests are CLAMPED, not honored
const DEFAULT_BYTE_BUDGET = 16 * 1024; // ~16 KB per response (§4.3)

// getSlice: latest-N (or windowed) read of a chat. Order is reconstructed at
// READ time by ts DESC (newest-first) by default. Caps are server-side
// invariants: limit defaults to 20, is HARD-clamped to 200, and the response
// is truncated to a byte budget with a `continuation` cursor for the next page.
// `continuation` is an opaque "before this ts/msgId" cursor (we encode ts:msgId).
export function getSlice(projectDir, opts) {
  const { provider, accountId, chatId } = opts;
  const limitApplied = Math.min(
    HARD_MAX_LIMIT,
    Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT
  );
  const byteBudget = Number.isFinite(opts.byteBudget) && opts.byteBudget > 0
    ? opts.byteBudget : DEFAULT_BYTE_BUDGET;

  let all = readAllMessages(projectDir, provider, accountId, chatId);
  // newest-first by ts; msgId is a stable tiebreaker for equal ts.
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(b.msgId).localeCompare(String(a.msgId)));

  // continuation: resume strictly older than the encoded cursor.
  if (typeof opts.continuation === "string" && opts.continuation.includes(":")) {
    const sep = opts.continuation.indexOf(":");
    const curTs = Number(opts.continuation.slice(0, sep));
    const curId = opts.continuation.slice(sep + 1);
    all = all.filter((m) =>
      (m.ts || 0) < curTs || ((m.ts || 0) === curTs && String(m.msgId).localeCompare(curId) < 0)
    );
  }

  const out = [];
  let bytes = 0;
  let continuation = null;
  for (const m of all) {
    if (out.length >= limitApplied) {
      continuation = `${out[out.length - 1].ts}:${out[out.length - 1].msgId}`;
      break;
    }
    const sz = estimateTokens(JSON.stringify(m)) * 4; // estimateTokens ≈ chars/4
    if (out.length > 0 && bytes + sz > byteBudget) {
      continuation = `${out[out.length - 1].ts}:${out[out.length - 1].msgId}`;
      break;
    }
    out.push(m);
    bytes += sz;
  }

  return { messages: out, limitApplied, continuation };
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T42"`. Expected PASS: `✓ comms_store getSlice sort/clamp/byte-budget/continuation`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_store.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): getSlice read-time sort + HARD caps + byte-budget continuation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: comms_store.js — listChats (allowlist-filtered, from store dirs + meta + cursor)

**Files:**
- Modify: `plugins/continuum/lib/comms_store.js` (add `listChats`)
- Test: `plugins/continuum/tests/run-synthetic.sh` (append `T43` after the `T42` block)

- [ ] Step 1: Write the failing test. Insert after the `T42` block in `run-synthetic.sh`:
```bash
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

      // two chats stored: one allowlisted ('c@g.us'), one not ('x@g.us')
      m.appendMessage(d, mk('c@g.us', 1000, 'hi'));
      m.appendMessage(d, mk('c@g.us', 1100, 'yo'));
      m.appendMessage(d, mk('x@g.us', 1200, 'secret'));
      // give the allowed chat a meta.json (name + chatKind)
      fs.writeFileSync(P.commsMetaPath(d,'whatsapp','work','c@g.us'),
        JSON.stringify({ name:'Team', chatKind:'group', updatedAt:1100 }));

      // allowedJids structural filter: only c@g.us is returned
      const allowed = ['123@s.whatsapp.net','c@g.us'].map(s=>s); // includes c@g.us
      const chats = m.listChats(d, allowed);
      eq(chats.length, 1, 'only-allowlisted-chat-returned');
      eq(chats[0].chatId, 'c@g.us', 'chat-id');
      eq(chats[0].name, 'Team', 'name-from-meta');
      eq(chats[0].chatKind, 'group', 'chatKind-from-meta');
      eq(chats[0].count, 2, 'count-from-cursor');
      eq(chats[0].newestTs, 1100, 'newestTs-from-cursor');

      // null allowedJids -> nothing leaks (strict-by-default)
      eq(m.listChats(d, null).length, 0, 'null-allowed-returns-none');

      console.log(bad === 0 ? 'LIST OK' : 'LIST BAD ' + bad);
    });
  });
});
")
echo "$T43_OUT" | grep -qF "LIST OK" && ok "comms_store listChats allowlist-filtered" || { fail "comms_store listChats: $T43_OUT"; }
rm -rf "$LC_REPO"
```

- [ ] Step 2: Run test to verify it fails. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T43"`. Expected failure: `✗ comms_store listChats: ... TypeError: m.listChats is not a function`.

- [ ] Step 3: Write minimal implementation. Append to `plugins/continuum/lib/comms_store.js`. Add the import at the top of the new block (it needs `normalizeJid`, `commsMetaPath`, `commsDir`):
```javascript

import { normalizeJid } from "./comms_allowlist.js";
import { commsMetaPath, commsDir } from "./paths.js";

function readMetaSafe(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

// listChats: enumerate stored chats across all providers/accounts under
// store/, returning ONLY those whose chatId is in allowedJids (read-side
// structural guarantee, §6.4). Each entry merges meta.json (name, chatKind)
// and cursor.json (count, newest/oldest watermarks). A null/empty allowlist
// returns nothing — strict by default.
export function listChats(projectDir, allowedJids) {
  if (!Array.isArray(allowedJids) || allowedJids.length === 0) return [];
  const allowed = new Set(allowedJids.map(normalizeJid));

  const storeRoot = path.join(commsDir(projectDir), "store");
  if (!fs.existsSync(storeRoot)) return [];

  const out = [];
  for (const provider of fs.readdirSync(storeRoot)) {
    const provDir = path.join(storeRoot, provider);
    if (!fs.statSync(provDir).isDirectory()) continue;
    for (const accountId of fs.readdirSync(provDir)) {
      const acctDir = path.join(provDir, accountId);
      if (!fs.statSync(acctDir).isDirectory()) continue;
      for (const chatId of fs.readdirSync(acctDir)) {
        const chatDir = path.join(acctDir, chatId);
        if (!fs.statSync(chatDir).isDirectory()) continue;
        if (!allowed.has(normalizeJid(chatId))) continue; // structural filter
        const meta = readMetaSafe(commsMetaPath(projectDir, provider, accountId, chatId));
        const cursor = readCursor(projectDir, provider, accountId, chatId);
        out.push({
          provider, accountId, chatId,
          name: meta.name ?? null,
          chatKind: meta.chatKind ?? null,
          count: cursor.count,
          newestTs: cursor.newestTs,
          oldestTs: cursor.oldestTs,
        });
      }
    }
  }
  out.sort((a, b) => (b.newestTs || 0) - (a.newestTs || 0));
  return out;
}
```

- [ ] Step 4: Run test to verify it passes. Command: `bash plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T43"`. Expected PASS: `✓ comms_store listChats allowlist-filtered`.

- [ ] Step 5: Commit. Commands:
```bash
git add plugins/continuum/lib/comms_store.js plugins/continuum/tests/run-synthetic.sh
git commit -m "feat(comms): listChats allowlist-filtered (meta + cursor merge)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Phase 1 completion gate

- [ ] Run the full suite once more and confirm zero regressions: `bash plugins/continuum/tests/run-synthetic.sh; echo "exit=$?"`. Expected: all tests through T43 show `✓`, the summary prints `failed: 0`, and `exit=0`. New comms tests added this phase: **T35–T43** (paths, config, allowlist, dedupe-fp, dedupe-reconcile, store-cursor, store-append, store-getSlice, store-listChats). No Baileys, no MCP, no new npm deps were introduced — every module is pure-JS using only `node:fs`/`node:path`/`node:crypto`. (The scoring extraction + recall rewire is Phase 2.)

## Phase 2 — Scoring refactor + comms recall

The scoring primitives (`stem`, `tokenize`, `tokenizeStemmed`, `termFrequency`) are currently module-private in `recall.js`. This phase extracts them to a standalone `lib/scoring.js` (single source of truth), rewires `recall.js` to import + re-export them (behavior unchanged), and builds `comms_recall.js` on top. Tests are dependency-free bash + node (+ python3 for JSON assertions), in new harnesses `tests/run-scoring.sh` and `tests/run-comms-recall.sh`; the existing `run-synthetic.sh` recall tests (T13-T17, T27, T34) are the behavior-preservation gate.

---

### Task 10: Extract scoring primitives into `lib/scoring.js`

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/scoring.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh`

Move `stem`, `tokenize`, `tokenizeStemmed`, `termFrequency` out of `recall.js` into a standalone, dependency-free ESM module that can be imported by both `recall.js` and the new `comms_recall.js`. This task only creates the new module and its unit test; `recall.js` is rewired in Task 11 (so existing recall tests stay green throughout).

- [ ] **Step 1: Write the failing test.** Create `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh`. It mirrors the existing dependency-free harness (bash + inline node + counters):

```bash
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
    [stem('cats'),      'cat'],
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

# ---- Summary ---------------------------------------------------------------
echo
echo "─────────────────────────────"
echo "passed: $PASS"
echo "failed: $FAIL"
echo "─────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh`
  Expected failure: S1 prints `IMPORT_ERR:Cannot find module .../lib/scoring.js` (file doesn't exist yet), so `✗ exports wrong: IMPORT_ERR:...` and subsequent S2-S5 also fail; final `failed: 5`, exit 1.

- [ ] **Step 3: Write minimal implementation.** Create `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/scoring.js` with the EXACT logic lifted from `recall.js` (lines 24-54), verbatim, so behavior is byte-for-byte identical:

```js
// Shared stemmed-token scoring primitives.
//
// Extracted verbatim from recall.js so both continuum recall and comms recall
// score with the SAME stemmer/tokenizer. Changing logic here changes recall's
// behavior — keep it identical to the original recall.js definitions.
//
// Lightweight stemming. Real Porter would conflate more aggressively but adds
// ~150 lines; this handles the most common English plural/tense suffixes well
// enough for "decisions / decision / decided / deciding" to share a root.

export function stem(t) {
  if (!t) return t;
  t = t.toLowerCase();
  if (t.length < 4) return t;
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ied") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
  if (t.endsWith("ed")  && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("es")  && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s")   && t.length > 4 && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

export function tokenize(s) {
  if (!s) return [];
  return s.toLowerCase().split(/[^a-z0-9_+-]+/).filter((t) => t.length >= 2);
}

export function tokenizeStemmed(s) {
  return tokenize(s).map(stem);
}

// Count occurrences of each query stem in the document stems (term frequency).
export function termFrequency(docStems, queryStems) {
  const counts = new Map();
  for (const q of queryStems) counts.set(q, 0);
  for (const d of docStems) {
    if (counts.has(d)) counts.set(d, counts.get(d) + 1);
  }
  return counts;
}
```

- [ ] **Step 4: Run test to verify it passes.**
  Command: `bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh`
  Expected: `✓` for S1-S5 (`STEM_OK`, `TOK_OK`, `TS_OK`, `TF_OK`), final `passed: 5 / failed: 0`, exit 0.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/lib/scoring.js plugins/continuum/tests/run-scoring.sh
  git commit -m "test(continuum): extract shared scoring primitives into lib/scoring.js

Stem/tokenize/tokenizeStemmed/termFrequency lifted verbatim from recall.js
so comms recall can reuse the same stemmer. recall.js rewired next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 11: Rewire `recall.js` to import the shared primitives (re-export them) — behavior unchanged

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/recall.js:24-54` (delete the local defs), `:16-18` (add scoring import), and add a re-export line.
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (existing — must still pass) + `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh` extended with a re-export check.

Make `recall.js` import from `scoring.js` instead of defining the four functions inline, and re-export them so anything that imported them from `recall.js` (and the comms recall in Task 12) keeps working. `recall()`'s logic is untouched — the existing synthetic recall tests (T13-T17, T27, T34) are the regression gate.

- [ ] **Step 1: Write the failing test.** Append a new section `S6` to `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh`, placed immediately before the `# ---- Summary` block:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh`
  Expected failure: S1-S5 pass, but S6 fails because `recall.js` does not export `stem`/`tokenize`/`tokenizeStemmed`/`termFrequency` — `typeof r[n]` is `"undefined"`, so `allFns=false sameRef=false` → `✗ re-export: REEXPORT_BAD allFns=false sameRef=false`. Final `failed: 1`, exit 1.

- [ ] **Step 3: Write minimal implementation.** Two edits to `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/recall.js`.

  3a. Replace the import block at the top (lines 16-18) — add the scoring import and re-export:

  Replace:
  ```js
  import fs from "node:fs";
  import path from "node:path";
  import { loadIndex, linkPath, readLinkSummary } from "./paths.js";
  ```
  with:
  ```js
  import fs from "node:fs";
  import path from "node:path";
  import { loadIndex, linkPath, readLinkSummary } from "./paths.js";
  import { stem, tokenize, tokenizeStemmed, termFrequency } from "./scoring.js";

  // Re-export so existing importers of these from recall.js keep working, and
  // comms recall can pull them from either module. Single source of truth is
  // lib/scoring.js.
  export { stem, tokenize, tokenizeStemmed, termFrequency };
  ```

  3b. Delete the now-duplicated local definitions (the comment block + the four functions, original lines 20-54). Remove this entire span:
  ```js
  // Lightweight stemming. Real Porter would conflate more aggressively but adds
  // ~150 lines; this handles the most common English plural/tense suffixes well
  // enough for "decisions / decision / decided / deciding" to share a root.
  // Embedding-based semantic recall is deferred — see README Phase-3 notes.
  function stem(t) {
    if (!t) return t;
    t = t.toLowerCase();
    if (t.length < 4) return t;
    if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
    if (t.endsWith("ied") && t.length > 4) return t.slice(0, -3) + "y";
    if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
    if (t.endsWith("ed")  && t.length > 4) return t.slice(0, -2);
    if (t.endsWith("es")  && t.length > 4) return t.slice(0, -2);
    if (t.endsWith("s")   && t.length > 4 && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
    return t;
  }

  function tokenize(s) {
    if (!s) return [];
    return s.toLowerCase().split(/[^a-z0-9_+-]+/).filter((t) => t.length >= 2);
  }

  function tokenizeStemmed(s) {
    return tokenize(s).map(stem);
  }

  // Count occurrences of each query stem in the document stems (term frequency).
  function termFrequency(docStems, queryStems) {
    const counts = new Map();
    for (const q of queryStems) counts.set(q, 0);
    for (const d of docStems) {
      if (counts.has(d)) counts.set(d, counts.get(d) + 1);
    }
    return counts;
  }
  ```
  Leave everything from `function readRefs(...)` onward (and `recall`/`formatRecallForHuman`) exactly as-is. The `recall()` body still calls `tokenize`, `stem`, `tokenizeStemmed`, `termFrequency` — now resolved via the imports.

- [ ] **Step 4: Run tests to verify they pass.** Run BOTH the scoring unit test and the full synthetic suite (the recall-behavior regression gate):
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh
  ```
  Expected: scoring → `passed: 6 / failed: 0` (S6 now `REEXPORT_OK`). Synthetic → all tests pass `failed: 0`, with the recall-behavior tests explicitly green: T13 (`recall 'mfa' → link 2`), T14 (tag-filtered → link 3), T17 (archived postgres surfaced), T27 (`decision`/`decided` stem hits), T34 (stale flag). Both exit 0.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/lib/recall.js plugins/continuum/tests/run-scoring.sh
  git commit -m "refactor(continuum): recall.js consumes shared scoring primitives

recall.js now imports + re-exports stem/tokenize/tokenizeStemmed/termFrequency
from lib/scoring.js instead of defining them inline. recall() behavior is
unchanged — full synthetic suite (T13-T17, T27, T34) still green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 12: `comms_recall.js` — scored, capped, allowlist-scoped retrieval over per-chat shards

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/comms_recall.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-comms-recall.sh`

Build `commsRecall(projectDir, { query, provider?, accountId?, chatId?, since?, until?, limit? })` that scans the per-chat `messages.jsonl` shards, scores each message's `text` with the shared `scoring.js` primitives (tag-less: TF over message text), and returns top-scored snippets honoring the §10 output contract (each hit has `chatId`, `tsIso`, `senderName`, `excerpt`, `msgId`) and the §4.3 caps (default `limit` 10, hard max 200 clamp). Only allowlisted chats are scanned (read-side strictness, §6.4).

**Dependencies (shared contracts, delivered by earlier phases — this task imports them, does not redefine them):**
- `paths.js`: `commsConfigPath`, `commsLocalConfigPath`, `commsChatDir(projectDir, provider, accountId, chatId)`, `commsMessagesPath(projectDir, provider, accountId, chatId)`.
- `comms_config.js`: `readConfig(projectDir)`.
- `comms_allowlist.js`: `isAllowed(cfg, provider, accountId, jid)`.
- `comms_store.js`: `listChats(projectDir, allowedJids)` returning `[{provider, accountId, chatId, ...}]`.

The test seeds the `.continuum/comms` tree directly with `fs` (provider-agnostic JSONL + config), so it does NOT require the WhatsApp provider or the MCP server — only the Phase-1 lib modules above.

- [ ] **Step 1: Write the failing test.** Create `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-comms-recall.sh`. It builds a synthetic comms store with two allowlisted chats + one NON-allowlisted chat, then asserts scoring, the §10 hit shape, caps clamp, allowlist scoping, and since/until filtering:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-comms-recall.sh`
  Expected failure: every `CALL` prints `ERR:Cannot find module .../lib/comms_recall.js` (file absent), so C1-C7 all fail; final `failed: 7`, exit 1.

- [ ] **Step 3: Write minimal implementation.** Create `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/comms_recall.js`. It reads shards directly (provider-agnostic), scoped by the config allowlist, scores with `scoring.js`, and clamps per §4.3:

```js
// comms_recall.js — stemmed-token search over per-chat messages.jsonl shards.
//
// Reuses the shared scoring primitives (lib/scoring.js) so comms recall scores
// identically to continuum recall. Read-side allowlist-strict (§6.4): only
// chats present in config.allowed_jids are ever scanned. Output honors §10
// (each hit: chatId, tsIso, senderName, excerpt, msgId) and §4.3 caps
// (default limit 10, HARD max 200 clamp). Returns a slice, never the store.

import fs from "node:fs";
import path from "node:path";
import {
  commsChatDir,
  commsMessagesPath,
} from "./paths.js";
import { readConfig } from "./comms_config.js";
import { isAllowed } from "./comms_allowlist.js";
import { tokenize, stem, tokenizeStemmed, termFrequency } from "./scoring.js";

// §4.3 efficiency invariants — enforced server-side, not caller-overridable.
const DEFAULT_LIMIT = 10;
const HARD_MAX_LIMIT = 200;
const EXCERPT_MAX = 200; // chars — keep snippets compact (req-5)

// A short, single-line excerpt for the snippet contract (§10).
function excerptOf(text) {
  if (!text) return "";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > EXCERPT_MAX ? oneLine.slice(0, EXCERPT_MAX - 1) + "…" : oneLine;
}

// Walk config -> every (provider, accountId, chatId) that is allowlisted.
// Filtered further by the caller's provider/accountId/chatId if supplied.
function allowedChats(cfg, { provider, accountId, chatId }) {
  const out = [];
  const providers = (cfg && cfg.providers) || {};
  for (const [prov, pv] of Object.entries(providers)) {
    if (provider && prov !== provider) continue;
    const accounts = (pv && pv.accounts) || {};
    for (const [acc, av] of Object.entries(accounts)) {
      if (accountId && acc !== accountId) continue;
      const jids = Array.isArray(av && av.allowed_jids) ? av.allowed_jids : [];
      for (const jid of jids) {
        if (chatId && jid !== chatId) continue;
        // Defense in depth: confirm via the shared allowlist decision.
        if (!isAllowed(cfg, prov, acc, jid)) continue;
        out.push({ provider: prov, accountId: acc, chatId: jid });
      }
    }
  }
  return out;
}

// Read + parse one chat's messages.jsonl (best-effort; tolerate bad lines).
function readShard(projectDir, provider, accountId, chatId) {
  const file = commsMessagesPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const msgs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { msgs.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return msgs;
}

export function commsRecall(projectDir, opts = {}) {
  if (!projectDir) throw new Error("commsRecall: projectDir required");
  const { query, provider, accountId, chatId, since, until } = opts;
  if (!query || !String(query).trim()) throw new Error("commsRecall: query required");

  // Clamp the limit per §4.3 (clamped, not honored, when over-max).
  let limit = Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > HARD_MAX_LIMIT) limit = HARD_MAX_LIMIT;

  const queryStems = tokenizeStemmed(query);
  const queryStemSet = new Set(queryStems);

  const cfg = readConfig(projectDir);
  const targets = allowedChats(cfg, { provider, accountId, chatId });

  const scored = [];
  let totalScanned = 0;

  for (const t of targets) {
    const msgs = readShard(projectDir, t.provider, t.accountId, t.chatId);
    for (const m of msgs) {
      // Window filter on epoch-second ts (authoritative for ordering).
      if (since != null && Number(m.ts) < Number(since)) continue;
      if (until != null && Number(m.ts) > Number(until)) continue;
      totalScanned++;

      const docStems = tokenizeStemmed(m.text || "");
      if (docStems.length === 0) continue;
      const tf = termFrequency(docStems, queryStems);
      let score = 0;
      const matched = [];
      for (const qt of queryStems) {
        const count = tf.get(qt) || 0;
        if (count > 0) { score += Math.log(1 + count); matched.push(qt); }
      }
      if (score === 0) continue;

      scored.push({
        provider: t.provider,
        accountId: t.accountId,
        chatId: m.chatId ?? t.chatId,
        msgId: m.msgId,
        tsIso: m.tsIso || null,
        ts: Number(m.ts) || 0,
        senderName: m.senderName || m.senderId || "",
        excerpt: excerptOf(m.text),
        score,
        matchedKeywords: matched,
      });
    }
  }

  // Sort: score desc, then recency (newer ts first) — "mostly latest" (req-5).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.ts - a.ts;
  });

  return {
    query,
    queryStems,
    limit,
    totalScanned,
    hitCount: scored.length,
    hits: scored.slice(0, limit),
  };
}
```

> Note: `stem` and `tokenize` are imported for parity/explicitness with `scoring.js`'s public surface even though `tokenizeStemmed`/`termFrequency` do the work here; if your linter flags the unused imports, trim to `{ tokenizeStemmed, termFrequency }` — behavior is identical.

- [ ] **Step 4: Run test to verify it passes.**
  Command: `bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-comms-recall.sh`
  Expected: `✓` for C1 (`top hit msgId == G2`), C2 (`hit shape complete per §10`), C3 (`denied chat excluded`), C4 (`limit 99999 clamped to 200` + `default limit is 10`), C5 (`postgres → D1`), C6 (`since filter keeps only G3`), C7 (`0 hits, no error`). Final `passed: 8 / failed: 0`, exit 0.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/lib/comms_recall.js plugins/continuum/tests/run-comms-recall.sh
  git commit -m "feat(comms): allowlist-scoped, capped stemmed-token recall over message shards

commsRecall() scans per-chat messages.jsonl using shared scoring primitives;
returns §10 snippets (chatId/tsIso/senderName/excerpt/msgId) under §4.3 caps
(default 10, hard-max 200 clamp). Read-side allowlist-strict — denied chats
are never scanned.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Phase 2 verification gate

- [ ] After Task 12, all three suites must be green together:
```
bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-scoring.sh
bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh
bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-comms-recall.sh
```
Expected: each prints `failed: 0` and exits 0 — proving the scoring refactor did not change `recall()`'s behavior (synthetic T13-T17/T27/T34 still pass) and comms recall reuses the same primitives.

## Phase 3 — Comms MCP Server, Provider Layer & WhatsApp Capture

> **Phase context.** These tasks build the bundled `comms` MCP server (`server/src/comms/`). They depend on the Phase 1/2 lib contracts already shipping: `plugins/continuum/lib/comms_config.js`, `comms_dedupe.js`, `comms_store.js`, `comms_allowlist.js`, and the path helpers in `plugins/continuum/lib/paths.js` (the `commsAuthDir`/`commsChatDir`/etc. ESM exports). Tests in this phase are dependency-free Node (`node:assert/strict` + `mkdtemp`, run via `node _file.mjs`), matching `server/_*.test.mjs`. The server modules mirror `server/src/index.js` (real `@modelcontextprotocol/sdk`, `StdioServerTransport`) and `plugins/continuum/mcp/server.js` (the `project_dir`-as-arg pattern). **`@whiskeysockets/baileys`@6.7.23 + `qrcode` are added to `server/package.json` deps in the build phase (Phase 4)** — Phase 3 keeps every baileys/qrcode import **lazy + injectable** so all tests run with a MOCK socket and no network and no install.

---

### Task 13: `normalize.js` — WAMessage → Msg (text + wrappers + Long ts + group participant)

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/normalize.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_normalize.test.mjs`

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_normalize.test.mjs
import assert from "node:assert/strict";
import { normalize } from "./src/comms/normalize.js";

const ACC = { provider: "whatsapp", accountId: "work" };

// helper: build a baileys-ish WAMessage envelope
function waMsg(over = {}) {
  return {
    key: { remoteJid: "19999999999@s.whatsapp.net", fromMe: false, id: "3EB0ABC", ...(over.key || {}) },
    messageTimestamp: over.messageTimestamp ?? 1717700000,
    pushName: over.pushName ?? "Alice",
    message: over.message ?? { conversation: "hello world" },
  };
}

// 1) plain DM text
{
  const m = normalize("whatsapp", ACC, waMsg(), "live");
  assert.equal(m.provider, "whatsapp");
  assert.equal(m.accountId, "work");
  assert.equal(m.chatId, "19999999999@s.whatsapp.net");
  assert.equal(m.msgId, "3EB0ABC");
  assert.equal(m.fromMe, false);
  assert.equal(m.senderId, "19999999999@s.whatsapp.net"); // DM: sender = remoteJid
  assert.equal(m.senderName, "Alice");
  assert.equal(m.ts, 1717700000);
  assert.equal(m.tsIso, "2026-06-06T18:13:20.000Z");
  assert.equal(m.kind, "text");
  assert.equal(m.text, "hello world");
  assert.equal(m.media, null);
  assert.equal(m.reply_to, null);
  assert.equal(m.source, "live");
  assert.equal(typeof m.ts, "number");
}

// 2) extendedTextMessage with reply (contextInfo.stanzaId)
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { extendedTextMessage: { text: "re: that", contextInfo: { stanzaId: "QUOTED1" } } },
  }), "live");
  assert.equal(m.kind, "text");
  assert.equal(m.text, "re: that");
  assert.equal(m.reply_to, "QUOTED1");
}

// 3) Long-shaped messageTimestamp { low, high, unsigned } -> Number
{
  const m = normalize("whatsapp", ACC, waMsg({ messageTimestamp: { low: 1717700000, high: 0, unsigned: true } }), "live");
  assert.equal(m.ts, 1717700000);
  assert.equal(typeof m.ts, "number");
}

// 4) group: sender is key.participant, chatId is the group jid
{
  const m = normalize("whatsapp", ACC, waMsg({
    key: { remoteJid: "123-456@g.us", participant: "1888@s.whatsapp.net", id: "G1", fromMe: false },
  }), "live");
  assert.equal(m.chatId, "123-456@g.us");
  assert.equal(m.senderId, "1888@s.whatsapp.net");
}

// 5) ephemeral wrapper unwrap
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { ephemeralMessage: { message: { conversation: "secret-ish" } } },
  }), "live");
  assert.equal(m.text, "secret-ish");
  assert.equal(m.kind, "text");
}

// 6) viewOnce + deviceSent nested wrappers unwrap to the inner image
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { deviceSentMessage: { message: { viewOnceMessage: { message: {
      imageMessage: { caption: "look", mimetype: "image/jpeg", fileName: "a.jpg", fileLength: 2048, mediaKey: "MK" },
    } } } } },
  }), "live");
  assert.equal(m.kind, "image");
  assert.equal(m.text, "look");
  assert.deepEqual(m.media, { mimetype: "image/jpeg", fileName: "a.jpg", sizeBytes: 2048 });
}

// 7) control event (message undefined) -> system, null-safe
{
  const m = normalize("whatsapp", ACC, waMsg({ message: null }), "live");
  assert.equal(m.kind, "system");
  assert.equal(m.text, "");
  assert.equal(m.media, null);
}

// 8) poll
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { pollCreationMessage: { name: "Lunch?", options: [{ optionName: "Yes" }, { optionName: "No" }] } },
  }), "live");
  assert.equal(m.kind, "poll");
  assert.equal(m.text, "Lunch?");
}

// 9) location
{
  const m = normalize("whatsapp", ACC, waMsg({
    message: { locationMessage: { degreesLatitude: 1.5, degreesLongitude: 2.5, name: "HQ" } },
  }), "live");
  assert.equal(m.kind, "location");
  assert.ok(m.text.includes("1.5") && m.text.includes("2.5"));
}

console.log("✓ comms normalize");
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_normalize.test.mjs`
  Expected failure: `ERR_MODULE_NOT_FOUND` — `Cannot find module './src/comms/normalize.js'`.

- [ ] **Step 3: Write minimal implementation.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/normalize.js
// Provider-native WhatsApp WAMessage -> normalized Msg (§4.1 / §5.2).
// Pure, fs-free, dependency-free. The fingerprint is added later by the capture
// pipeline (via comms_dedupe.fingerprint) — normalize only produces the shape.

// Unwrap baileys envelope wrappers that hide the real content node (§5.2).
function unwrap(message) {
  let m = message;
  let guard = 0;
  while (m && guard++ < 8) {
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2) { m = m.viewOnceMessageV2.message; continue; }
    if (m.viewOnceMessageV2Extension) { m = m.viewOnceMessageV2Extension.message; continue; }
    if (m.deviceSentMessage) { m = m.deviceSentMessage.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  return m || null;
}

// baileys messageTimestamp can be a number, a string, or a Long {low,high,unsigned}.
function toEpochSeconds(t) {
  if (t == null) return 0;
  if (typeof t === "number") return Math.floor(t);
  if (typeof t === "string") { const n = Number(t); return Number.isFinite(n) ? Math.floor(n) : 0; }
  if (typeof t === "object" && typeof t.low === "number") {
    // Long: value = high*2^32 + (low>>>0). Timestamps fit in low for the next ~century.
    return (t.high * 4294967296) + (t.low >>> 0);
  }
  if (typeof t === "object" && typeof t.toNumber === "function") return Math.floor(t.toNumber());
  return 0;
}

function mediaFrom(node) {
  if (!node) return null;
  const mimetype = node.mimetype || null;
  const fileName = node.fileName || node.title || null;
  let sizeBytes = null;
  if (node.fileLength != null) sizeBytes = toEpochSeconds(node.fileLength); // reuse Long coercion
  if (!mimetype && !fileName && sizeBytes == null) return null;
  return { mimetype, fileName, sizeBytes };
}

// Map an unwrapped content node -> {kind, text, media}.
function classify(node) {
  if (!node) return { kind: "system", text: "", media: null };
  if (node.conversation) return { kind: "text", text: node.conversation, media: null };
  if (node.extendedTextMessage) return { kind: "text", text: node.extendedTextMessage.text || "", media: null };
  if (node.imageMessage) return { kind: "image", text: node.imageMessage.caption || "", media: mediaFrom(node.imageMessage) };
  if (node.videoMessage) return { kind: "video", text: node.videoMessage.caption || "", media: mediaFrom(node.videoMessage) };
  if (node.audioMessage) return { kind: "audio", text: "", media: mediaFrom(node.audioMessage) };
  if (node.documentMessage) return { kind: "document", text: node.documentMessage.caption || "", media: mediaFrom(node.documentMessage) };
  if (node.locationMessage) {
    const l = node.locationMessage;
    const label = l.name ? `${l.name} ` : "";
    return { kind: "location", text: `${label}(${l.degreesLatitude},${l.degreesLongitude})`, media: null };
  }
  if (node.pollCreationMessage || node.pollCreationMessageV3) {
    const p = node.pollCreationMessage || node.pollCreationMessageV3;
    return { kind: "poll", text: p.name || "", media: null };
  }
  return { kind: "system", text: "", media: null };
}

// contextInfo lives on extendedText/media nodes; find the first one that has it.
function replyTo(node) {
  if (!node) return null;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object" && v.contextInfo && v.contextInfo.stanzaId) return v.contextInfo.stanzaId;
  }
  return null;
}

export function normalize(provider, acc, raw, source = "live") {
  const key = raw.key || {};
  const isGroup = typeof key.remoteJid === "string" && key.remoteJid.endsWith("@g.us");
  const chatId = key.remoteJid || "";
  const senderId = isGroup ? (key.participant || key.remoteJid || "") : (key.remoteJid || "");
  const node = unwrap(raw.message);
  const { kind, text, media } = classify(node);
  const ts = toEpochSeconds(raw.messageTimestamp);
  return {
    provider,
    accountId: acc.accountId,
    chatId,
    msgId: key.id || "",
    fingerprint: null, // assigned by capture pipeline via comms_dedupe.fingerprint
    fromMe: !!key.fromMe,
    senderId,
    senderName: raw.pushName || raw.verifiedBizName || "",
    ts,
    tsIso: new Date(ts * 1000).toISOString(),
    kind,
    text,
    media,
    reply_to: replyTo(node),
    source,
  };
}
```

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_normalize.test.mjs`
  Expected: `✓ comms normalize`

- [ ] **Step 5: Commit.**
  `git add server/src/comms/normalize.js server/_comms_normalize.test.mjs && git commit -m "feat(comms): normalize WAMessage -> Msg (wrappers, Long ts, group participant, reply_to)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 14: `provider.js` — CommsProvider interface + registry

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/provider.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_provider.test.mjs`

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_provider.test.mjs
import assert from "node:assert/strict";
import { CommsProvider, ProviderRegistry, NotImplemented } from "./src/comms/provider.js";

// 1) Base class: required methods throw NotImplemented; declared-but-v2 send* throw too.
{
  const p = new CommsProvider("dummy");
  assert.equal(p.name, "dummy");
  for (const m of ["link","status","unlink","listChats","listGroups","getMessages","onMessage","getSessionDir"]) {
    assert.throws(() => p[m]("acc"), NotImplemented, `${m} should be NotImplemented`);
  }
  assert.throws(() => p.sendText("a","b","c"), /v2/i);
  assert.throws(() => p.sendMedia("a","b",{}), /v2/i);
}

// 2) Registry: register a factory, get a per-(provider) singleton, list names.
{
  let made = 0;
  class Fake extends CommsProvider {
    constructor() { super("fake"); made++; }
    status() { return "logged_out"; }
  }
  const reg = new ProviderRegistry();
  reg.register("fake", (deps) => { assert.ok(deps && deps.projectDirFor); return new Fake(); });
  const a = reg.get("fake", { projectDirFor: () => "/tmp/x" });
  const b = reg.get("fake", { projectDirFor: () => "/tmp/x" });
  assert.equal(a, b, "registry must return a singleton per provider");
  assert.equal(made, 1);
  assert.equal(a.status(), "logged_out");
  assert.deepEqual(reg.names(), ["fake"]);
}

// 3) Registry: unknown provider throws a clear error.
{
  const reg = new ProviderRegistry();
  assert.throws(() => reg.get("nope", {}), /unknown provider: nope/);
}

console.log("✓ comms provider + registry");
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_provider.test.mjs`
  Expected failure: `ERR_MODULE_NOT_FOUND` — `Cannot find module './src/comms/provider.js'`.

- [ ] **Step 3: Write minimal implementation.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/provider.js
// CommsProvider interface (Appendix A) + a name->provider registry.
// Providers are channel implementations; tools dispatch on `provider`.

export class NotImplemented extends Error {
  constructor(method) {
    super(`CommsProvider.${method} is not implemented by this provider`);
    this.name = "NotImplemented";
    this.method = method;
  }
}

// Abstract base. Subclasses (WhatsAppProvider, future TelegramProvider) override.
// link(accountId, opts:{phone?})        -> { method:'qr'|'pairing', payload }
// status(accountId)                      -> 'connected'|'needs_login'|'logged_out'
// unlink(accountId)                      -> wipe session files
// listChats(accountId)                   -> [{id,name,chatKind}]
// listGroups(accountId)                  -> [{id,name,chatKind:'group'}]
// getMessages(accountId, chatId, {limit,before,after}) -> Msg[] (best-effort backfill)
// onMessage(cb)                          -> live stream of normalized Msg
// getSessionDir(accountId)               -> auth dir path
export class CommsProvider {
  constructor(name) { this.name = name; }
  link() { throw new NotImplemented("link"); }
  status() { throw new NotImplemented("status"); }
  unlink() { throw new NotImplemented("unlink"); }
  listChats() { throw new NotImplemented("listChats"); }
  listGroups() { throw new NotImplemented("listGroups"); }
  getMessages() { throw new NotImplemented("getMessages"); }
  onMessage() { throw new NotImplemented("onMessage"); }
  getSessionDir() { throw new NotImplemented("getSessionDir"); }
  // Declared for v2, intentionally unimplemented in v1 (§Appendix A).
  sendText() { throw new Error("sendText is deferred to v2"); }
  sendMedia() { throw new Error("sendMedia is deferred to v2"); }
}

export class ProviderRegistry {
  constructor() {
    this._factories = new Map(); // name -> (deps) => CommsProvider
    this._instances = new Map(); // name -> CommsProvider (singleton)
  }
  register(name, factory) { this._factories.set(name, factory); }
  names() { return [...this._factories.keys()]; }
  get(name, deps) {
    if (this._instances.has(name)) return this._instances.get(name);
    const factory = this._factories.get(name);
    if (!factory) throw new Error(`unknown provider: ${name}`);
    const inst = factory(deps);
    this._instances.set(name, inst);
    return inst;
  }
}
```

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_provider.test.mjs`
  Expected: `✓ comms provider + registry`

- [ ] **Step 5: Commit.**
  `git add server/src/comms/provider.js server/_comms_provider.test.mjs && git commit -m "feat(comms): CommsProvider interface + provider registry (Appendix A)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 15: `whatsapp.js` — console-logger shim + lockfile single-writer (§7)

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/whatsapp.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lock.test.mjs`

> Build the WhatsAppProvider incrementally. This first slice ships only the **pure, network-free** pieces: the `pino`-free console-logger shim and the single-writer lockfile with stale-pid recovery. Both are exported for direct test.

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lock.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { consoleLogger, acquireLock, releaseLock, readLock } from "./src/comms/whatsapp.js";

// 1) console-logger shim: pino-shaped, no throw, child() returns a logger.
{
  const calls = [];
  const lg = consoleLogger({ level: "info", write: (s) => calls.push(s) });
  assert.equal(lg.level, "info");
  for (const m of ["trace","debug","info","warn","error","fatal"]) assert.equal(typeof lg[m], "function");
  lg.info({ a: 1 }, "hello");
  lg.error("boom");
  const child = lg.child({ mod: "wa" });
  assert.equal(typeof child.info, "function");
  child.warn("nested");
  assert.ok(calls.length >= 1);
  assert.ok(calls.join("\n").includes("hello"));
}

// 2) lockfile acquire writes {pid, startedAt}; double-acquire by a LIVE pid refuses.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-lock-"));
  const ok = await acquireLock(dir);
  assert.equal(ok.acquired, true);
  const lk = await readLock(dir);
  assert.equal(lk.pid, process.pid);
  assert.equal(typeof lk.startedAt, "number");

  // Simulate another live process already holding it (current pid is alive) -> refuse.
  const again = await acquireLock(dir);
  assert.equal(again.acquired, false);
  assert.equal(again.reason, "held");
  assert.equal(again.holder.pid, process.pid);

  await releaseLock(dir);
  const after = await readLock(dir);
  assert.equal(after, null);

  await fs.rm(dir, { recursive: true, force: true });
}

// 3) stale lock (dead pid) is reclaimed.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-lock2-"));
  await fs.mkdir(dir, { recursive: true });
  // pid that cannot be alive (very large); startedAt in the past.
  await fs.writeFile(path.join(dir, ".lock"), JSON.stringify({ pid: 2 ** 30, startedAt: 1 }));
  const ok = await acquireLock(dir);
  assert.equal(ok.acquired, true, "stale (dead-pid) lock must be reclaimed");
  const lk = await readLock(dir);
  assert.equal(lk.pid, process.pid);
  await releaseLock(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp logger + lockfile");
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lock.test.mjs`
  Expected failure: `ERR_MODULE_NOT_FOUND` — `Cannot find module './src/comms/whatsapp.js'`.

- [ ] **Step 3: Write minimal implementation.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/whatsapp.js
// WhatsAppProvider (Baileys). v1: capture-only, no send.
// IMPORTANT: baileys/qrcode are imported LAZILY inside connect() so unit tests
// (logger, lockfile, lifecycle with a MOCK socket) never load native-free-but-
// heavy deps and never touch the network. The pinned dep is 6.7.23 (build phase).

import fs from "node:fs/promises";
import path from "node:path";

// ---- pino-free console logger shim (§9: do NOT add pino) -------------------
// baileys expects a pino-shaped logger: {level, child(), trace/debug/info/warn/
// error/fatal}. We forward to stderr (stdout is the MCP JSON-RPC channel).
export function consoleLogger({ level = "warn", write } = {}) {
  const out = write || ((s) => process.stderr.write(s + "\n"));
  const fmt = (lvl, args) => {
    const parts = args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    return `[wa:${lvl}] ${parts.join(" ")}`;
  };
  const mk = (lvl) => (...args) => { out(fmt(lvl, args)); };
  const logger = {
    level,
    trace: mk("trace"),
    debug: mk("debug"),
    info: mk("info"),
    warn: mk("warn"),
    error: mk("error"),
    fatal: mk("fatal"),
    child() { return consoleLogger({ level, write: out }); },
  };
  return logger;
}

// ---- single-writer lockfile (§7) ------------------------------------------
function lockPath(authDir) { return path.join(authDir, ".lock"); }

function pidAlive(pid) {
  if (!pid || pid === process.pid) {
    // Our own pid counts as alive only if it's actually us.
    if (pid === process.pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
    return false;
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export async function readLock(authDir) {
  try {
    const raw = await fs.readFile(lockPath(authDir), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

export async function acquireLock(authDir) {
  await fs.mkdir(authDir, { recursive: true });
  const existing = await readLock(authDir);
  if (existing && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { acquired: false, reason: "held", holder: existing };
  }
  if (existing && existing.pid === process.pid) {
    // We already hold it.
    return { acquired: false, reason: "held", holder: existing };
  }
  // No holder, or stale (dead pid) -> reclaim.
  const rec = { pid: process.pid, startedAt: Date.now() };
  await fs.writeFile(lockPath(authDir), JSON.stringify(rec));
  return { acquired: true, holder: rec };
}

export async function releaseLock(authDir) {
  const lk = await readLock(authDir);
  if (lk && lk.pid === process.pid) {
    try { await fs.rm(lockPath(authDir), { force: true }); } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lock.test.mjs`
  Expected: `✓ comms whatsapp logger + lockfile`

- [ ] **Step 5: Commit.**
  `git add server/src/comms/whatsapp.js server/_comms_wa_lock.test.mjs && git commit -m "feat(comms): pino-free console-logger shim + single-writer lockfile (stale-pid recovery)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 16: `whatsapp.js` — capture pipeline against a MOCK Baileys socket (upsert → normalize → capture, dedupe, allowlist drop)

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/whatsapp.js` (add `WhatsAppProvider` class + `connect({ makeSocket })` injectable factory + capture wiring)
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs`

> The MOCK socket is a tiny `EventEmitter`-shaped object the test injects via `connect({ makeSocket })`. No baileys, no `qrcode`, no network. Capture wires `messages.upsert` and `messaging-history.set` → `normalize` → `assertAllowed`/`isAllowed` → `fingerprint` → `appendMessage`, using the **real Phase-1/2 libs** (`comms_dedupe`, `comms_store`, `comms_allowlist`, `comms_config`, `paths`).

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { WhatsAppProvider } from "./src/comms/whatsapp.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";
import { getSlice } from "../plugins/continuum/lib/comms_store.js";
import { commsAuthDir } from "../plugins/continuum/lib/paths.js";

// A mock baileys socket: EventEmitter with .ev.on/.emit + the methods the
// provider calls. emitsConnectionUpdate(qr) / messages.upsert / history.set /
// close-with-reason are driven by the test.
function mockSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (e, cb) => ev.on(e, cb), emit: (e, d) => ev.emit(e, d) },
    user: { id: "me@s.whatsapp.net" },
    end: () => {},
    logout: async () => {},
    _emit: (e, d) => ev.emit(e, d),
  };
  return sock;
}

function waMsg(over = {}) {
  return {
    key: { remoteJid: over.remoteJid || "111@s.whatsapp.net", fromMe: false, id: over.id || "ID1", participant: over.participant },
    messageTimestamp: over.ts ?? 1717700000,
    pushName: over.name ?? "Bob",
    message: { conversation: over.text ?? "hi" },
  };
}

const ACCOUNT = "work";
const ALLOWED = "111@s.whatsapp.net";
const GROUP = "123-456@g.us";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-cap-"));
  await writeConfig(dir, {
    version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [ALLOWED, GROUP] } } } },
  });
  return dir;
}

// 1) live upsert for an allowlisted chat -> normalized + stored.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "L1", text: "live one" })] });
  await new Promise((r) => setTimeout(r, 10)); // let async append flush

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1);
  assert.equal(slice.messages[0].text, "live one");
  assert.equal(slice.messages[0].source, "live");
  assert.ok(slice.messages[0].fingerprint.startsWith("fp:"));
  await fs.rm(dir, { recursive: true, force: true });
}

// 2) NON-allowlisted chat -> dropped before write (structural guarantee §6.4).
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ remoteJid: "999@s.whatsapp.net", id: "X1", text: "stranger" })] });
  await new Promise((r) => setTimeout(r, 10));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: "999@s.whatsapp.net" });
  assert.equal(slice.messages.length, 0, "non-allowlisted message must never be written");
  await fs.rm(dir, { recursive: true, force: true });
}

// 3) duplicate msgId re-delivery -> idempotent (still 1).
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  const m = waMsg({ id: "DUP", text: "once" });
  sock._emit("messages.upsert", { type: "notify", messages: [m] });
  sock._emit("messages.upsert", { type: "notify", messages: [m] }); // re-emit
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "re-delivered msgId must dedupe");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4) messaging-history.set -> backfill source, deduped against a live record.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  // live first
  sock._emit("messages.upsert", { type: "notify", messages: [waMsg({ id: "H1", text: "same line" })] });
  await new Promise((r) => setTimeout(r, 10));
  // history ships the same logical message (same id) -> idempotent
  sock._emit("messaging-history.set", { messages: [waMsg({ id: "H1", text: "same line" })], isLatest: true });
  await new Promise((r) => setTimeout(r, 15));

  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: ALLOWED });
  assert.equal(slice.messages.length, 1, "history overlap with same msgId must dedupe");
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) group upsert: sender = participant; allowlisted group is captured.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("messages.upsert", { type: "notify", messages: [
    waMsg({ remoteJid: GROUP, participant: "1888@s.whatsapp.net", id: "G9", text: "group hi" }),
  ]});
  await new Promise((r) => setTimeout(r, 10));
  const slice = getSlice(dir, { provider: "whatsapp", accountId: ACCOUNT, chatId: GROUP });
  assert.equal(slice.messages.length, 1);
  assert.equal(slice.messages[0].senderId, "1888@s.whatsapp.net");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp capture pipeline (mock socket)");
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs`
  Expected failure: `TypeError: WhatsAppProvider is not a constructor` (export missing) or `p.connect is not a function`.

- [ ] **Step 3: Write minimal implementation.** Append the `WhatsAppProvider` class to `whatsapp.js`.

```js
// ---- append to /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/whatsapp.js ----
import { CommsProvider } from "./provider.js";
import { normalize } from "./normalize.js";
import { appendMessage } from "../../../plugins/continuum/lib/comms_store.js";
import { fingerprint } from "../../../plugins/continuum/lib/comms_dedupe.js";
import { isAllowed, normalizeJid } from "../../../plugins/continuum/lib/comms_allowlist.js";
import { readConfig } from "../../../plugins/continuum/lib/comms_config.js";
import { commsAuthDir } from "../../../plugins/continuum/lib/paths.js";

// LID normalization (§5.2): map @lid <-> phone-JID. baileys' jidNormalizedUser
// is loaded lazily; we ship a safe fallback so tests need no baileys.
let _jidNormalizedUser = (jid) => jid;
async function ensureJidNormalizer() {
  if (_jidNormalizedUser !== undefined && _jidNormalizedUser.__loaded) return;
  try {
    const baileys = await import("@whiskeysockets/baileys");
    if (baileys.jidNormalizedUser) { _jidNormalizedUser = baileys.jidNormalizedUser; _jidNormalizedUser.__loaded = true; }
  } catch { /* test path / not installed yet */ }
}

export class WhatsAppProvider extends CommsProvider {
  constructor({ projectDirFor } = {}) {
    super("whatsapp");
    this.projectDirFor = projectDirFor || (() => process.cwd());
    this.sockets = new Map();      // accountId -> socket
    this.statuses = new Map();     // accountId -> 'connected'|'needs_login'|'logged_out'
    this.listeners = [];           // global onMessage callbacks
    this.logger = consoleLogger({ level: "warn" });
  }

  getSessionDir(accountId) {
    return commsAuthDir(this.projectDirFor(accountId), "whatsapp", accountId);
  }

  status(accountId) { return this.statuses.get(accountId) || "logged_out"; }

  onMessage(cb) { this.listeners.push(cb); }

  // connect: opens a socket and wires capture. `makeSocket` is injectable so
  // tests pass a MOCK socket (no network). Real path lazily builds a baileys
  // socket inside _realMakeSocket (Task 17 wires QR/pairing/reconnect).
  async connect(accountId, { makeSocket } = {}) {
    await ensureJidNormalizer();
    const projectDir = this.projectDirFor(accountId);
    const authDir = commsAuthDir(projectDir, "whatsapp", accountId);
    const factory = makeSocket || ((deps) => this._realMakeSocket(accountId, authDir, deps));
    const sock = await factory({ authDir, accountId });
    this.sockets.set(accountId, sock);
    this.statuses.set(accountId, "connected");
    this._wireCapture(accountId, sock, projectDir, "live", { type: "notify" });
    this._wireHistory(accountId, sock, projectDir);
    return sock;
  }

  _capture(accountId, projectDir, raw, source) {
    if (!projectDir) return; // §3.1: never write to an unresolved project dir
    const acc = { provider: "whatsapp", accountId };
    let msg;
    try { msg = normalize("whatsapp", acc, raw, source); } catch (e) { this.logger.warn("normalize failed", String(e)); return; }
    if (!msg.chatId) return;
    // LID-normalize chat + sender BEFORE allowlist + fingerprint (§5.2).
    msg.chatId = normalizeJid(_jidNormalizedUser(msg.chatId));
    msg.senderId = normalizeJid(_jidNormalizedUser(msg.senderId));
    const cfg = readConfig(projectDir);
    if (!isAllowed(cfg, "whatsapp", accountId, msg.chatId)) return; // drop before write
    msg.fingerprint = fingerprint(msg);
    try { appendMessage(projectDir, msg); } catch (e) { this.logger.warn("append failed", String(e)); return; }
    for (const cb of this.listeners) { try { cb(msg); } catch {} }
  }

  _wireCapture(accountId, sock, projectDir) {
    sock.ev.on("messages.upsert", (payload) => {
      const list = payload?.messages || [];
      for (const raw of list) this._capture(accountId, projectDir, raw, "live");
    });
  }

  _wireHistory(accountId, sock, projectDir) {
    sock.ev.on("messaging-history.set", (payload) => {
      const list = payload?.messages || [];
      for (const raw of list) this._capture(accountId, projectDir, raw, "backfill");
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs`
  Expected: `✓ comms whatsapp capture pipeline (mock socket)`

- [ ] **Step 5: Commit.**
  `git add server/src/comms/whatsapp.js server/_comms_wa_capture.test.mjs && git commit -m "feat(comms): WhatsAppProvider capture pipeline (upsert/history -> normalize -> allowlist -> dedupe -> store) with injectable mock socket

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 17: `whatsapp.js` — link() (QR / pairing-once), connection.update routing, close-with-reason reconnect (§5.2)

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/whatsapp.js` (add `link()`, `_wireConnection()`, reason-branching, `_realMakeSocket` lazy import)
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lifecycle.test.mjs`

> Lifecycle is driven entirely by the MOCK socket emitting `connection.update`. `link()` must surface a QR or (when `phone` given) request a pairing code **exactly once**. Close branches: `loggedOut(401)` → wipe + `logged_out`; `restartRequired(515)`/`connectionClosed(428)` → recreate + reconnect. We inject `qrToDataUrl` + a `requestPairingCode` spy so no `qrcode` dep and no network.

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lifecycle.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { WhatsAppProvider } from "./src/comms/whatsapp.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";

const ACCOUNT = "work";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-life-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false,
    providers: { whatsapp: { accounts: { [ACCOUNT]: { capture: "session", mode: "strict", allowed_jids: [] } } } } });
  return dir;
}

function mockSocket() {
  const ev = new EventEmitter();
  return {
    ev: { on: (e, cb) => ev.on(e, cb) },
    _emit: (e, d) => ev.emit(e, d),
    user: null,
    end() {},
    pairing: [],
    async requestPairingCode(phone) { this.pairing.push(phone); return "ABCD1234"; },
  };
}

// 1) link() with no phone -> resolves to {method:'qr', payload} when socket emits a qr.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  // inject a fake qr->dataURL so no `qrcode` dep is needed in tests
  const linkP = p.link(ACCOUNT, {}, { makeSocket: () => sock, qrToDataUrl: async (s) => `data:image/png;base64,QR(${s})` });
  // emit a qr a tick later
  setTimeout(() => sock._emit("connection.update", { qr: "QR-STRING" }), 5);
  const res = await linkP;
  assert.equal(res.method, "qr");
  assert.ok(res.payload.dataUrl.includes("QR-STRING"));
  assert.equal(typeof res.payload.ascii, "string");
  await fs.rm(dir, { recursive: true, force: true });
}

// 2) link() with phone -> requests pairing code ONCE, returns {method:'pairing'}.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  const res = await p.link(ACCOUNT, { phone: "19998887777" }, { makeSocket: () => sock });
  assert.equal(res.method, "pairing");
  assert.equal(res.payload.code, "ABCD1234");
  // Re-emitting a qr must NOT trigger a second pairing request (429 guard).
  sock._emit("connection.update", { qr: "ANOTHER-QR" });
  assert.equal(sock.pairing.length, 1, "pairing code must be requested exactly once");
  await fs.rm(dir, { recursive: true, force: true });
}

// 3) connection.update open -> status connected.
{
  const dir = await setup();
  const sock = mockSocket();
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sock });
  sock._emit("connection.update", { connection: "open" });
  assert.equal(p.status(ACCOUNT), "connected");
  await fs.rm(dir, { recursive: true, force: true });
}

// 4) close with loggedOut(401) -> status logged_out (auth wiped), NO reconnect.
{
  const dir = await setup();
  const sock = mockSocket();
  let made = 0;
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => { made++; return sock; } });
  sock._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.status(ACCOUNT), "logged_out");
  assert.equal(made, 1, "loggedOut must NOT recreate the socket");
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) close with restartRequired(515) -> recreates socket (reconnect).
{
  const dir = await setup();
  let made = 0;
  const sockets = [mockSocket(), mockSocket()];
  const p = new WhatsAppProvider({ projectDirFor: () => dir });
  await p.connect(ACCOUNT, { makeSocket: () => sockets[made++] });
  sockets[0]._emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(made, 2, "restartRequired(515) must recreate the socket exactly once");
  assert.notEqual(p.status(ACCOUNT), "logged_out");
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("✓ comms whatsapp lifecycle (qr/pairing/connection.update/close)");
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lifecycle.test.mjs`
  Expected failure: `TypeError: p.link is not a function`.

- [ ] **Step 3: Write minimal implementation.** Add lifecycle methods to `WhatsAppProvider` (insert inside the class, after `connect`).

```js
  // ---- insert into WhatsAppProvider class (after connect) ----

  // DisconnectReason numeric codes baileys uses (avoids importing the enum):
  // loggedOut=401, restartRequired=515, connectionClosed=428, connectionLost=408,
  // timedOut=408, badSession=500, connectionReplaced=440.
  _statusCode(update) {
    return update?.lastDisconnect?.error?.output?.statusCode
      ?? update?.lastDisconnect?.error?.output?.payload?.statusCode
      ?? null;
  }

  _wireConnection(accountId, sock, projectDir, makeSocket) {
    sock.ev.on("connection.update", async (update) => {
      if (update.connection === "open") {
        this.statuses.set(accountId, "connected");
        if (sock.user) { this._self = sock.user.id; }
        return;
      }
      if (update.connection === "close") {
        const code = this._statusCode(update);
        if (code === 401) {
          // loggedOut: wipe auth, surface re-login, DO NOT reconnect.
          this.statuses.set(accountId, "logged_out");
          try { await this._wipeAuth(accountId); } catch {}
          return;
        }
        // restartRequired(515) / connectionClosed(428) / others: recreate socket.
        this.statuses.set(accountId, "needs_login");
        try {
          await this.connect(accountId, { makeSocket }); // a socket is single-use after close
        } catch (e) { this.logger.warn("reconnect failed", String(e)); }
      }
    });
  }

  async _wipeAuth(accountId) {
    const dir = this.getSessionDir(accountId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // link: open a socket (if needed) and resolve to QR or pairing code.
  // opts: { phone? }. deps: { makeSocket?, qrToDataUrl? } (injectable for tests).
  async link(accountId, opts = {}, deps = {}) {
    const projectDir = this.projectDirFor(accountId);
    const makeSocket = deps.makeSocket || ((d) => this._realMakeSocket(accountId, this.getSessionDir(accountId), d));
    const qrToDataUrl = deps.qrToDataUrl || (async (s) => this._qrToDataUrl(s));
    const sock = await this.connect(accountId, { makeSocket });
    this._wireConnection(accountId, sock, projectDir, makeSocket);

    // Pairing path: request ONCE, never loop (429 guard).
    if (opts.phone) {
      const code = await sock.requestPairingCode(String(opts.phone).replace(/[^0-9]/g, ""));
      return { method: "pairing", payload: { code } };
    }

    // QR path: resolve on the first qr from connection.update; guard re-emits.
    return await new Promise((resolve) => {
      let resolved = false;
      const onUpdate = async (update) => {
        if (resolved || !update.qr) return;
        resolved = true;
        const dataUrl = await qrToDataUrl(update.qr);
        resolve({ method: "qr", payload: { dataUrl, ascii: `[QR] scan in WhatsApp > Linked Devices\n${update.qr}` } });
      };
      sock.ev.on("connection.update", onUpdate);
    });
  }

  // Lazy qrcode import (build phase adds the dep). Falls back to a data-URL stub.
  async _qrToDataUrl(qr) {
    try {
      const qrcode = (await import("qrcode")).default || (await import("qrcode"));
      return await qrcode.toDataURL(qr);
    } catch {
      return `data:text/plain;base64,${Buffer.from(qr).toString("base64")}`;
    }
  }

  // Real baileys socket builder — lazily imported so tests never load baileys.
  async _realMakeSocket(accountId, authDir, _deps) {
    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      // §5.2 trap: ALWAYS pass an explicit callback; syncFullHistory:false alone
      // silently kills history sync and can break live routing.
      shouldSyncHistoryMessage: () => true,
      getMessage: async (key) => this._getMessageFromStore(accountId, key),
    });
    sock.ev.on("creds.update", saveCreds);
    return sock;
  }

  // getMessage: baileys asks us to re-supply a message for decryption/retries.
  // v1 returns undefined (store read is best-effort; missing => baileys retries).
  async _getMessageFromStore(_accountId, _key) { return undefined; }
```

  Also update `connect()` to wire connection routing for the eager-reconnect path. Change the body of `connect` so after `_wireHistory(...)` it adds:

```js
    this._wireConnection(accountId, sock, projectDir, factory);
```

  (Insert immediately after the existing `this._wireHistory(accountId, sock, projectDir);` line.)

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lifecycle.test.mjs`
  Expected: `✓ comms whatsapp lifecycle (qr/pairing/connection.update/close)`
  Then re-run capture to confirm no regression: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs` → `✓ comms whatsapp capture pipeline (mock socket)`

- [ ] **Step 5: Commit.**
  `git add server/src/comms/whatsapp.js server/_comms_wa_lifecycle.test.mjs && git commit -m "feat(comms): WhatsApp link (QR/pairing-once) + connection.update routing + close-reason reconnect branching

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 18: `index.js` — comms MCP stdio server: projectDir resolution (env → arg) + tool registration (§3.1, §10)

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/index.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs`

> Refactor for testability: `index.js` exports a pure `buildServer({ registry, env })` returning `{ tools, handleToolCall, resolveProjectDir }` and only wires `StdioServerTransport` when run as the entrypoint (mirrors `server/src/index.js` SDK usage but keeps the wiring guarded so we can unit-test the tool layer without stdio). This task ships the tool **definitions** + project-dir resolution + dispatch skeleton; read-tool bodies (`comms_get_messages`/`comms_list_chats`) call the Phase-1/2 store libs.

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildServer } from "./src/comms/index.js";
import { ProviderRegistry, CommsProvider } from "./src/comms/provider.js";
import { writeConfig } from "../plugins/continuum/lib/comms_config.js";

const TOOLS = [
  "comms_link_account","comms_account_status","comms_unlink_account",
  "comms_list_chats","comms_list_groups","comms_set_allowlist",
  "comms_get_messages","comms_recall","comms_import_history","comms_sync_now",
];

// 1) all §10 tools present, valid schema, EVERY tool accepts optional project_dir.
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const names = srv.tools.map((t) => t.name);
  for (const t of TOOLS) assert.ok(names.includes(t), `missing tool ${t}`);
  for (const t of srv.tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} schema not object`);
    assert.ok(t.description && t.description.length > 0, `${t.name} no description`);
    assert.ok(t.inputSchema.properties.project_dir, `${t.name} missing project_dir arg`);
  }
}

// 2) projectDir resolution: COMMS_PROJECT_DIR env is the eager path.
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: { COMMS_PROJECT_DIR: "/eager/dir" } });
  assert.equal(srv.resolveProjectDir({}), "/eager/dir");
  // per-tool arg overrides env (§3.1 guaranteed fallback / explicit override).
  assert.equal(srv.resolveProjectDir({ project_dir: "/arg/dir" }), "/arg/dir");
}

// 3) projectDir resolution: NO env, NO arg -> throws (never use cwd for writes).
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  assert.throws(() => srv.resolveProjectDir({}), /project_dir/);
}

// 4) dispatch: comms_account_status routes to the provider via the registry.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-srv-"));
  await writeConfig(dir, { version: 1, decided: true, declined: false, providers: {} });
  class Fake extends CommsProvider { constructor() { super("whatsapp"); } status() { return "needs_login"; } }
  const reg = new ProviderRegistry();
  reg.register("whatsapp", () => new Fake());
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_account_status", arguments: { provider: "whatsapp", accountId: "work", project_dir: dir } });
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, "needs_login");
  assert.equal(r.isError, false);
  await fs.rm(dir, { recursive: true, force: true });
}

// 5) unknown tool -> isError result (MCP convention), not a throw.
{
  const reg = new ProviderRegistry();
  const srv = buildServer({ registry: reg, env: {} });
  const r = await srv.handleToolCall({ name: "comms_nope", arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes("unknown tool"));
}

console.log("✓ comms MCP server tool layer + projectDir resolution");
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs`
  Expected failure: `ERR_MODULE_NOT_FOUND` — `Cannot find module './src/comms/index.js'`.

- [ ] **Step 3: Write minimal implementation.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/src/comms/index.js
#!/usr/bin/env node
// comms MCP server — bundled to dist/comms.bundle.mjs. Mirrors the browser
// server's @modelcontextprotocol/sdk + StdioServerTransport usage. Channel-
// agnostic: dispatches on `provider` via the registry. Project dir is resolved
// explicitly (env COMMS_PROJECT_DIR -> per-tool project_dir arg), NEVER cwd (§3.1).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ProviderRegistry } from "./provider.js";
import { WhatsAppProvider } from "./whatsapp.js";
import { getSlice, listChats } from "../../../plugins/continuum/lib/comms_store.js";
import { readConfig, writeConfig } from "../../../plugins/continuum/lib/comms_config.js";
import { normalizeJid } from "../../../plugins/continuum/lib/comms_allowlist.js";

const log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");

const PROJ = { type: "string", description: "Project root containing .continuum/. Defaults to COMMS_PROJECT_DIR env." };

const TOOL_DEFS = [
  { name: "comms_link_account", description: "Start a login for a comms account; returns a QR (data-URL + ASCII) or, if phone is given, an 8-char pairing code (requested once).",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, phone: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_account_status", description: "Report connection status: connected | needs_login | logged_out.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_unlink_account", description: "Wipe session/auth files for an account.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_list_chats", description: "Enumerate allowlisted DM/group chats for an account.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_list_groups", description: "Enumerate group chats visible to the account (pick-time).",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
  { name: "comms_set_allowlist", description: "Merge JIDs into an account's allowlist and flip decided:true/declined:false.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, allowed_jids: { type: "array", items: { type: "string" } }, project_dir: PROJ }, required: ["provider", "accountId", "allowed_jids"] } },
  { name: "comms_get_messages", description: "Return a bounded latest-N or windowed slice of a chat from the store (default 20, hard max 200).",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, chatId: { type: "string" }, limit: { type: "number" }, anchor: { type: "string" }, before: { type: "number" }, after: { type: "number" }, continuation: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId", "chatId"] } },
  { name: "comms_recall", description: "Stemmed-token search over the comms store; returns scored snippets with msgId handles (bounded).",
    inputSchema: { type: "object", properties: { query: { type: "string" }, provider: { type: "string" }, accountId: { type: "string" }, chatId: { type: "string" }, since: { type: "number" }, until: { type: "number" }, limit: { type: "number" }, project_dir: PROJ }, required: ["query"] } },
  { name: "comms_import_history", description: "Parse a WhatsApp 'Export chat' .txt and reconcile it into the store by fingerprint.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, chatId: { type: "string" }, filePath: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId", "chatId", "filePath"] } },
  { name: "comms_sync_now", description: "Force a connect + best-effort backfill pass for an account.",
    inputSchema: { type: "object", properties: { provider: { type: "string" }, accountId: { type: "string" }, project_dir: PROJ }, required: ["provider", "accountId"] } },
];

function ok(obj) { return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: false }; }
function err(msg) { return { content: [{ type: "text", text: msg }], isError: true }; }

export function buildServer({ registry, env = process.env } = {}) {
  const reg = registry || (() => { const r = new ProviderRegistry(); r.register("whatsapp", (deps) => new WhatsAppProvider(deps)); return r; })();
  const acctProject = new Map(); // accountId -> projectDir (§3.1 in-memory map)

  function resolveProjectDir(args = {}) {
    const dir = args.project_dir || env.COMMS_PROJECT_DIR;
    if (!dir) throw new Error("project_dir is required (no COMMS_PROJECT_DIR env and no project_dir arg)");
    return dir;
  }

  function providerFor(name, projectDir) {
    return reg.get(name, { projectDirFor: (accountId) => acctProject.get(`${name}:${accountId}`) || projectDir });
  }

  async function handleToolCall(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      let projectDir;
      try { projectDir = resolveProjectDir(args); } catch (e) { return err(String(e.message || e)); }
      if (args.provider && args.accountId) acctProject.set(`${args.provider}:${args.accountId}`, projectDir);

      switch (name) {
        case "comms_account_status": {
          const p = providerFor(args.provider, projectDir);
          return ok({ status: p.status(args.accountId) });
        }
        case "comms_link_account": {
          const p = providerFor(args.provider, projectDir);
          const res = await p.link(args.accountId, { phone: args.phone });
          return ok(res);
        }
        case "comms_unlink_account": {
          const p = providerFor(args.provider, projectDir);
          await p.unlink(args.accountId);
          return ok({ unlinked: true });
        }
        case "comms_list_chats": {
          const cfg = readConfig(projectDir);
          const allowed = cfg?.providers?.[args.provider]?.accounts?.[args.accountId]?.allowed_jids || [];
          return ok({ chats: listChats(projectDir, allowed) });
        }
        case "comms_list_groups": {
          const p = providerFor(args.provider, projectDir);
          return ok({ groups: await p.listGroups(args.accountId) });
        }
        case "comms_set_allowlist": {
          const cfg = readConfig(projectDir);
          cfg.decided = true; cfg.declined = false;
          cfg.providers = cfg.providers || {};
          const prov = cfg.providers[args.provider] = cfg.providers[args.provider] || { accounts: {} };
          const acc = prov.accounts[args.accountId] = prov.accounts[args.accountId] || { capture: "session", mode: "strict", allowed_jids: [] };
          const incoming = (args.allowed_jids || []).map(normalizeJid);
          acc.allowed_jids = [...new Set([...(acc.allowed_jids || []), ...incoming])];
          writeConfig(projectDir, cfg);
          return ok({ allowed_jids: acc.allowed_jids });
        }
        case "comms_get_messages": {
          const slice = getSlice(projectDir, { provider: args.provider, accountId: args.accountId, chatId: args.chatId,
            limit: args.limit, anchor: args.anchor, before: args.before, after: args.after, continuation: args.continuation });
          return ok(slice);
        }
        case "comms_sync_now": {
          const p = providerFor(args.provider, projectDir);
          await p.connect?.(args.accountId, {});
          return ok({ status: p.status(args.accountId) });
        }
        case "comms_recall":
        case "comms_import_history":
          // Wired to comms recall/importer libs in their own phase tasks.
          return err(`${name} not wired in this phase`);
        default:
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`${name} failed: ${String(e?.message ?? e)}`);
    }
  }

  return { tools: TOOL_DEFS, handleToolCall, resolveProjectDir, registry: reg };
}

// Entrypoint wiring (only when run directly / bundled) — eager reconnect of
// known accounts, then stdio MCP. Guarded so unit tests import buildServer only.
export async function main() {
  const srv = buildServer({ env: process.env });
  // Eager reconnect (§3.1): if COMMS_PROJECT_DIR is set and accounts exist, reconnect.
  try {
    const projectDir = process.env.COMMS_PROJECT_DIR;
    if (projectDir) {
      const cfg = readConfig(projectDir);
      const provs = cfg?.providers || {};
      for (const provName of Object.keys(provs)) {
        const accounts = provs[provName]?.accounts || {};
        for (const accountId of Object.keys(accounts)) {
          try {
            const p = srv.registry.get(provName, { projectDirFor: () => projectDir });
            await p.connect?.(accountId, {});
            log(`[comms] eager-reconnected ${provName}:${accountId}`);
          } catch (e) { log(`[comms] eager reconnect failed for ${provName}:${accountId}: ${e.message}`); }
        }
      }
    }
  } catch (e) { log(`[comms] eager reconnect skipped: ${e.message}`); }

  const mcp = new Server({ name: "comms", version: "0.7.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: srv.tools }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => srv.handleToolCall(req.params));
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("[comms] ready");
}

// Run only when invoked as the bundle/entry (not on import).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log(`[comms] fatal: ${e.stack || e}`); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs`
  Expected: `✓ comms MCP server tool layer + projectDir resolution`

- [ ] **Step 5: Commit.**
  `git add server/src/comms/index.js server/_comms_server.test.mjs && git commit -m "feat(comms): MCP stdio server — §10 tools, env->arg projectDir resolution, registry dispatch, eager reconnect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 19: stdio boot smoke test — comms server lists tools over real JSON-RPC

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_smoke.mjs`

> Boots `src/comms/index.js` as a child process over stdio (the way Claude launches it) and asserts `initialize` + `tools/list` round-trip and that every §10 tool name comes back. This is the boot smoke test the task requires; it runs against `src/` (not the bundle) so it's green before the build phase wires deps.

- [ ] **Step 1: Write the failing test.**

```js
// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "src", "comms", "index.js");

const WANT = [
  "comms_link_account","comms_account_status","comms_unlink_account",
  "comms_list_chats","comms_list_groups","comms_set_allowlist",
  "comms_get_messages","comms_recall","comms_import_history","comms_sync_now",
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "comms-smoke-"));
const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, COMMS_PROJECT_DIR: tmp }, // empty project -> no eager reconnect work
});

let buf = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 8000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const init = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.ok(init.result, "initialize must return a result");
  assert.equal(init.result.serverInfo.name, "comms");

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc(2, "tools/list", {});
  const names = (list.result.tools || []).map((t) => t.name);
  for (const w of WANT) assert.ok(names.includes(w), `tools/list missing ${w}`);
  for (const t of list.result.tools) assert.ok(t.inputSchema.properties.project_dir, `${t.name} missing project_dir`);

  console.log("✓ comms stdio boot smoke (initialize + tools/list)", names.length, "tools");
} finally {
  child.kill("SIGTERM");
  await fs.rm(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run test to verify it fails.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_smoke.mjs`
  Expected failure: an assertion/timeout, or a child startup error from `src/comms/index.js` (e.g. an import error if a Phase-1/2 lib path is missing) — confirming the smoke harness exercises a real boot. (If green here because Task 18 already boots cleanly, that is acceptable; the harness is new and the value is the regression guard.)

- [ ] **Step 3: Write minimal implementation.**
  No production code change — this task ships the smoke harness itself. If the boot reveals a real defect (e.g. an unguarded import), fix it in `src/comms/index.js` minimally (the most likely fix: ensure `main()` does not throw on an empty project dir — already guarded with try/catch in Task 18).

- [ ] **Step 4: Run test to verify it passes.**
  Command: `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_smoke.mjs`
  Expected: `✓ comms stdio boot smoke (initialize + tools/list) 10 tools`

- [ ] **Step 5: Commit.**
  `git add server/_comms_smoke.mjs && git commit -m "test(comms): stdio boot smoke — initialize + tools/list over real JSON-RPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 20: Wire all comms tests into `npm test` (Phase-3 regression gate)

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/package.json:13` (the `test` script)

> The repo's gate is `server/package.json`'s single `test` script chaining `node _*.mjs`. Add the new comms tests so CI/`npm test` runs them. Keep them after the existing browser tests so a comms break is isolated in the chain.

- [ ] **Step 1: Write the failing test.** (The "test" here is the gate command itself.) Run the full suite to confirm comms tests are NOT yet included:
  Command: `cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && npm test 2>&1 | tail -5`
  Expected: the suite finishes the existing list **without** running any `comms` test (no `✓ comms ...` lines), proving they're un-gated.

- [ ] **Step 2: Run the comms tests individually to verify they pass before wiring.**
  Command:
  `node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_normalize.test.mjs && node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_provider.test.mjs && node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lock.test.mjs && node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_capture.test.mjs && node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_wa_lifecycle.test.mjs && node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_server.test.mjs && node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_smoke.mjs`
  Expected: seven `✓ comms ...` lines, exit 0.

- [ ] **Step 3: Write minimal implementation.** Edit the `test` script in `server/package.json` — append the comms tests to the existing chain (replace the existing `"test": ...` line):

```json
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _playbooks.test.mjs && node _playbook_wire.test.mjs && node _secrets.test.mjs && node _codebase_seed.test.mjs && node _visual_diff.test.mjs && node _playbook_bundles.test.mjs && node _playbook_dashboard.test.mjs && node _integration.mjs && node _multi-client.mjs && node _comms_normalize.test.mjs && node _comms_provider.test.mjs && node _comms_wa_lock.test.mjs && node _comms_wa_capture.test.mjs && node _comms_wa_lifecycle.test.mjs && node _comms_server.test.mjs && node _comms_smoke.mjs",
```

> Note: the Phase-4 build tasks insert the `_comms_build_config`/`_comms_mcp_entry`/`_comms_ci_verify`/`_comms_bundle_smoke` tests into this same `test` script (see Phase 4). Implementers landing Phase 4 after Phase 3 must merge both sets of additions into one chain — the final `test` script in Phase 4 Task 24 is authoritative.

- [ ] **Step 4: Run test to verify it passes.**
  Command: `cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && npm test 2>&1 | grep -c "✓ comms"`
  Expected: `7` (all seven comms suites ran inside `npm test`), and `npm test` exits 0.

- [ ] **Step 5: Commit.**
  `git add server/package.json && git commit -m "test(comms): gate Phase-3 comms suites in npm test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

> **Phase 3 done-when:** `cd server && npm test` is green with all seven comms suites running; `node src/comms/index.js` boots over stdio and lists the 10 §10 tools; capture/normalize/dedupe/allowlist-drop all proven against the mock Baileys socket with zero network and zero baileys/qrcode install. **Carried to later phases:** real-deps install + esbuild `build:comms` target + `.mcp.json` `comms` key + bundle smoke (Phase 4 build); `comms_recall`/`comms_import_history` tool bodies + `listGroups`/`getMessages`/`unlink` real impls + §5.1 newly-allowlisted backfill (deferred). Those are stubbed with honest `not wired in this phase` errors here, never silently faked.

## Phase 4 — Build / Packaging (`comms` bundle target, `.mcp.json`, CI verify, bundle smoke test)

> Verified against the live tree before writing:
> - `server/package.json` v0.6.0, existing `build` script is the browser-only esbuild command (line 12).
> - esbuild **0.28.0** is installed; `--log-override:indirect-require=silent` is **valid** → **keep** the flag in `build:comms`.
> - `.mcp.json` has exactly two servers (`browser`, `continuum`).
> - `.github/workflows/build.yml` verify step asserts only `server/dist/server.bundle.mjs`; `paths-ignore` already lists `server/dist/**`; `git add server/dist/` already generalizes.
> - Server tests are dependency-free Node with `node:assert/strict`, named `_*.test.mjs` / `_*.mjs`, run via the `test` script. Phase 4 follows that exact style.
>
> The createRequire banner (verbatim from line 12) reused for `build:comms` is:
> `import{createRequire as ___cr}from'node:module';const require=___cr(import.meta.url);`

This phase assumes `server/src/comms/index.js` exists and exports the MCP server (Phase 3). Tasks 21–23 are config/wiring (CI-gated), so their "test" is an executable assertion script committed under `server/` and added to the `test` script. Task 24 is the gating bundle smoke test from §12.

---

### Task 21: Add comms deps + split `build` into `build:browser` + `build:comms`

**Files:**
- Modify `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/package.json:12` (the `build` script) and `dependencies`
- Test `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_build_config.test.mjs` (new)

- [ ] **Step 1: Write the failing test** (SHOW full code) — asserts package.json has the exact split scripts, the two pinned deps, and that `pino`/`jimp`/`sharp` are absent.

```js
// server/_comms_build_config.test.mjs
// Dependency-free assertion that the comms build target + deps are wired exactly per spec §9.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const EXISTING_BROWSER =
  'esbuild src/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/server.bundle.mjs --legal-comments=external --banner:js="import{createRequire as ___cr}from\'node:module\';const require=___cr(import.meta.url);"';

const EXPECTED_COMMS =
  'esbuild src/comms/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/comms.bundle.mjs --legal-comments=external --log-override:indirect-require=silent --banner:js="import{createRequire as ___cr}from\'node:module\';const require=___cr(import.meta.url);"';

// 1) build orchestrates both targets, in order
assert.equal(pkg.scripts.build, "npm run build:browser && npm run build:comms", "build must run browser then comms");

// 2) build:browser is the existing browser command, verbatim
assert.equal(pkg.scripts["build:browser"], EXISTING_BROWSER, "build:browser must be the existing browser esbuild command verbatim");

// 3) build:comms is the new comms target with exact flags from §9.2
assert.equal(pkg.scripts["build:comms"], EXPECTED_COMMS, "build:comms must match spec §9.2 exactly");

// 4) deps present + pinned
assert.equal(pkg.dependencies["@whiskeysockets/baileys"], "6.7.23", "baileys must be pinned to 6.7.23");
assert.ok(typeof pkg.dependencies["qrcode"] === "string" && pkg.dependencies["qrcode"].length > 0, "qrcode dep must be present");

// 5) explicitly-forbidden deps absent (§9.1)
for (const banned of ["pino", "jimp", "sharp"]) {
  assert.ok(!("dependencies" in pkg) || !(banned in pkg.dependencies), `${banned} must NOT be a dependency`);
  assert.ok(!("devDependencies" in pkg) || !(banned in (pkg.devDependencies || {})), `${banned} must NOT be a devDependency`);
}

console.log("✓ comms build config (scripts + deps) matches spec §9");
```

- [ ] **Step 2: Run test to verify it fails** (exact command + expected failure):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_build_config.test.mjs
```
Expected failure (because `build` is still the single browser command and deps are absent):
```
AssertionError [ERR_ASSERTION]: build must run browser then comms
  ... expected: 'npm run build:browser && npm run build:comms'
  ... actual:   'esbuild src/index.js --bundle ...'
```
(non-zero exit)

- [ ] **Step 3: Write minimal implementation** — edit `server/package.json`. Replace the single `build` line and add the two deps. The resulting `scripts` block (lines 10–20) and `dependencies` block become:

```json
  "scripts": {
    "start": "node src/index.js",
    "build": "npm run build:browser && npm run build:comms",
    "build:browser": "esbuild src/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/server.bundle.mjs --legal-comments=external --banner:js=\"import{createRequire as ___cr}from'node:module';const require=___cr(import.meta.url);\"",
    "build:comms": "esbuild src/comms/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/comms.bundle.mjs --legal-comments=external --log-override:indirect-require=silent --banner:js=\"import{createRequire as ___cr}from'node:module';const require=___cr(import.meta.url);\"",
    "test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _playbooks.test.mjs && node _playbook_wire.test.mjs && node _secrets.test.mjs && node _codebase_seed.test.mjs && node _visual_diff.test.mjs && node _playbook_bundles.test.mjs && node _playbook_dashboard.test.mjs && node _comms_build_config.test.mjs && node _integration.mjs && node _multi-client.mjs && node _comms_normalize.test.mjs && node _comms_provider.test.mjs && node _comms_wa_lock.test.mjs && node _comms_wa_capture.test.mjs && node _comms_wa_lifecycle.test.mjs && node _comms_server.test.mjs && node _comms_smoke.mjs",
    "test:smoke": "node _smoke.mjs",
    "test:integration": "node _integration.mjs",
    "test:multi": "node _multi-client.mjs",
    "test:e2e:upload": "node _upload_e2e.mjs",
    "test:e2e:playbook": "node _playbook_e2e.mjs",
    "test:ws": "node src/index.js"
  },
  "dependencies": {
    "@babel/parser": "^7.29.3",
    "@babel/traverse": "^7.29.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@whiskeysockets/baileys": "6.7.23",
    "js-yaml": "^4.1.1",
    "pixelmatch": "^5.3.0",
    "pngjs": "^7.0.0",
    "qrcode": "^1.5.4",
    "undici": "^7.25.0",
    "ws": "^8.18.0"
  },
```

> Note: this preserves the Phase-3 comms test chain and inserts `_comms_build_config.test.mjs` before `_integration.mjs`. The browser deps listed above are illustrative of the merged block — implementers must keep every dependency already present in the live `package.json` and ADD only `@whiskeysockets/baileys` + `qrcode`.

Then install the new deps so `node_modules` matches:
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && npm install
```
Expected: `added N packages` with `@whiskeysockets/baileys@6.7.23` and a `qrcode` line; non-zero only on registry failure.

- [ ] **Step 4: Run test to verify it passes** (exact command + expected PASS):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_build_config.test.mjs
```
Expected:
```
✓ comms build config (scripts + deps) matches spec §9
```
(exit 0)

- [ ] **Step 5: Commit**:
```
git add server/package.json server/package-lock.json server/_comms_build_config.test.mjs
git commit -m "build(comms): split build into build:browser/build:comms + pin baileys@6.7.23, qrcode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Register the `comms` MCP server in `.mcp.json`

**Files:**
- Modify `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.mcp.json`
- Test `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_mcp_entry.test.mjs` (new)

- [ ] **Step 1: Write the failing test** (SHOW full code) — asserts the `comms` entry exists with the exact shape from §9.3 (incl. `COMMS_PROJECT_DIR` env), and that the existing two servers are untouched.

```js
// server/_comms_mcp_entry.test.mjs
// Asserts the plugin's own .mcp.json registers the comms stdio server per spec §9.3.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mcp = JSON.parse(fs.readFileSync(path.join(repoRoot, ".mcp.json"), "utf8"));

assert.ok(mcp.mcpServers, "mcpServers must exist");
// existing servers untouched
assert.ok(mcp.mcpServers.browser, "browser server must still exist");
assert.ok(mcp.mcpServers.continuum, "continuum server must still exist");

const comms = mcp.mcpServers.comms;
assert.ok(comms, "comms server entry must exist");
assert.equal(comms.type, "stdio");
assert.equal(comms.command, "node");
assert.deepEqual(comms.args, ["${CLAUDE_PLUGIN_ROOT}/server/dist/comms.bundle.mjs"]);
assert.deepEqual(comms.env, { COMMS_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}" });

console.log("✓ .mcp.json comms entry matches spec §9.3");
```

- [ ] **Step 2: Run test to verify it fails** (exact command + expected failure):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_mcp_entry.test.mjs
```
Expected failure:
```
AssertionError [ERR_ASSERTION]: comms server entry must exist
```
(non-zero exit)

- [ ] **Step 3: Write minimal implementation** — full new content of `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.mcp.json`:

```json
{
  "mcpServers": {
    "browser": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/server/dist/server.bundle.mjs"
      ],
      "env": {
        "SUPER_TESTER_EXTENSION_PATH": "${CLAUDE_PLUGIN_ROOT}/extension"
      }
    },
    "continuum": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/plugins/continuum/mcp/server.js"
      ]
    },
    "comms": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/server/dist/comms.bundle.mjs"
      ],
      "env": {
        "COMMS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

Add the test to the `test` script (between `_comms_build_config.test.mjs` and `_integration.mjs`):
```
"... && node _comms_build_config.test.mjs && node _comms_mcp_entry.test.mjs && node _integration.mjs ..."
```

- [ ] **Step 4: Run test to verify it passes** (exact command + expected PASS):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_mcp_entry.test.mjs
```
Expected:
```
✓ .mcp.json comms entry matches spec §9.3
```
(exit 0)

- [ ] **Step 5: Commit**:
```
git add .mcp.json server/package.json server/_comms_mcp_entry.test.mjs
git commit -m "build(comms): register comms stdio MCP server in .mcp.json with COMMS_PROJECT_DIR

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: CI verify step asserts `comms.bundle.mjs`

**Files:**
- Modify `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.github/workflows/build.yml:44-47` (the "Verify bundle produced" step)
- Test `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_ci_verify.test.mjs` (new)

> No native YAML dep available (dependency-free harness), so the test asserts on the raw workflow text — sufficient to gate the one-line addition.

- [ ] **Step 1: Write the failing test** (SHOW full code):

```js
// server/_comms_ci_verify.test.mjs
// Asserts the CI verify step gates on the comms bundle (spec §9.4),
// and that paths-ignore already covers server/dist/**.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const wf = fs.readFileSync(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");

// the comms bundle must be asserted in CI
assert.ok(wf.includes("test -f server/dist/comms.bundle.mjs"),
  "CI verify step must assert comms.bundle.mjs exists");
// existing browser bundle assertion must remain
assert.ok(wf.includes("test -f server/dist/server.bundle.mjs"),
  "CI verify step must still assert server.bundle.mjs exists");
// dist already ignored from rebuild triggers (no change needed, but assert it stayed)
assert.ok(wf.includes("server/dist/**"),
  "paths-ignore must still cover server/dist/**");

console.log("✓ CI build.yml verifies comms bundle (spec §9.4)");
```

- [ ] **Step 2: Run test to verify it fails** (exact command + expected failure):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_ci_verify.test.mjs
```
Expected failure:
```
AssertionError [ERR_ASSERTION]: CI verify step must assert comms.bundle.mjs exists
```
(non-zero exit)

- [ ] **Step 3: Write minimal implementation** — edit the "Verify bundle produced" step in `build.yml` (lines 44–47). New content of that step:

```yaml
      - name: Verify bundle produced
        run: |
          test -f server/dist/server.bundle.mjs
          test -f server/dist/comms.bundle.mjs
          echo "Browser bundle size: $(du -h server/dist/server.bundle.mjs | cut -f1)"
          echo "Comms bundle size: $(du -h server/dist/comms.bundle.mjs | cut -f1)"
```

Add the test to the `test` script (after `_comms_mcp_entry.test.mjs`):
```
"... && node _comms_mcp_entry.test.mjs && node _comms_ci_verify.test.mjs && node _integration.mjs ..."
```

- [ ] **Step 4: Run test to verify it passes** (exact command + expected PASS):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_ci_verify.test.mjs
```
Expected:
```
✓ CI build.yml verifies comms bundle (spec §9.4)
```
(exit 0)

- [ ] **Step 5: Commit**:
```
git add .github/workflows/build.yml server/package.json server/_comms_ci_verify.test.mjs
git commit -m "ci(comms): verify server/dist/comms.bundle.mjs is produced

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: Gating bundle smoke test — build, boot under bare node, list tools over stdio, assert pure-JS

**Files:**
- Test `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_bundle_smoke.test.mjs` (new — gating, §12)
- (No production code beyond what Tasks 21–23 already wired; this test exercises `npm run build:comms` + the produced bundle.)

> This is a §12 gating acceptance test. It (a) builds `comms.bundle.mjs`, (b) boots it under bare `node` with no `node_modules` resolvable (cwd `os.tmpdir()`), (c) speaks JSON-RPC `initialize` + `tools/list` over stdio and asserts the comms tools surface from §10, and (d) scans the installed pinned baileys subtree for `*.node` binaries and `install`/`preinstall`/`postinstall` scripts to assert pure-JS.

- [ ] **Step 1: Write the failing test** (SHOW full code):

```js
// server/_comms_bundle_smoke.test.mjs
// GATING (spec §12): comms.bundle.mjs builds, boots under bare node, lists tools over stdio;
// pinned baileys subtree is pure-JS (no *.node, no install scripts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = __dirname;
const bundlePath = path.join(serverDir, "dist", "comms.bundle.mjs");

// ── (a) build the comms bundle ──────────────────────────────────────────────
{
  const r = spawnSync("npm", ["run", "build:comms"], { cwd: serverDir, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout || "", r.stderr || "");
    assert.fail("npm run build:comms must succeed");
  }
  assert.ok(fs.existsSync(bundlePath), "comms.bundle.mjs must exist after build");
  const sizeMB = fs.statSync(bundlePath).size / (1024 * 1024);
  assert.ok(sizeMB > 0.5, `bundle should be a real multi-module bundle (got ${sizeMB.toFixed(2)}MB)`);
}

// ── (b)+(c) boot under bare node (cwd=tmp so no node_modules resolves) and
//            drive JSON-RPC initialize + tools/list over stdio ───────────────
const EXPECTED_TOOLS = [
  "comms_link_account",
  "comms_account_status",
  "comms_unlink_account",
  "comms_list_chats",
  "comms_list_groups",
  "comms_set_allowlist",
  "comms_get_messages",
  "comms_recall",
  "comms_import_history",
  "comms_sync_now",
];

async function listToolsOverStdio() {
  const bareCwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "comms-smoke-"));
  const child = spawn(process.execPath, [bundlePath], {
    cwd: bareCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COMMS_PROJECT_DIR: bareCwd },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for tools/list; stderr:\n" + stderr));
    }, 20000);

    child.on("error", (e) => { clearTimeout(timer); reject(e); });

    const tryParse = () => {
      // parse newline-delimited JSON-RPC frames
      const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(msg.result.tools.map((t) => t.name));
          return true;
        }
      }
      return false;
    };

    child.stdout.on("data", () => { tryParse(); });

    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });

  await fs.promises.rm(bareCwd, { recursive: true, force: true });
  return result;
}

{
  const names = await listToolsOverStdio();
  for (const t of EXPECTED_TOOLS) {
    assert.ok(names.includes(t), `comms tool ${t} must be listed over stdio (got: ${names.join(", ")})`);
  }
}

// ── (d) pure-JS assertion for the pinned baileys subtree ─────────────────────
{
  const baileysDir = path.join(serverDir, "node_modules", "@whiskeysockets", "baileys");
  assert.ok(fs.existsSync(baileysDir), "baileys must be installed for the pure-JS scan");

  // version pin
  const bpkg = JSON.parse(fs.readFileSync(path.join(baileysDir, "package.json"), "utf8"));
  assert.equal(bpkg.version, "6.7.23", "baileys must be pinned to 6.7.23");

  // no prebuilt native addons anywhere in the baileys subtree
  const nodeAddons = [];
  const installScriptPkgs = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".node")) nodeAddons.push(full);
        if (ent.name === "package.json") {
          try {
            const p = JSON.parse(fs.readFileSync(full, "utf8"));
            const s = p.scripts || {};
            if (s.install || s.preinstall || s.postinstall) {
              installScriptPkgs.push(`${p.name || ent.name}: ${JSON.stringify({ install: s.install, preinstall: s.preinstall, postinstall: s.postinstall })}`);
            }
          } catch { /* ignore unparseable */ }
        }
      }
    }
  };
  walk(baileysDir);

  assert.equal(nodeAddons.length, 0, `pinned baileys subtree must contain no *.node addons; found:\n${nodeAddons.join("\n")}`);
  assert.equal(installScriptPkgs.length, 0, `pinned baileys subtree must have no install/preinstall/postinstall scripts; found:\n${installScriptPkgs.join("\n")}`);
}

console.log("✓ comms bundle smoke: builds, boots under bare node, lists tools, pure-JS (spec §12)");
```

- [ ] **Step 2: Run test to verify it fails** (exact command + expected failure):
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_bundle_smoke.test.mjs
```
Expected failure at this point — until `src/comms/index.js` exists and exposes the full tool surface, the build or the `tools/list` assertion fails, e.g.:
```
AssertionError [ERR_ASSERTION]: npm run build:comms must succeed
```
or, once it builds but the surface is incomplete:
```
AssertionError [ERR_ASSERTION]: comms tool comms_link_account must be listed over stdio (got: ...)
```
(non-zero exit)

- [ ] **Step 3: Write minimal implementation** — no new production file is authored *in this task*; the comms MCP source (`server/src/comms/index.js` registering the §10 tools) is delivered by Phase 3. This task's "implementation" is wiring the gating test into the test runner so CI enforces it. Edit the `test` script in `server/package.json` to append the smoke test at the end (place it last so a slow boot doesn't block fast failures):

```
"test": "node _smoke.mjs && node _uploads.test.mjs && node _upload_wire.test.mjs && node _playbooks.test.mjs && node _playbook_wire.test.mjs && node _secrets.test.mjs && node _codebase_seed.test.mjs && node _visual_diff.test.mjs && node _playbook_bundles.test.mjs && node _playbook_dashboard.test.mjs && node _comms_build_config.test.mjs && node _comms_mcp_entry.test.mjs && node _comms_ci_verify.test.mjs && node _integration.mjs && node _multi-client.mjs && node _comms_normalize.test.mjs && node _comms_provider.test.mjs && node _comms_wa_lock.test.mjs && node _comms_wa_capture.test.mjs && node _comms_wa_lifecycle.test.mjs && node _comms_server.test.mjs && node _comms_smoke.mjs && node _comms_bundle_smoke.test.mjs",
```

> This is the **authoritative final `test` script** — it merges the Phase-3 comms suites (Task 20) with the Phase-4 build/CI suites (Tasks 21-23) and the gating bundle smoke. Implementers must reconcile any earlier-task edits to this single line.

- [ ] **Step 4: Run test to verify it passes** (exact command + expected PASS) — run once `src/comms/index.js` exists:
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && node _comms_bundle_smoke.test.mjs
```
Expected:
```
✓ comms bundle smoke: builds, boots under bare node, lists tools, pure-JS (spec §12)
```
(exit 0)

- [ ] **Step 5: Commit**:
```
git add server/package.json server/_comms_bundle_smoke.test.mjs server/dist/comms.bundle.mjs server/dist/comms.bundle.mjs.LEGAL.txt
git commit -m "test(comms): gating bundle smoke — boot under bare node, list tools, assert pure-JS (spec §12)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

**Phase 4 verification (run after all four tasks):**
```
cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && npm run build && npm test
```
Expected tail:
```
✓ comms build config (scripts + deps) matches spec §9
✓ .mcp.json comms entry matches spec §9.3
✓ CI build.yml verifies comms bundle (spec §9.4)
✓ comms bundle smoke: builds, boots under bare node, lists tools, pure-JS (spec §12)
```
(exit 0; `server/dist/comms.bundle.mjs` + `comms.bundle.mjs.LEGAL.txt` present and committed)

## Phase 5 — Init-gate refactor, idempotent gitignore, state files, comms slash commands

> **Harness note (read once):** The repo's hook tests live in **one** file, `plugins/continuum/tests/run-synthetic.sh` — a dependency-free bash runner that pipes crafted JSON to a hook via stdin, extracts `hookSpecificOutput.additionalContext` with the `extract_ctx` python3 helper, and asserts with `grep`. Library units are tested in the same file via inline `node -e "import('…').then(…)"` blocks (see T22). All Phase 5 tests append to that single file, **after** the Phase-1 blocks (T35–T43), using the next free `T<NN>` numbers — here **T44–T51**. Run everything with `bash plugins/continuum/tests/run-synthetic.sh` from the repo root; it exits 0 only when `failed: 0`.
>
> **Contract reconciliation (Phase-1/Phase-5 overlap):** Phase 5's original draft re-created the comms path helpers (`paths.js`) and `comms_config.js` as its own Tasks 1–2. Those modules are already delivered by **Phase 1 Tasks 1–2** with the identical shared contract, so the duplicate creation tasks are **dropped here**. Phase 5 therefore starts at the genuinely-new `comms_state.js` and the `session_start.js`/commands work. The path-helper assertion the draft put in its T35 is already covered by Phase 1's T35 (which includes `commsIndexPath → index.jsonl`); no second copy is added.
>
> **Path note:** every file path below is absolute. The repo root is `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney` (referred to as `<ROOT>`).

---

### Task 25: Create `lib/comms_state.js` (state.json + watermark read/write helpers)

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/comms_state.js`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (append `T44`)

> This file owns the **read side used by the hook** (`readState`, `readSeen`, `accountStatuses`) plus the small writers the MCP/provider call (`setAccountStatus`, `setSeen`). The hook is fs-only and cannot call MCP tools, so connection state lives in files the MCP writes (spec §6.3).

- [ ] **Step 1: Write the failing test.** Append after the last Phase-1 block (T43) in `run-synthetic.sh`:

````bash
# ============================================================================
# Phase 5: comms init-gate, idempotent gitignore, state files, slash commands
# ============================================================================

# ---- T44: comms_state writers + read side used by the hook ------------------
echo
echo "T44 — comms_state: setAccountStatus + setSeen + read side"
C44REPO="$(mktemp -d -t continuum-synth-c44.XXXXXX)"
mkdir -p "$C44REPO/.continuum/comms"
T44_OUT=$(node -e "
import('$PLUGIN_DIR/lib/comms_state.js').then((m) => {
  const d = '$C44REPO';
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
  const emptySt = m.readState('/tmp/no-such-dir-c44');
  const emptySeen = m.readSeen('/tmp/no-such-dir-c44');
  const empty_ok = JSON.stringify(emptySt)==='{}' && JSON.stringify(emptySeen)==='{}';
  console.log((status_ok && flat_ok && seen_ok && empty_ok) ? 'STATE OK'
    : 'STATE BAD st='+status_ok+' flat='+flat_ok+' seen='+seen_ok+' empty='+empty_ok);
}).catch(e => console.log('STATE THREW', e.message));
")
echo "$T44_OUT" | grep -qF "STATE OK" && ok "comms_state writers + read side correct" || { fail "comms_state: $T44_OUT"; }
rm -rf "$C44REPO"
````

- [ ] **Step 2: Run test to verify it fails.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A1 "T44"
  ```
  Expected failure: `✗ comms_state: STATE THREW Cannot find module …/lib/comms_state.js`.

- [ ] **Step 3: Write minimal implementation.** Create `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/comms_state.js`:

```javascript
import fs from "node:fs";
import path from "node:path";
import { commsDir, commsStatePath, commsSeenPath } from "./paths.js";

// Runtime state files the comms MCP writes and the fs-only init hook reads
// (spec §6.3):
//   state.json              { "<provider>": { "<accountId>": { status, updatedAt } } }
//   .last-session-seen.json { "<provider>/<accountId>/<chatId>": newestTs }
// status ∈ "connected" | "needs_login" | "logged_out".

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(dir, file, obj) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ── read side (hook uses these) ──────────────────────────────────────────────
export function readState(projectDir) {
  return readJsonSafe(commsStatePath(projectDir), {});
}

export function readSeen(projectDir) {
  return readJsonSafe(commsSeenPath(projectDir), {});
}

// Flatten state.json into [{provider, accountId, status, updatedAt}] for the
// hook's onboarding/freshness branches.
export function accountStatuses(state) {
  const out = [];
  for (const provider of Object.keys(state || {})) {
    const accounts = state[provider] || {};
    for (const accountId of Object.keys(accounts)) {
      const rec = accounts[accountId] || {};
      out.push({
        provider,
        accountId,
        status: rec.status ?? "needs_login",
        updatedAt: rec.updatedAt ?? null,
      });
    }
  }
  return out;
}

// ── write side (MCP/provider call these) ─────────────────────────────────────
export function setAccountStatus(projectDir, provider, accountId, status) {
  const state = readState(projectDir);
  if (!state[provider]) state[provider] = {};
  state[provider][accountId] = { status, updatedAt: Math.floor(Date.now() / 1000) };
  writeJsonAtomic(commsDir(projectDir), commsStatePath(projectDir), state);
  return state;
}

export function setSeen(projectDir, provider, accountId, chatId, newestTs) {
  const seen = readSeen(projectDir);
  seen[`${provider}/${accountId}/${chatId}`] = newestTs;
  writeJsonAtomic(commsDir(projectDir), commsSeenPath(projectDir), seen);
  return seen;
}
```

- [ ] **Step 4: Run test to verify it passes.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep "T44\|comms_state writers"
  ```
  Expected: `✓ comms_state writers + read side correct`.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/lib/comms_state.js plugins/continuum/tests/run-synthetic.sh
  git commit -m "feat(comms): comms_state.js — state.json + watermark read/write helpers (T44)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 26: Make the `.gitignore` writer an idempotent appender (+ comms lines)

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js` (the gitignore block at **L192-208**, and the misleading "(idempotent)" comment at **L192**)
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (append `T45`)

> This is the security-critical B2 fix (spec §9.5): the current writer creates `.continuum/.gitignore` **only if absent** (L197 `if (!fs.existsSync(giPath))`), so existing repos never gain the comms ignores and would commit auth creds + private messages.

- [ ] **Step 1: Write the failing test.** Append after T44 in `run-synthetic.sh`:

````bash
# ---- T45: session_start appends comms ignores to a PRE-EXISTING .gitignore ---
echo
echo "T45 — gitignore writer is idempotent-append (comms lines added to existing file)"
G45REPO="$(mktemp -d -t continuum-synth-g45.XXXXXX)"
git -C "$G45REPO" init -q
# Pre-existing .continuum/.gitignore WITHOUT the comms lines (simulates a repo
# bootstrapped before this change). Must keep its old lines AND gain comms ones.
mkdir -p "$G45REPO/.continuum"
printf '%s\n' "# Auto-written by continuum. Transient / page-derived data — do not commit." "verification/" "runs/" > "$G45REPO/.continuum/.gitignore"
run_hook hooks/session_start.js "{\"session_id\":\"sg45\",\"cwd\":\"$G45REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" > /dev/null
GI="$G45REPO/.continuum/.gitignore"
grep -qxF "comms/*" "$GI" && ok "comms/* present after append" || fail "comms/* missing from existing .gitignore"
grep -qxF "!comms/config.json" "$GI" && ok "!comms/config.json exception present" || fail "config.json exception missing"
grep -qxF "verification/" "$GI" && ok "pre-existing lines preserved" || fail "pre-existing lines clobbered"
# Idempotency: a SECOND session must not duplicate the comms lines.
run_hook hooks/session_start.js "{\"session_id\":\"sg45b\",\"cwd\":\"$G45REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" > /dev/null
DUP=$(grep -cxF "comms/*" "$GI")
[ "$DUP" = "1" ] && ok "comms/* not duplicated on 2nd run" || fail "comms/* duplicated ($DUP times)"
rm -rf "$G45REPO"
````

- [ ] **Step 2: Run test to verify it fails.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A4 "T45"
  ```
  Expected failure: `✗ comms/* missing from existing .gitignore` (the existing `if (!fs.existsSync(giPath))` short-circuits because the file already exists).

- [ ] **Step 3: Write minimal implementation.** In `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js`, replace the entire block at L192-208 (from the `// Protective .gitignore (idempotent):` comment through the closing `}` of the `if (!fs.existsSync(giPath)) { … }`):

  Replace this exact text:
```javascript
    // Protective .gitignore (idempotent): the verification ledger, provenance,
    // uploads, runs and screenshots can contain page-derived data (control
    // labels, response bodies, secrets seeded for testing) and should not be
    // committed. The chain itself (chain/, STATE.md) is intentionally NOT ignored.
    const giPath = path.join(p.root, ".gitignore");
    if (!fs.existsSync(giPath)) {
      fs.writeFileSync(giPath, [
        "# Auto-written by continuum. Transient / page-derived data — do not commit.",
        "# The chain (chain/, STATE.md) is intentionally tracked and NOT ignored.",
        "verification/",
        "runs/",
        "uploads/",
        "screenshots/",
        ".env-provenance.json",
        "",
      ].join("\n"));
    }
```

  With:
```javascript
    // Protective .gitignore (idempotent APPENDER — B2 fix): the verification
    // ledger, provenance, uploads, runs and screenshots can contain page-derived
    // data (control labels, response bodies, secrets seeded for testing); the
    // comms/ tree holds WhatsApp auth creds + private messages. None of it may be
    // committed. The chain (chain/, STATE.md) and comms/config.json are
    // intentionally tracked. This MUST append missing lines to an existing
    // .gitignore (not just create-if-absent), so repos bootstrapped before comms
    // shipped still gain the comms ignores. Paths are relative to .continuum/.
    const giPath = path.join(p.root, ".gitignore");
    const giHeader = [
      "# Auto-written by continuum. Transient / page-derived data — do not commit.",
      "# The chain (chain/, STATE.md) and comms/config.json are intentionally tracked.",
    ];
    const giWanted = [
      "verification/",
      "runs/",
      "uploads/",
      "screenshots/",
      ".env-provenance.json",
      "comms/*",
      "!comms/config.json",
    ];
    let giExisting = [];
    try {
      if (fs.existsSync(giPath)) {
        giExisting = fs.readFileSync(giPath, "utf8").split("\n");
      }
    } catch {}
    const giHave = new Set(giExisting.map((l) => l.trim()));
    if (giExisting.length === 0) {
      // Fresh file: header + all wanted lines + trailing newline.
      fs.writeFileSync(giPath, [...giHeader, ...giWanted, ""].join("\n"));
    } else {
      // Existing file: append only the wanted lines that are missing.
      const toAdd = giWanted.filter((l) => !giHave.has(l));
      if (toAdd.length > 0) {
        const base = fs.readFileSync(giPath, "utf8");
        const sep = base.endsWith("\n") || base.length === 0 ? "" : "\n";
        fs.writeFileSync(giPath, base + sep + toAdd.join("\n") + "\n");
      }
    }
```

- [ ] **Step 4: Run test to verify it passes.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep "T45\|comms/\*\|exception present\|pre-existing lines\|duplicated"
  ```
  Expected: all four T45 assertions green (`✓ comms/* present after append`, `✓ !comms/config.json exception present`, `✓ pre-existing lines preserved`, `✓ comms/* not duplicated on 2nd run`). Also re-run the full suite to confirm no regression in T1 (which checks the bootstrap path still works):
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | tail -5
  ```
  Expected: `failed: 0`.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/hooks/session_start.js plugins/continuum/tests/run-synthetic.sh
  git commit -m "fix(comms): idempotent .gitignore appender + comms/* ignore w/ config.json exception (B2, T45)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 27: Refactor `session_start.js` to a SINGLE terminal `emitContext` (bootstrap appends)

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js` (the `emitContext` helper L58-67; the bootstrap branch at **L249-252**; build the `context` accumulator through L264)
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (append `T46`)

> B3 fix (spec §8): today the `!isBootstrapped` branch does `emitContext(bootstrapDirective(...)); return;` at L249-252. `emitContext` itself calls `process.exit(0)` (L66). That early exit makes any later comms directive unreachable on the **first** session. We make `emitContext` no longer exit, accumulate everything into one `context` string, and emit exactly once at the end.

- [ ] **Step 1: Write the failing test.** Append after T45 in `run-synthetic.sh`:

````bash
# ---- T46: first-session single-emit — bootstrap directive still emitted ------
echo
echo "T46 — single terminal emit: bootstrap directive present on a fresh repo, exactly one JSON object"
F46REPO="$(mktemp -d -t continuum-synth-f46.XXXXXX)"
git -C "$F46REPO" init -q
F46_OUT="$(run_hook hooks/session_start.js "{\"session_id\":\"sf46\",\"cwd\":\"$F46REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
# Exactly one hookSpecificOutput object on stdout (no double-emit from a leftover early path):
EMITS=$(echo "$F46_OUT" | grep -oF '"hookSpecificOutput"' | wc -l | tr -d ' ')
[ "$EMITS" = "1" ] && ok "exactly one emit on first session" || fail "expected 1 emit got $EMITS"
F46_CTX="$(echo "$F46_OUT" | extract_ctx)"
echo "$F46_CTX" | grep -q "No context chain" && ok "bootstrap directive still present via accumulator" || fail "bootstrap directive lost in refactor"
rm -rf "$F46REPO"
````

- [ ] **Step 2: Run test to verify it fails.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A2 "T46"
  ```
  Expected: T46 currently **passes** by accident (the legacy early-emit also produces one object with the directive). This step's value is the guard: it must still pass after the refactor. Run it now and confirm `✓ exactly one emit on first session` + `✓ bootstrap directive still present`. (If it already passes, proceed — Step 4 re-runs it post-refactor as the real assertion.)

> TDD note: the failing-first signal for this refactor is structural, not in T46 alone — it's that the **comms ASK gate (Task 28, T47)** cannot reach the same emit as bootstrap until this refactor lands. T46 locks the invariant "one emit, directive preserved" so the refactor can't regress it. Treat T47 (next task) as the red test that forces this refactor's correctness.

- [ ] **Step 3: Write minimal implementation.** Two edits in `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js`:

  **(a)** Make `emitContext` not exit, and add a terminal emitter. Replace L58-67:
```javascript
function emitContext(text) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
```
  With:
```javascript
// Build (do NOT emit) the SessionStart additionalContext payload, so callers
// can accumulate context and emit exactly once. emitContextOnce() is the single
// terminal writer used at the end of main() (B3 fix — no early emit+exit).
function buildContextOutput(text) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  };
}

function emitContextOnce(text) {
  process.stdout.write(JSON.stringify(buildContextOutput(text)));
  process.exit(0);
}
```

  **(b)** Replace the bootstrap branch + tail assembly. Replace L249-264 (from `if (!isBootstrapped(projectDir)) {` through the final `emitContext(context);`):
```javascript
  if (!isBootstrapped(projectDir)) {
    emitContext(bootstrapDirective(projectDir));
    return;
  }

  let context = buildLoadedContext(projectDir, cfg);

  const sentinel = readSentinel(projectDir);
  if (sentinel) {
    const trigger = sentinel.trigger || "?";
    const why = sentinel.matcher || sentinel.why_session_ended || "?";
    const archive = sentinel.archive_path || "(no archive recorded)";
    context += `\n\n---\n\n**⚠ Pending checkpoint detected.** Previous session ended via \`${trigger}\` (${why}). Raw transcript was archived to:\n\n\`${archive}\`\n\nIf the last session changed decisions or surfaced new threads, run \`/continuum:checkpoint\` now — read the archive with \`zcat\` if you need to recover detail. The sentinel clears automatically when a new link is written.`;
  }

  emitContext(context);
```
  With:
```javascript
  // Accumulate everything into ONE context string, emit exactly once at the end
  // (B3 fix). The bootstrap branch APPENDS instead of emitting+exiting early, so
  // the comms gate (below) is reachable even on a fresh repo's first session.
  let context = "";

  if (!isBootstrapped(projectDir)) {
    context += bootstrapDirective(projectDir);
  } else {
    context += buildLoadedContext(projectDir, cfg);

    const sentinel = readSentinel(projectDir);
    if (sentinel) {
      const trigger = sentinel.trigger || "?";
      const why = sentinel.matcher || sentinel.why_session_ended || "?";
      const archive = sentinel.archive_path || "(no archive recorded)";
      context += `\n\n---\n\n**⚠ Pending checkpoint detected.** Previous session ended via \`${trigger}\` (${why}). Raw transcript was archived to:\n\n\`${archive}\`\n\nIf the last session changed decisions or surfaced new threads, run \`/continuum:checkpoint\` now — read the archive with \`zcat\` if you need to recover detail. The sentinel clears automatically when a new link is written.`;
    }
  }

  // Comms init / onboarding / freshness gate (spec §8) is appended here, before
  // the single emit. (Added in the next task.)
  context += commsGate(projectDir, payload.source);

  emitContextOnce(context);
```

> Note: `commsGate` is referenced here but defined in Task 28. To keep this task's tests green standalone, add a **temporary stub** above `main()` for this commit only: `function commsGate() { return ""; }`. Task 28 replaces the stub with the real implementation (its test T47 then drives the real behavior). The stub keeps all prior tests green between commits.

  Add this stub immediately after `computeDefaultSessionName` (after L174):
```javascript
// Temporary stub — replaced by the real comms gate in the next task.
function commsGate() {
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | tail -5
  ```
  Expected: `failed: 0`. Specifically T1 (bootstrap directive), T4/T6/T18 (loaded chain + sentinel), and T46 (single emit) all green.

> Implementation check: after the edit, `emitContext` is **no longer defined** (renamed to `emitContextOnce`/`buildContextOutput`). Grep for any leftover `emitContext(` call site and convert it. Verify with:
> ```
> grep -n "emitContext\b" /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js
> ```
> Expected: zero matches for the bare `emitContext(` (only `emitContextOnce`).

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/hooks/session_start.js plugins/continuum/tests/run-synthetic.sh
  git commit -m "refactor(comms): single terminal emit in session_start; bootstrap appends (B3, T46)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 28: Implement the comms ASK / ONBOARD / freshness gate (source-aware, fs-only)

**Files:**
- Modify: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js` (replace the `commsGate` stub from Task 27; add imports near L7-17)
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (append `T47`)

> Spec §8: the gate reads `comms_config` + `state.json` + `.last-session-seen.json` (fs only). Branches: undecided → ASK **only on `startup`/`clear`** (silent on `resume`/`compact`); declined → silent; decided + an account `needs_login`/`logged_out` → ONBOARD; decided + connected → freshness note.

- [ ] **Step 1: Write the failing test.** Append after T46 in `run-synthetic.sh`:

````bash
# ---- T47: comms gate branches (ASK source-aware / declined / onboard / fresh) -
echo
echo "T47 — comms gate: ASK on startup, silent on resume, declined silent, onboard, freshness"
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
# (b) undecided + resume → silent (no ASK)
gate_ctx "$GA" resume | grep -q "hasn't decided about communication-channel sync" && fail "ASK wrongly emitted on resume" || ok "silent on resume when undecided"
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
````

- [ ] **Step 2: Run test to verify it fails.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A8 "T47"
  ```
  Expected failure: `✗ ASK missing on startup` (and onboard/freshness fails) — the `commsGate` stub returns `""`.

- [ ] **Step 3: Write minimal implementation.** Two edits in `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js`:

  **(a)** Add imports. The existing import block is L7-17. Add these import statements right after the existing `../lib/paths.js` import block. (`commsConfigPath`/`commsCursorPath` are already exported from `paths.js` per Phase 1 — fold them into the existing `from "../lib/paths.js"` import if the bundler/linter objects to a second import from the same module.)
```javascript
import { readConfig as readCommsConfig } from "../lib/comms_config.js";
import {
  readState as readCommsState,
  readSeen as readCommsSeen,
  accountStatuses,
} from "../lib/comms_state.js";
import {
  commsConfigPath,
  commsCursorPath,
} from "../lib/paths.js";
```

  **(b)** Replace the stub:
```javascript
// Temporary stub — replaced by the real comms gate in the next task.
function commsGate() {
  return "";
}
```
  With the real gate:
```javascript
// Comms init / onboarding / freshness gate (spec §8). fs-only — the hook can't
// call MCP tools, so all state comes from files the comms MCP writes:
// comms/config.json (+ config.local.json), state.json, .last-session-seen.json.
// Returns a string to APPEND to the single context accumulator ("" = silent).
function commsGate(projectDir, source) {
  let out = "";
  let cfg;
  try {
    cfg = readCommsConfig(projectDir);
  } catch {
    return ""; // never let the comms gate break SessionStart
  }

  // 1) Undecided → ASK, but only on a real init (startup/clear). Staying silent
  //    on resume/compact avoids re-nagging after a verbal "yes" that hasn't been
  //    written to config yet.
  if (!cfg.decided) {
    if (source === "startup" || source === "clear") {
      out +=
        "\n\n---\n\n" +
        "[continuum:comms] This repo hasn't decided about communication-channel sync. " +
        'Ask the user, once: *"Do you want this repo to sync a communication channel ' +
        '(e.g. WhatsApp) so I can recall its messages? (yes/no)"* — On **no**, immediately ' +
        "write `.continuum/comms/config.json` = `{\"version\":1,\"decided\":true,\"declined\":true}` " +
        "so I never ask again. On **yes**, immediately write " +
        "`{\"version\":1,\"decided\":true,\"declined\":false}` (no provider yet) **before** anything " +
        "else, then run `/mochi:comms-setup`. Always write the answer to config the moment it's given.";
    }
    return out; // undecided: nothing else to say
  }

  // 2) Declined → silent forever.
  if (cfg.declined) return out;

  // 3) Decided + enabled: gather configured accounts and their link status.
  let state = {};
  try {
    state = readCommsState(projectDir);
  } catch {}
  const statuses = accountStatuses(state); // [{provider, accountId, status, ...}]

  // Configured accounts (from config.providers) — the source of truth for "what
  // SHOULD be linked". An account configured but absent from state.json, or with
  // a non-connected status, needs onboarding.
  const configured = [];
  const providers = cfg.providers || {};
  for (const provider of Object.keys(providers)) {
    const accounts = (providers[provider] || {}).accounts || {};
    for (const accountId of Object.keys(accounts)) {
      configured.push({ provider, accountId });
    }
  }

  const statusOf = (provider, accountId) => {
    const hit = statuses.find(
      (s) => s.provider === provider && s.accountId === accountId
    );
    return hit ? hit.status : "needs_login";
  };

  const needsLogin = configured.filter(
    (c) => statusOf(c.provider, c.accountId) !== "connected"
  );

  // If the user said yes but never finished setup (no providers configured), or
  // a configured account isn't connected, point them at onboarding.
  if (configured.length === 0 || needsLogin.length > 0) {
    out +=
      "\n\n---\n\n" +
      "[continuum:comms] Channel sync is enabled for this repo but " +
      (configured.length === 0
        ? "no provider is linked yet. "
        : `${needsLogin.length} account(s) need login (` +
          needsLogin.map((c) => `${c.provider}/${c.accountId}`).join(", ") +
          "). ") +
      "Run `/mochi:comms-setup` to finish linking.";
    return out;
  }

  // 4) Decided + all connected → freshness note (best-effort). Diff each
  //    allowlisted chat's cursor.newestTs against the watermark.
  let seen = {};
  try {
    seen = readCommsSeen(projectDir);
  } catch {}

  let totalNew = 0;
  const freshChats = [];
  for (const provider of Object.keys(providers)) {
    const accounts = (providers[provider] || {}).accounts || {};
    for (const accountId of Object.keys(accounts)) {
      const allowed = accounts[accountId].allowed_jids || [];
      for (const chatId of allowed) {
        let newestTs = null;
        try {
          const cur = JSON.parse(
            fs.readFileSync(
              commsCursorPath(projectDir, provider, accountId, chatId),
              "utf8"
            )
          );
          newestTs = typeof cur.newestTs === "number" ? cur.newestTs : null;
        } catch {}
        if (newestTs == null) continue;
        const watermark = seen[`${provider}/${accountId}/${chatId}`] ?? 0;
        if (newestTs > watermark) {
          totalNew += 1;
          freshChats.push(`${provider}/${accountId}/${chatId}`);
        }
      }
    }
  }

  if (freshChats.length > 0) {
    out +=
      "\n\n---\n\n" +
      `[continuum:comms] You have new message activity since you last looked in ${freshChats.length} ` +
      `chat(s): ${freshChats.join(", ")}. Use \`/mochi:comms-recall\` or \`/mochi:comms-status\` to review.`;
  }
  // If state.json was absent (degrade) or nothing new, stay silent.
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A8 "T47"
  ```
  Expected: all T47 assertions green (ASK on startup, silent on resume, declined → no ASK / no onboard, onboard on needs_login, freshness note). Then full-suite check:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | tail -5
  ```
  Expected: `failed: 0`. (T4/T18 use `source:"resume"` with no comms config → the gate stays silent, so those assertions are unaffected.)

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/hooks/session_start.js plugins/continuum/tests/run-synthetic.sh
  git commit -m "feat(comms): source-aware ASK/ONBOARD/freshness init gate in session_start (§8, T47)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 29: Add the five `/mochi:comms-*` slash commands

**Files:**
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-setup.md`
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-sync.md`
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-recall.md`
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-import.md`
- Create: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-status.md`
- Test: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (append `T48`; **verify T29 invariant**)

> These are MCP-tool-driven (they call `mcp__plugin_mochi_comms__*`), not Bash-helper-driven, so they deliberately do **not** use `cat .continuum/.plugin-root` and must avoid `$CLAUDE_PLUGIN_ROOT` / `${CLAUDE_SKILL_DIR}` (the existing T29 invariant). T29 asserts exactly 7 commands use `.plugin-root`; adding 5 MCP-driven commands keeps that count at 7 (the new ones don't use it) while T29's two "no unexpanded env var" checks still cover the new files.

- [ ] **Step 1: Write the failing test + verify T29.** First, in `run-synthetic.sh`, the existing T29 block globs `commands/*.md`; its two "no env var" assertions automatically include the new files, and its `USES = 7` assertion stays 7 (new commands don't use `.plugin-root`). **No T29 edit is needed** — confirm by reading the T29 block that the comparison is `[ "$USES" = "7" ]`; only bump that number if a future comms command needs `.plugin-root` (it won't).

  Append a new T48 block after T47 in `run-synthetic.sh`:

````bash
# ---- T48: comms slash commands exist, are MCP-driven, env-var-clean ----------
echo
echo "T48 — /mochi:comms-* command files present, well-formed, no unexpanded env vars"
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
````

- [ ] **Step 2: Run test to verify it fails.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A6 "T48"
  ```
  Expected failure: `✗ comms-setup.md missing` (and the rest) — the command files don't exist yet.

- [ ] **Step 3: Write minimal implementation.** Create the five files.

  `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-setup.md`:
```markdown
---
description: Link a communication channel (WhatsApp first) to this repo — agent-driven QR / pairing-code onboarding, then pick which chats to sync
allowed-tools: mcp__plugin_mochi_comms__comms_link_account, mcp__plugin_mochi_comms__comms_account_status, mcp__plugin_mochi_comms__comms_list_groups, mcp__plugin_mochi_comms__comms_list_chats, mcp__plugin_mochi_comms__comms_set_allowlist, mcp__plugin_mochi_comms__comms_sync_now, AskUserQuestion
argument-hint: [provider] (default whatsapp)
---

Onboard a communication channel for THIS repo. The provider defaults to `whatsapp`. Drive the `mcp__plugin_mochi_comms__*` tools; do not shell out.

**1. ToS warning + consent (required gate).** Tell the user verbatim, then wait for a yes:
> This uses an *unofficial* WhatsApp connection. It violates WhatsApp's ToS and the number can be banned, sometimes within weeks. Use a non-primary number. Proceed?

If they decline, stop and write nothing.

**2. Start login.** Call `comms_link_account({provider, accountId, phone?})`.
- `accountId` is a short label the user picks (e.g. `work`). Ask if unspecified.
- If the user gives a `phone`, you get an 8-char **pairing code** (requested once — never loop on 429).
- Otherwise you get a **QR** (PNG data-URL + ASCII). Show the ASCII QR for the user to scan.

**3. Wait for connection.** Poll `comms_account_status({provider, accountId})` until `connected`. The first connect may trigger an internal 515 restart — keep polling a few times before giving up.

**4. Pick chats for this repo.** Call `comms_list_groups` and `comms_list_chats`, present them, and let the user choose which chats/groups this repo should sync. Only chosen chats are ever captured (strict allowlist).

**5. Save the allowlist.** Call `comms_set_allowlist({provider, accountId, allowed_jids})`. This **merges** into the allowlist and flips config to `decided:true, declined:false`. Newly-allowlisted chats auto-attempt history backfill.

**6. Initial sync.** Call `comms_sync_now({provider, accountId})`. Then offer `/mochi:comms-import` for older history WhatsApp didn't ship at login.

Report a concise summary (account, linked status, chats synced). Do not dump message bodies.
```

  `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-sync.md`:
```markdown
---
description: Force a connect + backfill pass for a linked communication channel (catches up live + best-effort history)
allowed-tools: mcp__plugin_mochi_comms__comms_account_status, mcp__plugin_mochi_comms__comms_sync_now
argument-hint: [provider] [accountId]
---

Force a sync for a linked channel. Provider defaults to `whatsapp`; if `accountId` is omitted and only one account is linked, use it — otherwise ask which.

1. Call `comms_account_status({provider, accountId})`. If not `connected`, tell the user to run `/mochi:comms-setup` and stop.
2. Call `comms_sync_now({provider, accountId})` to trigger a connect + best-effort backfill pass.

Report what changed at a high level (e.g. "synced; N chats updated"). Backfill depth is decided by WhatsApp's servers, not us — say so honestly if little history arrives, and point to `/mochi:comms-import` for older messages. Do not print message bodies.
```

  `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-recall.md`:
```markdown
---
description: Search this repo's synced channel messages by keyword and return scored snippets (never the whole history)
allowed-tools: mcp__plugin_mochi_comms__comms_recall, mcp__plugin_mochi_comms__comms_get_messages
argument-hint: <query words> [--chat <chatId>] [--since <iso>] [--until <iso>]
---

Search the per-repo communication store and show the user the matched snippets verbatim. The query is `$ARGUMENTS`.

1. Call `comms_recall({query, provider?, accountId?, chatId?, since?, until?, limit?})`. Pass any `--chat` / `--since` / `--until` the user supplied. Leave `limit` unset to use the server default (≤200, server-clamped — never request more to "see everything").
2. Each hit returns `chatId`, `tsIso`, `senderName`, a short excerpt, and a `msgId` handle.

Show the hits as a compact list. If the user wants more context around a hit, call `comms_get_messages({provider, accountId, chatId, anchor: <msgId>})` for a bounded window. Do **not** bulk-dump the store — recall returns slices on purpose. Do not re-summarize unless asked.
```

  `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-import.md`:
```markdown
---
description: Back-fill old history from a WhatsApp "Export chat" .txt file — parsed, normalized, and reconciled into this repo's timeline by content fingerprint
allowed-tools: mcp__plugin_mochi_comms__comms_import_history, mcp__plugin_mochi_comms__comms_list_chats
argument-hint: <chatId> <path-to-export.txt> [provider] [accountId]
---

Import an exported chat to fill history gaps. The user exports a chat from WhatsApp (`Export chat` → without media or with media) and gives the `.txt` path.

1. Confirm the target `chatId` (run `comms_list_chats` to resolve a name → JID if the user gave a name). The chat must already be on this repo's allowlist.
2. Call `comms_import_history({provider, accountId, chatId, filePath})`.
   - The importer parses each line, normalizes it to the shared message shape, and reconciles by fingerprint — re-importing the same file is idempotent (no duplicates), and live/backfill records win over imported ones for the same content.
   - WhatsApp exports are **minute-resolution**, so imported timestamps are less precise than live capture; that's a documented limitation.

Report counts (`added` vs `merged`). Do not print message bodies. Order is reconstructed at read time, so imported old messages slot correctly into the timeline.
```

  `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/commands/comms-status.md`:
```markdown
---
description: Show this repo's communication-channel link status, allowlisted chats, and message counts
allowed-tools: mcp__plugin_mochi_comms__comms_account_status, mcp__plugin_mochi_comms__comms_list_chats
argument-hint: [provider] [accountId]
---

Report the comms sync health for this repo. Provider defaults to `whatsapp`.

1. For each linked account in `.continuum/comms/config.json`, call `comms_account_status({provider, accountId})` and report `connected` / `needs_login` / `logged_out`.
2. Call `comms_list_chats({provider, accountId})` to show the allowlisted chats and their latest activity.

Present a compact status table: account, link status, chats synced, newest message time per chat. If an account shows `needs_login` or `logged_out`, tell the user to run `/mochi:comms-setup`. Do not print message bodies — this is a health summary only.
```

- [ ] **Step 4: Run test to verify it passes.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A6 "T48"
  ```
  Expected: all T48 assertions green. Then confirm T29 still passes (the new files don't break the env-var or `.plugin-root`-count invariants):
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A4 "T29"
  ```
  Expected: `✓ no command uses $CLAUDE_PLUGIN_ROOT`, `✓ no command uses ${CLAUDE_SKILL_DIR}`, `✓ all 7 commands use .continuum/.plugin-root`. Full suite:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | tail -5
  ```
  Expected: `failed: 0`.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/commands/comms-setup.md plugins/continuum/commands/comms-sync.md plugins/continuum/commands/comms-recall.md plugins/continuum/commands/comms-import.md plugins/continuum/commands/comms-status.md plugins/continuum/tests/run-synthetic.sh
  git commit -m "feat(comms): /mochi:comms-{setup,sync,recall,import,status} slash commands (T48)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 30: End-to-end first-session reachability (bootstrap + ASK in one emit)

**Files:**
- Test only: `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh` (append `T49`)
- No source change — this locks the B3 acceptance criterion from spec §8 ("step 0 appends bootstrapDirective, step 1 appends ASK_DIRECTIVE, the single terminal emit emits **both, bootstrap first then comms ASK**").

> The earlier tasks proved the pieces; this proves the **combination** on a truly fresh repo (un-bootstrapped **and** undecided), which is exactly the case the old early-emit broke.

- [ ] **Step 1: Write the failing test.** Append after T48 in `run-synthetic.sh`:

````bash
# ---- T49: fresh repo first session emits BOTH bootstrap AND comms ASK, ordered
echo
echo "T49 — first session on fresh repo: bootstrap directive THEN comms ASK, single emit"
F49REPO="$(mktemp -d -t continuum-synth-f49.XXXXXX)"
git -C "$F49REPO" init -q
F49_OUT="$(run_hook hooks/session_start.js "{\"session_id\":\"sf49\",\"cwd\":\"$F49REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
EMITS49=$(echo "$F49_OUT" | grep -oF '"hookSpecificOutput"' | wc -l | tr -d ' ')
[ "$EMITS49" = "1" ] && ok "single emit" || fail "expected 1 emit got $EMITS49"
F49_CTX="$(echo "$F49_OUT" | extract_ctx)"
echo "$F49_CTX" | grep -q "No context chain" && ok "bootstrap directive present" || fail "bootstrap directive missing"
echo "$F49_CTX" | grep -q "hasn't decided about communication-channel sync" && ok "comms ASK present" || fail "comms ASK missing (B3 regression)"
# Ordering: bootstrap appears before the comms ASK in the single string.
BPOS=$(echo "$F49_CTX" | grep -n "No context chain" | head -1 | cut -d: -f1)
APOS=$(echo "$F49_CTX" | grep -n "hasn't decided about communication-channel sync" | head -1 | cut -d: -f1)
[ -n "$BPOS" ] && [ -n "$APOS" ] && [ "$BPOS" -lt "$APOS" ] && ok "bootstrap precedes comms ASK" || fail "ordering wrong (bootstrap=$BPOS ask=$APOS)"
rm -rf "$F49REPO"
````

- [ ] **Step 2: Run test to verify it fails (or proves the fix).** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A4 "T49"
  ```
  Expected: with Tasks 27-28 already landed, T49 **passes**. To prove it's a real guard against the original bug, temporarily revert just the bootstrap branch in `session_start.js` to the old `emitContext(bootstrapDirective(projectDir)); return;` (early exit), re-run, and confirm `✗ comms ASK missing (B3 regression)`. Then restore the fix. (This is the red→green demonstration for the integration-level invariant.)

- [ ] **Step 3: Write minimal implementation.** None — Tasks 27 and 28 already implement this. This task only adds the integration test. (If T49 fails at Step 2 without a deliberate revert, fix `commsGate`/the accumulator until green.)

- [ ] **Step 4: Run test to verify it passes.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | grep -A4 "T49"; bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh 2>&1 | tail -5
  ```
  Expected: T49 four assertions green; suite `failed: 0`.

- [ ] **Step 5: Commit.**
  ```
  git add plugins/continuum/tests/run-synthetic.sh
  git commit -m "test(comms): first-session reachability — bootstrap + comms ASK in one emit (B3, T49)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 31: Full-suite green gate (no regression across all tests)

**Files:**
- Test only: run the whole harness; fix any regression surfaced.

- [ ] **Step 1: Write the failing test.** No new test — this is the existing suite as the gate. (Phase 1 added T35–T43; Phase 5 added T44–T49.)

- [ ] **Step 2: Run the full suite.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh; echo "exit=$?"
  ```
  Expected: the summary block prints `passed: <N>` / `failed: 0` and `exit=0`.

- [ ] **Step 3: Fix regressions (if any).** If T4/T6/T18 (loaded-chain + sentinel) broke, the most likely cause is the Task-27 emit refactor leaving a stray `emitContext(` call. Verify with:
  ```
  grep -n "emitContext\b" /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/hooks/session_start.js
  ```
  Expected: only `emitContextOnce` / `buildContextOutput`, zero bare `emitContext(`.

- [ ] **Step 4: Re-run to confirm green.** Command:
  ```
  bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh; echo "exit=$?"
  ```
  Expected: `exit=0`, `failed: 0`.

- [ ] **Step 5: Commit (only if Step 3 changed source).**
  ```
  git add plugins/continuum/hooks/session_start.js
  git commit -m "fix(comms): resolve session_start regressions after Phase 5 emit refactor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
  (If no source changed, skip the commit — the suite is already green from Task 30.)

---

**Phase 5 deliverables recap (all under `<ROOT>/plugins/continuum/`):**
- `lib/comms_state.js` — read side for the hook (`readState`, `readSeen`, `accountStatuses`) + writers the MCP/provider call (`setAccountStatus`, `setSeen`).
- `hooks/session_start.js` — single terminal `emitContextOnce` (bootstrap appends, no early exit); idempotent `.gitignore` appender adding `comms/*` + `!comms/config.json`; source-aware `commsGate` (ASK/ONBOARD/freshness).
- `commands/comms-setup.md`, `comms-sync.md`, `comms-recall.md`, `comms-import.md`, `comms-status.md` — MCP-tool-driven slash commands (Claude Code auto-discovers `commands/*.md`).
- `tests/run-synthetic.sh` — T44–T49 appended; T29 invariants preserved (7 `.plugin-root` commands; comms commands env-var-clean).
- (paths.js comms helpers + `comms_config.js` are delivered by **Phase 1**, not re-created here.)

## Done when

The feature ships when ALL of the following gating acceptance criteria pass (run from the repo root `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney`):

- [ ] **All continuum unit + hook tests pass.** `bash plugins/continuum/tests/run-synthetic.sh` exits 0 with `failed: 0` — including the new comms data-layer/state/gate/command tests (T35–T49) and zero regression in the pre-existing recall/hook tests (T1–T34).
- [ ] **Scoring + comms-recall unit suites pass.** `bash plugins/continuum/tests/run-scoring.sh` and `bash plugins/continuum/tests/run-comms-recall.sh` each exit 0 with `failed: 0`, proving the scoring extraction left `recall()` behavior unchanged and comms recall reuses the same primitives under §10 shape + §4.3 caps.
- [ ] **All server tests pass under the gate.** `cd server && npm test` exits 0 with every comms suite green (`_comms_normalize`, `_comms_provider`, `_comms_wa_lock`, `_comms_wa_capture`, `_comms_wa_lifecycle`, `_comms_server`, `_comms_smoke`, `_comms_build_config`, `_comms_mcp_entry`, `_comms_ci_verify`, `_comms_bundle_smoke`).
- [ ] **Bundle smoke test passes (§12).** `cd server && npm run build && node _comms_bundle_smoke.test.mjs` exits 0: `comms.bundle.mjs` builds, boots under bare `node` (cwd = tmp, no resolvable `node_modules`), answers `initialize` + `tools/list` over stdio with all 10 §10 tools, and the pinned `@whiskeysockets/baileys@6.7.23` subtree is pure-JS (no `*.node` addons, no install/preinstall/postinstall scripts).
- [ ] **Gitignore security test passes (B2).** The idempotent-appender test (T45) is green: a pre-existing `.continuum/.gitignore` gains `comms/*` + `!comms/config.json` without clobbering prior lines and without duplicating on a second session — so WhatsApp auth creds and private messages under `comms/` can never be committed, while `comms/config.json` stays tracked.
- [ ] **CI verifies both bundles.** `.github/workflows/build.yml` asserts `test -f server/dist/server.bundle.mjs` AND `test -f server/dist/comms.bundle.mjs`; `.mcp.json` registers the `comms` stdio server with `COMMS_PROJECT_DIR=${CLAUDE_PROJECT_DIR}`; both committed bundles are present.
- [ ] **Manual QR-link acceptance.** On a real machine with deps installed, `/mochi:comms-setup` drives a live WhatsApp link: the agent surfaces a scannable QR (or an 8-char pairing code when a phone is given, requested exactly once), `comms_account_status` reaches `connected` (tolerating one internal 515 restart), the user picks chats, `comms_set_allowlist` persists them, and a subsequent allowlisted message is captured into `.continuum/comms/store/...` and is recallable via `/mochi:comms-recall` — with non-allowlisted chats never written.

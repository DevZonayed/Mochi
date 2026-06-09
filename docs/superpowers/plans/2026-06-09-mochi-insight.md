# Mochi Insight (Telemetry) — Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

Goal: Ship opt-in, anonymous, content-free usage telemetry + a local LLM efficiency critique + a self-hosted Node ingest/dashboard on Dokploy, so the developer learns most-used tools/MCPs, confusion points, and constructive improvement advice.

Architecture: plugin-side capture (hooks -> Zone-A JSONL) + send-time-gated emit to a self-hosted ingest at mochi-insight.nexalance.cloud; agent-driven session critique (Zone-B local, Zone-A distillation emitted); deliberate reports reuse /mochi:feedback (GitHub only). Privacy keystone = a fail-closed redactor (key-whitelist + value-enums + third-party bucketing). Spec §13 is authoritative.

Tech: Node 22 ESM, file-based JSONL (no SQLite/native in plugin), esbuild unaffected, dependency-free synthetic tests + node --test for the server. Spec: docs/superpowers/specs/2026-06-09-mochi-insight-telemetry-design.md

## Shared Contracts

> AUTHORITATIVE per spec §13. Use these EXACT names/shapes in every task. Where the original phase drafts diverged, this section is the reconciled canon; any task code that diverges has been fixed to match.

**Zone-A event** — the ONLY thing written locally and the ONLY thing emitted:
```json
{ "ts": 0, "sid": "", "iid": "", "tool": "", "mcp": "", "ok": true, "err": "", "dur_b": "", "v": "", "os": "" }
```
Exact keys: `ts:int, sid:str, iid:str, tool:str, mcp:str, ok:bool, err:str, dur_b:str, v:str, os:str`. **NO `model` field** (§13.6). `err ∈ ERR_ENUM`. `tool`/`mcp` allowlisted-or-bucketed (third-party → `"thirdparty_tool"` / `"thirdparty_mcp"`).

**Arm-2 distillation (Zone-A):**
```json
{ "task_category": "", "tool_calls": 0, "efficiency_score": 0, "redundancy_pattern": "", "suggestion_tag": "", "severity": "" }
```
`suggestion_text` + `quality_issue` are **Zone-B** — NEVER emitted, NEVER whitelisted, even if present in input.

**Enums (shipped in `telemetry_redact.js`; the server copy in `telemetry-server/telemetry_redact.js` is byte-identical). Each categorical enum contains an `"other"` bucket:**
- `ERR_ENUM = ["timeout","not_found","bad_input","permission","network","other"]`
- `TASK_ENUM = ["web-qa","coding","refactor","debug","research","docs","comms","other"]`
- `REDUNDANCY_ENUM = ["snapshot_then_retry","repeated_read","repeated_edit","retry_loop","redundant_navigation","none","other"]`
- `SUGGESTION_ENUM = ["batch_clicks","use_recall","fewer_snapshots","assert_first","narrower_selector","reuse_workflow","none","other"]`
- `SEVERITY_ENUM = ["low","medium","high","other"]`
- `ALLOW_TOOLS` = built-in Claude Code tool names + mochi MCP tool short-names (mcp prefix stripped before lookup). `ALLOW_MCPS = ["mochi_browser","mochi_comms","mochi_continuum","continuum"]`.

**Paths (`plugins/continuum/lib/paths.js`):**
- `telemetryDir(projectDir)` = `.continuum/telemetry`
- `telemetryEventsPath(projectDir)` = `.continuum/telemetry/events.jsonl`
- `telemetryConfigPath(projectDir)` = `.continuum/telemetry/config.json` (GITIGNORED)
- `telemetryQueuePath(projectDir)` = `.continuum/telemetry/queue.jsonl`
- `telemetryReviewsDir(projectDir)` = `.continuum/telemetry/reviews` (Zone-B, gitignored)
- `installIdPath(homeDir)` = `~/.mochi/install-id` (home-scoped, OUTSIDE the repo; `homeDir` injectable, defaults to `os.homedir()`).

**`install_id.js`:** `getInstallId({ homeDir, version, now } = {})` → stable UUID v4; create-once; auto-rotate when `> ~30 days` since `createdAt` OR plugin-major of `version` differs from stored `major`; on-disk record `{ iid, createdAt, major }`; corrupt file ⇒ re-mint. `resetInstallId({ homeDir } = {})` deletes the file (next `getInstallId` mints fresh). All FS fault-tolerant; never throws. Callable with NO args from hooks (defaults apply).

**`telemetry_config.js`:** `readConfig(projectDir) → { decided, share, reviewAuto, killSwitch, sampleN }` (defaults `decided:false, share:false, reviewAuto:false, killSwitch:"on", sampleN:10`; absence ⇒ not shared); `writeConfig(projectDir, cfg)` atomic write to gitignored `config.json`; `isSharingEnabled(cfg, env) = cfg.share===true && cfg.killSwitch!=="off" && env.MOCHI_TELEMETRY!=="off"` (absence ⇒ false). Exports `INGEST_URL = "https://mochi-insight.nexalance.cloud/v1/ingest"` + `INGEST_WRITE_KEY` (build-time placeholder const, baked at release).

**`telemetry_log.js`:** `appendEvent(projectDir, event)` — ONE synchronous JSONL line, hot-path-safe (no network/LLM/redact); `readEvents(projectDir)` — parse JSONL, skip blank/corrupt; `pruneEvents(projectDir, { maxLines, maxAgeDays, now })` — cap by newest line count AND drop older-than-age, atomic rewrite, chronological order.

**`telemetry_redact.js` (fail-closed keystone):** `redactEvent(raw) → Zone-A event`; `redactDistillation(raw) → Zone-A distillation`. WHITELIST keys only (unknown dropped); `tool`/`mcp` not in allowlist ⇒ bucketed literal; categoricals coerced to enum-or-`"other"`; Zone-B fields never present. The SAME serializer powers BOTH emit AND `/mochi:telemetry show` (§13.1 N2).

**`telemetry_emit.js`:** `flush(projectDir, env, deps)` — re-reads config+env, gates on `isSharingEnabled` at SEND time (absence/opted-out ⇒ ZERO `deps.fetch` calls); `deps.fetch` injectable (defaults to global `fetch`); POST `INGEST_URL` with header `x-mochi-key: INGEST_WRITE_KEY`, body `{ iid, batch }`; re-redacts every event through `redactEvent`; fail-open (swallows errors); capped offline queue at `telemetryQueuePath` with retry-next-flush; short `AbortController` timeout.

**`telemetry_aggregate.js`:** `aggregate(events) → { topTools, topMcps, errorRates, sequences, callsPerTask, backlog, toolsPerTaskCategory }`. Distillations are events carrying `task_category`; usage events carry `tool`/`mcp`. The server copy `telemetry-server/aggregate.mjs` is the same shape.

**Server env:** `PORT`(3000), `INGEST_WRITE_KEY`, `DASHBOARD_USER`, `DASHBOARD_PASS`, `DATA_DIR=/data`, `RETENTION_DAYS=180`.

**Version:** `plugin.json` is `0.6.1` at planning time → target release `0.7.0` (next minor); Zone-A `v: "0.7.0"`.

## File Structure

**Plugin lib (`plugins/continuum/lib/`):**
- `paths.js` (MODIFY) — add telemetry path helpers + home-scoped `installIdPath`.
- `install_id.js` (CREATE) — anonymous rotating machine-scoped install-id.
- `telemetry_config.js` (CREATE) — two-toggle consent + kill-switch + send-time gate + INGEST consts.
- `telemetry_redact.js` (CREATE) — fail-closed Zone-A redactor (privacy keystone).
- `telemetry_log.js` (CREATE) — hot-path-safe append + prune local event store.
- `telemetry_emit.js` (CREATE) — send-time-gated batch emit + fail-open offline queue.
- `telemetry_aggregate.js` (CREATE) — read-time Zone-A aggregates.
- `telemetry_cli.js` (CREATE) — `/mochi:telemetry` CLI (status/show/on/off/review-auto/flush/reset-id/purge).
- `telemetry_review_cli.js` (CREATE) — `/mochi:review-session` distillation emit shim.

**Plugin hooks (`plugins/continuum/hooks/`):**
- `pre_tool_use.js` (MODIFY) — Zone-A append FIRST, before sentinel fast-skip; no network.
- `post_tool_use.js` (MODIFY) — record result/err BEFORE FILE_EDIT early-return.
- `hooks.json` (MODIFY) — widen PostToolUse matcher to `*`.
- `session_start.js` (MODIFY) — two-toggle consent gate + sampled auto-review directive + `telemetry/` in giWanted.
- `session_end.js` (MODIFY) — close event + flush (off hot path) + pending-review marker.
- `pre_compact.js` (MODIFY) — compaction-counter event.

**Plugin commands (`plugins/continuum/commands/`):**
- `telemetry.md` (CREATE) — audit/control surface.
- `review-session.md` (CREATE) — Arm-2 critique + Arm-3 GitHub-only routing.
- `insights.md` (CREATE) — owner-only `/v1/summary` fetch.

**Plugin manifest:**
- `.claude-plugin/plugin.json` (MODIFY) — bump `0.6.1`→`0.7.0`; register the three commands.

**Ingest server (`telemetry-server/`):**
- `package.json` (CREATE) — ESM, dependency-free, `node --test`.
- `telemetry_redact.js` (CREATE) — server copy of the Zone-A redactor (defense in depth).
- `store.mjs` (CREATE) — date-bucketed JSONL append + retention sweep + iid-drop + erasure.
- `aggregate.mjs` (CREATE) — Zone-A aggregation incl. tools-per-task-category + backlog.
- `auth.mjs` (CREATE) — write-key + constant-time owner auth + token-bucket rate-limit.
- `dashboard.mjs` (CREATE) — server-rendered HTML + inline SVG dashboard.
- `server.mjs` (CREATE) — HTTP routing + server-side redact-on-ingest + all endpoints.
- `Dockerfile` (CREATE) — node:22-alpine, non-root, EXPOSE 3000.
- `.dockerignore` (CREATE) — exclude tests/README/node_modules.
- `README.md` (CREATE) — deploy runbook + env + guarantees.

**Plugin tests (`plugins/continuum/tests/`):**
- `run-telemetry-paths.mjs`, `run-telemetry-install-id.mjs`, `run-telemetry-config.mjs`, `run-telemetry-redact.mjs`, `run-telemetry-log.mjs`, `run-telemetry-emit.mjs`, `run-telemetry-aggregate.mjs`, `run-telemetry-all.mjs` (CREATE) — foundation + emit/aggregate unit runners.
- `run-telemetry.sh` (CREATE) — bash harness for hook-wiring + command + gate tasks.
- `run-synthetic.sh` (MODIFY) — wire telemetry runners into the umbrella suite.

**Server-side CI tests (`server/`):**
- `_telemetry_ci_verify.test.mjs` (CREATE) — assert CI runs the telemetry suites.
- `package.json` (MODIFY) — chain the telemetry aggregator + CI-verify into `test`.

**Ingest-server tests (`telemetry-server/`):**
- `_server_pkg.test.mjs`, `_redact.test.mjs`, `_store.test.mjs`, `_aggregate.test.mjs`, `_auth.test.mjs`, `_dashboard.test.mjs`, `_server.test.mjs`, `_docker.test.mjs` (CREATE) — colocated `node --test` suite.

**Release/CI:**
- `.github/workflows/build.yml` (MODIFY) — run telemetry harness + ingest-server tests.
- `CHANGELOG.md` (MODIFY) — `0.7.0` entry.
- `.gitignore` (MODIFY) — ignore `.secrets.telemetry.env` scratch.

## Phase 1 — Privacy Keystone: paths, install_id, config, log, redact

This phase builds the dependency-free plugin-side primitives. It is the privacy keystone phase: every later arm (emit, aggregate, server) funnels Zone-A through `telemetry_redact.js`, so the redactor's fail-closed behavior and the planted-secret tests from §13.1/§13.2 are non-negotiable here.

Test conventions: plugin unit tests live in `plugins/continuum/tests/` as `run-*.mjs` runners, run with plain `node` (mirrors `run-popup-synthetic.mjs`). Each uses `node:assert/strict`, bare `{ ... }` IIFE blocks, ends with `console.log("✓ ...")`, and uses `fs.mkdtempSync(path.join(os.tmpdir(), ...))` temp dirs + `fs.rmSync(..., {recursive:true})` cleanup. Install-id tests NEVER touch the real `~/.mochi`; every call passes an injected `homeDir`.

---

### Task 1: Telemetry path helpers in `paths.js`

**Files:** Modify `plugins/continuum/lib/paths.js` (add `os` import + exports at end of file) / Create `plugins/continuum/tests/run-telemetry-paths.mjs`.

1. [ ] **Write failing test.** Create `plugins/continuum/tests/run-telemetry-paths.mjs`:
```js
// plugins/continuum/tests/run-telemetry-paths.mjs
// Telemetry path helpers: dir + four files under .continuum/telemetry, plus the
// home-scoped install-id path OUTSIDE the repo (~/.mochi/install-id).
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  telemetryDir, telemetryEventsPath, telemetryConfigPath,
  telemetryQueuePath, telemetryReviewsDir, installIdPath,
} from "../lib/paths.js";

const PROJ = "/tmp/fake-project";

// 1) telemetryDir is .continuum/telemetry under the project
{
  assert.equal(telemetryDir(PROJ), path.join(PROJ, ".continuum", "telemetry"));
}

// 2) the four telemetry files sit directly under telemetryDir with exact names
{
  const d = telemetryDir(PROJ);
  assert.equal(telemetryEventsPath(PROJ), path.join(d, "events.jsonl"));
  assert.equal(telemetryConfigPath(PROJ), path.join(d, "config.json"));
  assert.equal(telemetryQueuePath(PROJ), path.join(d, "queue.jsonl"));
  assert.equal(telemetryReviewsDir(PROJ), path.join(d, "reviews"));
}

// 3) install-id lives OUTSIDE the repo, home-scoped at ~/.mochi/install-id.
//    Default uses os.homedir(); an injected homeDir overrides (for tests).
{
  assert.equal(installIdPath(), path.join(os.homedir(), ".mochi", "install-id"));
  assert.equal(installIdPath("/tmp/fakehome"), path.join("/tmp/fakehome", ".mochi", "install-id"));
}

console.log("✓ telemetry paths");
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-paths.mjs`. Expected: import error — `telemetryDir`/`installIdPath` etc. are not exported (named imports resolve to `undefined`, the first `assert.equal` throws). Exit code 1.

3. [ ] **Implement.** In `plugins/continuum/lib/paths.js`, add a top-of-file import for `os` so the imports read:
```js
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
```
Then append at end of file:
```js
// ---------------------------------------------------------------------------
// Telemetry (Mochi Insight) path helpers. Everything Zone-A/Zone-B lives under
// .continuum/telemetry/ and is GITIGNORED (per-user/per-machine, not a repo
// artifact). The anonymous install-id is machine-scoped, so it lives OUTSIDE
// the repo at ~/.mochi/install-id (NO PII, rotates — see install_id.js).
// ---------------------------------------------------------------------------
export function telemetryDir(projectDir) {
  return path.join(continuumRoot(projectDir), "telemetry");
}
export function telemetryEventsPath(projectDir) {
  return path.join(telemetryDir(projectDir), "events.jsonl");
}
// config.json holds the per-user consent decision — GITIGNORED (not committed).
export function telemetryConfigPath(projectDir) {
  return path.join(telemetryDir(projectDir), "config.json");
}
// queue.jsonl holds unsent batches awaiting the next flush (capped).
export function telemetryQueuePath(projectDir) {
  return path.join(telemetryDir(projectDir), "queue.jsonl");
}
// reviews/ holds Zone-B critiques (full suggestion_text) — NEVER auto-sent.
export function telemetryReviewsDir(projectDir) {
  return path.join(telemetryDir(projectDir), "reviews");
}
// installIdPath is home-scoped, NOT project-scoped: one anonymous id per
// machine/user. `homeDir` is injectable for tests; defaults to os.homedir().
export function installIdPath(homeDir) {
  return path.join(homeDir || os.homedir(), ".mochi", "install-id");
}
```

4. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-paths.mjs`. Expected: `✓ telemetry paths`, exit 0.

5. [ ] **Commit.** `git add plugins/continuum/lib/paths.js plugins/continuum/tests/run-telemetry-paths.mjs && git commit -m "feat(telemetry): add Zone-A/B telemetry + home-scoped install-id path helpers"`

---

### Task 2: `install_id.js` — create-once + auto-rotate + reset

**Files:** Create `plugins/continuum/lib/install_id.js` / Create `plugins/continuum/tests/run-telemetry-install-id.mjs` / uses `installIdPath` from Task 1.

Contract: `getInstallId({ homeDir, version, now } = {})` returns a stable UUID v4. Creates the file once on first call. Auto-rotates (writes a NEW id) when (a) more than ~30 days elapsed since `createdAt`, OR (b) the plugin-major component of `version` differs from the stored `major`. On-disk record is JSON `{ iid, createdAt, major }`. `resetInstallId({ homeDir })` deletes the file. All FS fault-tolerant; a corrupt file is treated as absent (re-mint).

1. [ ] **Write failing test.** Create `plugins/continuum/tests/run-telemetry-install-id.mjs`:
```js
// plugins/continuum/tests/run-telemetry-install-id.mjs
// install_id.js: create-once, monthly auto-rotate, plugin-major auto-rotate, reset.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getInstallId, resetInstallId } from "../lib/install_id.js";
import { installIdPath } from "../lib/paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 86400 * 1000;

// 1) create-once: same id across calls; file is JSON {iid,createdAt,major}; uuid v4.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-create-"));
  const a = getInstallId({ homeDir: home, version: "0.7.0" });
  const b = getInstallId({ homeDir: home, version: "0.7.0" });
  assert.match(a, UUID_RE, "id is a v4 uuid");
  assert.equal(a, b, "second call returns the same id (create-once)");
  const rec = JSON.parse(fs.readFileSync(installIdPath(home), "utf8"));
  assert.equal(rec.iid, a);
  assert.equal(rec.major, 0, "major parsed from version 0.7.0");
  assert.equal(typeof rec.createdAt, "number");
  fs.rmSync(home, { recursive: true, force: true });
}

// 2) monthly auto-rotate: a createdAt > ~30 days old yields a NEW id.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-month-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0", now: 1_000_000_000_000 });
  const later = getInstallId({ homeDir: home, version: "0.7.0", now: 1_000_000_000_000 + 31 * DAY });
  assert.notEqual(later, first, "id rotates after ~30 days");
  assert.match(later, UUID_RE);
  fs.rmSync(home, { recursive: true, force: true });
}

// 3) plugin-major bump auto-rotate: same window, higher major -> NEW id.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-major-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0", now: 2_000_000_000_000 });
  const bumped = getInstallId({ homeDir: home, version: "1.0.0", now: 2_000_000_000_000 + DAY });
  assert.notEqual(bumped, first, "id rotates on plugin-major bump");
  const rec = JSON.parse(fs.readFileSync(installIdPath(home), "utf8"));
  assert.equal(rec.major, 1, "stored major updated to 1");
  fs.rmSync(home, { recursive: true, force: true });
}

// 4) no rotate within the window on same major (stability).
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-stable-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0", now: 3_000_000_000_000 });
  const same = getInstallId({ homeDir: home, version: "0.7.5", now: 3_000_000_000_000 + 5 * DAY });
  assert.equal(same, first, "no rotate within 30d on same major");
  fs.rmSync(home, { recursive: true, force: true });
}

// 5) resetInstallId deletes the file; next get mints a fresh id.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-reset-"));
  const first = getInstallId({ homeDir: home, version: "0.7.0" });
  resetInstallId({ homeDir: home });
  assert.equal(fs.existsSync(installIdPath(home)), false, "reset removed the file");
  const fresh = getInstallId({ homeDir: home, version: "0.7.0" });
  assert.notEqual(fresh, first, "post-reset id is fresh");
  fs.rmSync(home, { recursive: true, force: true });
}

// 6) corrupt file is treated as absent (re-mint, no throw).
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iid-corrupt-"));
  fs.mkdirSync(path.dirname(installIdPath(home)), { recursive: true });
  fs.writeFileSync(installIdPath(home), "{not json");
  const id = getInstallId({ homeDir: home, version: "0.7.0" });
  assert.match(id, UUID_RE, "corrupt file re-mints a valid id");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("✓ telemetry install_id (create-once + rotate + reset)");
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-install-id.mjs`. Expected: `ERR_MODULE_NOT_FOUND` for `../lib/install_id.js`. Exit code 1.

3. [ ] **Implement.** Create `plugins/continuum/lib/install_id.js`:
```js
// install_id.js — the anonymous, machine-scoped install id (Zone-A `iid`).
// Privacy spine (spec §2, §13.4): a SINGLE random UUID v4 per machine/user, NO
// PII, NOT per-project — lives OUTSIDE the repo at ~/.mochi/install-id. It is
// PSEUDONYMOUS and ROTATING (GDPR §13.4): rotates automatically monthly OR on a
// plugin-major bump, so it is never a forever id. Resettable (delete = rotate).
//
// On-disk record (JSON): { iid, createdAt(ms), major }.
// Dependency-free; all FS is fault-tolerant (telemetry must never crash a session).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { installIdPath } from "./paths.js";

const ROTATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // ~monthly

// Parse the plugin-major from a semver-ish string ("0.7.0" -> 0). Non-numeric
// or absent -> 0 (so a missing version never spuriously rotates).
function parseMajor(version) {
  const m = /^(\d+)/.exec(String(version ?? ""));
  return m ? Number(m[1]) : 0;
}

function readRecord(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (rec && typeof rec.iid === "string" && rec.iid.length > 0) return rec;
    return null;
  } catch {
    return null; // corrupt -> treat as absent (re-mint)
  }
}

function writeRecord(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  } catch {
    // swallow — a failed write just means we re-mint next time; never throws.
  }
}

// getInstallId({ homeDir, version, now }) -> uuid string.
// Create-once, then auto-rotate when stale (>30d) or plugin-major changed.
export function getInstallId({ homeDir, version, now } = {}) {
  const file = installIdPath(homeDir);
  const ts = typeof now === "number" ? now : Date.now();
  const major = parseMajor(version);
  const rec = readRecord(file);

  const stale = rec && (ts - (rec.createdAt ?? 0)) > ROTATE_AFTER_MS;
  const majorBumped = rec && rec.major !== major;

  if (rec && !stale && !majorBumped) return rec.iid;

  const fresh = { iid: crypto.randomUUID(), createdAt: ts, major };
  writeRecord(file, fresh);
  return fresh.iid;
}

// resetInstallId({ homeDir }) — delete the file; next getInstallId mints fresh.
export function resetInstallId({ homeDir } = {}) {
  const file = installIdPath(homeDir);
  try { fs.rmSync(file, { force: true }); } catch {}
}
```

4. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-install-id.mjs`. Expected: `✓ telemetry install_id (create-once + rotate + reset)`, exit 0.

5. [ ] **Commit.** `git add plugins/continuum/lib/install_id.js plugins/continuum/tests/run-telemetry-install-id.mjs && git commit -m "feat(telemetry): install_id create-once + monthly/major auto-rotate + reset"`

---

### Task 3: `telemetry_config.js` — two-toggle consent + kill-switch + INGEST consts

**Files:** Create `plugins/continuum/lib/telemetry_config.js` / Create `plugins/continuum/tests/run-telemetry-config.mjs` / uses `telemetryConfigPath` from Task 1.

Contract: `readConfig(projectDir) -> { decided, share, reviewAuto, killSwitch, sampleN }` (defaults: `decided:false, share:false, reviewAuto:false, killSwitch:"on", sampleN:10` — absence ⇒ not shared). `writeConfig(projectDir, cfg)` atomic write to the gitignored `config.json`. `isSharingEnabled(cfg, env)` = the §13.3 boolean (absence ⇒ false). Exports `INGEST_URL` + `INGEST_WRITE_KEY` (build-time placeholder const).

1. [ ] **Write failing test.** Create `plugins/continuum/tests/run-telemetry-config.mjs`:
```js
// plugins/continuum/tests/run-telemetry-config.mjs
// telemetry_config.js: two-toggle consent (share / reviewAuto), kill-switch,
// isSharingEnabled (ABSENCE = false), INGEST_URL/INGEST_WRITE_KEY consts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readConfig, writeConfig, isSharingEnabled,
  INGEST_URL, INGEST_WRITE_KEY,
} from "../lib/telemetry_config.js";
import { telemetryConfigPath } from "../lib/paths.js";

// 1) defaults when absent: NOT decided, NOT shared, NOT reviewAuto, killSwitch on.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-default-"));
  const cfg = readConfig(dir);
  assert.equal(cfg.decided, false);
  assert.equal(cfg.share, false, "absence => not shared (opt-in not opt-out)");
  assert.equal(cfg.reviewAuto, false, "auto-review default off (spends user tokens)");
  assert.equal(cfg.killSwitch, "on");
  assert.equal(cfg.sampleN, 10);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) writeConfig persists to the gitignored config.json and round-trips.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-rt-"));
  writeConfig(dir, { decided: true, share: true, reviewAuto: true, killSwitch: "on", sampleN: 5 });
  assert.ok(fs.existsSync(telemetryConfigPath(dir)), "config.json written under telemetry/");
  const cfg = readConfig(dir);
  assert.equal(cfg.decided, true);
  assert.equal(cfg.share, true);
  assert.equal(cfg.reviewAuto, true);
  assert.equal(cfg.sampleN, 5);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) isSharingEnabled: TRUE only when share===true && killSwitch!=="off" && env not "off".
{
  assert.equal(isSharingEnabled({ share: true, killSwitch: "on" }, {}), true);
  assert.equal(isSharingEnabled({ share: true, killSwitch: "on" }, { MOCHI_TELEMETRY: "off" }), false, "env kill wins");
  assert.equal(isSharingEnabled({ share: true, killSwitch: "off" }, {}), false, "killSwitch off wins");
  assert.equal(isSharingEnabled({ share: false, killSwitch: "on" }, {}), false, "share false => no send");
}

// 4) ABSENCE = false: undefined cfg, undefined env, empty objects all => false.
{
  assert.equal(isSharingEnabled(undefined, undefined), false);
  assert.equal(isSharingEnabled({}, {}), false);
  assert.equal(isSharingEnabled(null, null), false);
}

// 5) baked-in INGEST consts: exact public URL + a non-empty write-key string.
{
  assert.equal(INGEST_URL, "https://mochi-insight.nexalance.cloud/v1/ingest");
  assert.equal(typeof INGEST_WRITE_KEY, "string");
}

// 6) corrupt config.json degrades to defaults (never throws).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcfg-bad-"));
  fs.mkdirSync(path.dirname(telemetryConfigPath(dir)), { recursive: true });
  fs.writeFileSync(telemetryConfigPath(dir), "{broken");
  const cfg = readConfig(dir);
  assert.equal(cfg.share, false, "corrupt config => safe defaults (not shared)");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("✓ telemetry_config (two-toggle consent + killSwitch + INGEST consts)");
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-config.mjs`. Expected: `ERR_MODULE_NOT_FOUND` for `../lib/telemetry_config.js`. Exit code 1.

3. [ ] **Implement.** Create `plugins/continuum/lib/telemetry_config.js`:
```js
// telemetry_config.js — per-user/per-machine consent state for Mochi Insight.
// config.json is GITIGNORED (spec §7/§13.7): the consent decision is NOT a repo
// artifact. Opt-IN, not opt-out — ABSENCE always means "do not share" (§13.3).
//
// Two INDEPENDENT toggles (§13.3 M4):
//   share      — share anonymous, content-free Zone-A telemetry (free).
//   reviewAuto — auto efficiency-review (spends the USER's own Claude tokens);
//                separate explicit yes, default OFF.
// killSwitch "off" disables capture AND emission. sampleN = 1-in-N auto-review.

import fs from "node:fs";
import path from "node:path";
import { telemetryConfigPath, telemetryDir } from "./paths.js";

// Baked-in transport consts (spec §13.8). INGEST_WRITE_KEY is a SOFT deterrent,
// not a secret (it ships in distributed plugin code) — set at build/release.
export const INGEST_URL = "https://mochi-insight.nexalance.cloud/v1/ingest";
export const INGEST_WRITE_KEY = "REPLACE_AT_BUILD"; // placeholder; baked at release

const DEFAULTS = {
  decided: false,    // has the user answered the consent gate at least once?
  share: false,      // ABSENCE => false (opt-in)
  reviewAuto: false, // ABSENCE => false (spends user tokens)
  killSwitch: "on",  // "off" fully disables capture + emission
  sampleN: 10,       // 1-in-N auto-review sampling
};

export function readConfig(projectDir) {
  const file = telemetryConfigPath(projectDir);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    const user = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!user || typeof user !== "object" || Array.isArray(user)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...user };
  } catch {
    return { ...DEFAULTS }; // corrupt => safe defaults (not shared)
  }
}

export function writeConfig(projectDir, cfg) {
  const dir = telemetryDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = telemetryConfigPath(projectDir);
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...DEFAULTS, ...readConfig(projectDir), ...cfg }, null, 2) + "\n");
  fs.renameSync(tmp, dest);
  return dest;
}

// isSharingEnabled — the SINGLE gated boundary, re-checked at SEND time (§13.3
// M1). TRUE only when share===true AND killSwitch!=="off" AND env not "off".
// ABSENCE = false: missing cfg/env never sends.
export function isSharingEnabled(cfg, env) {
  const c = cfg || {};
  const e = env || {};
  return c.share === true && c.killSwitch !== "off" && e.MOCHI_TELEMETRY !== "off";
}
```

4. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-config.mjs`. Expected: `✓ telemetry_config ...`, exit 0.

5. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_config.js plugins/continuum/tests/run-telemetry-config.mjs && git commit -m "feat(telemetry): two-toggle consent config + killSwitch + isSharingEnabled + INGEST consts"`

---

### Task 4: `telemetry_redact.js` — the fail-closed privacy keystone (PLANTED-SECRET TESTS)

**Files:** Create `plugins/continuum/lib/telemetry_redact.js` / Create `plugins/continuum/tests/run-telemetry-redact.mjs`.

This is the security-gating task. Contract:
- Exports enums: `ERR_ENUM`, `TASK_ENUM`, `REDUNDANCY_ENUM`, `SUGGESTION_ENUM` (each a small fixed set + always `"other"`), `SEVERITY_ENUM`, and allowlists `ALLOW_TOOLS` / `ALLOW_MCPS`.
- `redactEvent(raw) -> Zone-A event` `{ ts, sid, iid, tool, mcp, ok, err, dur_b, v, os }`: whitelist keys only (drop unknown); `tool`/`mcp` not in allowlist ⇒ literal `"thirdparty_tool"`/`"thirdparty_mcp"`; `err` coerced into `ERR_ENUM` else `"other"`; `ok` coerced to bool; numerics/strings coerced; NO `model`.
- `redactDistillation(raw) -> Zone-A distillation` `{ task_category, tool_calls, efficiency_score, redundancy_pattern, suggestion_tag, severity }`: categoricals coerced to their enum-or-`"other"`; `suggestion_text` + `quality_issue` are NEVER in the output (Zone-B, not whitelisted, even if present in input).
- Fail-closed: unknown key ⇒ dropped; known key with bad value ⇒ coerced to enum-or-`"other"`. Same serializer powers both emit AND `/mochi:telemetry show`.

1. [ ] **Write failing test** (includes the §13.1/§13.2 planted-secret cases). Create `plugins/continuum/tests/run-telemetry-redact.mjs`:
```js
// plugins/continuum/tests/run-telemetry-redact.mjs
// telemetry_redact.js — THE privacy keystone (spec §13.1/§13.2), fail-closed.
// Asserts: key whitelist, third-party tool/mcp bucketing, enum value-coercion,
// Zone-B fields NEVER present, and the planted-secret cases are fully absent.
import assert from "node:assert/strict";
import {
  redactEvent, redactDistillation,
  ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM, SEVERITY_ENUM,
  ALLOW_TOOLS, ALLOW_MCPS,
} from "../lib/telemetry_redact.js";

// helper: assert a substring appears NOWHERE in the serialized object.
function absent(obj, needle, msg) {
  assert.ok(!JSON.stringify(obj).includes(needle), msg || `secret leaked: ${needle}`);
}

// enums are non-empty and each categorical enum contains "other".
{
  for (const [name, e] of Object.entries({ ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM })) {
    assert.ok(Array.isArray(e) && e.length > 0, `${name} non-empty`);
    assert.ok(e.includes("other"), `${name} must include "other" bucket`);
  }
  assert.deepEqual(ERR_ENUM, ["timeout","not_found","bad_input","permission","network","other"]);
  assert.ok(Array.isArray(ALLOW_TOOLS) && Array.isArray(ALLOW_MCPS));
}

// 1) happy path: allowlisted tool/mcp + valid enum survive verbatim; exact Zone-A keys.
{
  const out = redactEvent({
    ts: 1717900000, sid: "s1", iid: "i1",
    tool: "browser_click", mcp: "mochi_browser", ok: false,
    err: "timeout", dur_b: "1-3s", v: "0.7.0", os: "darwin",
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"]);
  assert.equal(out.tool, "browser_click");
  assert.equal(out.mcp, "mochi_browser");
  assert.equal(out.err, "timeout");
  assert.equal(out.ok, false);
}

// 2) §13.6 — NO model field even if present in input.
{
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", tool: "Read", mcp: "",
    ok: true, err: "", dur_b: "0-1s", v: "0.7.0", os: "linux", model: "claude-opus-4" });
  assert.equal("model" in out, false, "model is dropped from Zone-A (§13.6)");
  absent(out, "claude-opus-4", "model value must not leak");
}

// 3) §13.1 B1 — third-party MCP/tool names are BUCKETED, never echoed.
//    Planted: mcp__client_secret_project__do
{
  const out = redactEvent({
    ts: 1, sid: "s", iid: "i",
    tool: "mcp__client_secret_project__do", mcp: "client_secret_project",
    ok: true, err: "", dur_b: "0-1s", v: "0.7.0", os: "darwin",
  });
  assert.equal(out.tool, "thirdparty_tool", "non-allowlisted tool -> literal bucket");
  assert.equal(out.mcp, "thirdparty_mcp", "non-allowlisted mcp -> literal bucket");
  absent(out, "client_secret_project", "client codename must be fully absent");
  absent(out, "secret", "no fragment of the codename survives");
}

// 4) §13.2 B2 — raw error string with paths/IPs/tokens is COERCED to an enum,
//    raw string fully absent. Planted: "/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-…"
{
  const planted = "/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-abcd1234";
  const out = redactEvent({
    ts: 1, sid: "s", iid: "i", tool: "Bash", mcp: "",
    ok: false, err: planted, dur_b: "3-10s", v: "0.7.0", os: "darwin",
  });
  assert.ok(ERR_ENUM.includes(out.err), "err coerced into ERR_ENUM");
  assert.ok(out.err === "network" || out.err === "other", "ECONNREFUSED -> network (or other)");
  absent(out, "sk-live", "token must be stripped");
  absent(out, "10.0.0.5", "IP must be stripped");
  absent(out, "/Users/j", "file path must be stripped");
}

// 5) unknown keys are DROPPED (fail-closed whitelist).
{
  const out = redactEvent({
    ts: 1, sid: "s", iid: "i", tool: "Read", mcp: "", ok: true, err: "", dur_b: "0-1s",
    v: "0.7.0", os: "darwin",
    prompt: "delete prod database now", file_contents: "AWS_SECRET=xyz", tool_input: { path: "/etc/passwd" },
  });
  assert.equal("prompt" in out, false);
  assert.equal("file_contents" in out, false);
  assert.equal("tool_input" in out, false);
  absent(out, "delete prod database", "Zone-B prompt text must not survive");
  absent(out, "AWS_SECRET", "planted secret must not survive");
  absent(out, "/etc/passwd", "tool args must not survive");
}

// 6) distillation: valid categoricals survive; exact Zone-A distillation keys.
{
  const out = redactDistillation({
    task_category: "web-qa", tool_calls: 10, efficiency_score: 0.4,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "medium",
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["efficiency_score","redundancy_pattern","severity","suggestion_tag","task_category","tool_calls"]);
  assert.equal(out.task_category, "web-qa");
  assert.equal(out.tool_calls, 10);
  assert.equal(out.suggestion_tag, "batch_clicks");
}

// 7) distillation: out-of-enum categoricals coerce to "other".
{
  const out = redactDistillation({
    task_category: "totally-made-up-category", tool_calls: "7", efficiency_score: 2,
    redundancy_pattern: "weird_thing", suggestion_tag: "nope", severity: "spicy",
  });
  assert.equal(out.task_category, "other");
  assert.equal(out.redundancy_pattern, "other");
  assert.equal(out.suggestion_tag, "other");
  assert.equal(out.tool_calls, 7, "numeric string coerced to int");
  assert.ok(out.efficiency_score >= 0 && out.efficiency_score <= 1, "score clamped to [0,1]");
}

// 8) §13.1/§13.2 — Zone-B fields suggestion_text + quality_issue are NEVER emitted,
//    even when planted with content. Also a Zone-B sentence planted in suggestion_tag is coerced.
{
  const out = redactDistillation({
    task_category: "web-qa", tool_calls: 3, efficiency_score: 0.9,
    redundancy_pattern: "other",
    suggestion_tag: "You should refactor /Users/j/secret.js and remove token sk-live-XYZ",
    severity: "low",
    suggestion_text: "Full human advice mentioning the client AcmeCorp and prod-db-7 host",
    quality_issue: "missing_assertion in /app/private/checkout.test.ts",
  });
  assert.equal("suggestion_text" in out, false, "suggestion_text is Zone-B (never emitted)");
  assert.equal("quality_issue" in out, false, "quality_issue is Zone-B (never emitted)");
  assert.equal(out.suggestion_tag, "other", "free-text in suggestion_tag coerced to other");
  absent(out, "sk-live-XYZ", "token planted in suggestion_tag must be absent");
  absent(out, "AcmeCorp", "client name in suggestion_text must be absent");
  absent(out, "checkout.test.ts", "path in quality_issue must be absent");
  absent(out, "/Users/j", "path planted in suggestion_tag must be absent");
}

console.log("✓ telemetry_redact (fail-closed: whitelist + bucketing + enum coercion + planted secrets stripped)");
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-redact.mjs`. Expected: `ERR_MODULE_NOT_FOUND` for `../lib/telemetry_redact.js`. Exit code 1.

3. [ ] **Implement.** Create `plugins/continuum/lib/telemetry_redact.js`:
```js
// telemetry_redact.js — THE privacy keystone (spec §13.1/§13.2), FAIL-CLOSED.
//
// Every Zone-A object that may leave the machine passes through here, AND the
// SAME serializer powers `/mochi:telemetry show` (§13.1 N2) so the audit is
// byte-for-byte what would POST. Rules:
//   - WHITELIST keys: only known Zone-A keys survive; unknown keys are DROPPED.
//   - tool/mcp are CONTENT: any name not in the allowlist -> the literal
//     "thirdparty_tool"/"thirdparty_mcp" (never the real name) — protects client
//     codenames, private MCP server names, internal hostnames (§13.1 B1).
//   - every categorical (err/task_category/redundancy_pattern/suggestion_tag/
//     severity) is COERCED to value-in-enum, else "other" (§13.1 B2/M2).
//   - suggestion_text + quality_issue are Zone-B ALWAYS — never whitelisted,
//     never emitted, even if present in the input.
//   - NO `model` field (§13.6).

// ── shipped enums (small fixed sets, each with an "other" bucket) ────────────
export const ERR_ENUM = ["timeout", "not_found", "bad_input", "permission", "network", "other"];
export const TASK_ENUM = ["web-qa", "coding", "refactor", "debug", "research", "docs", "comms", "other"];
export const REDUNDANCY_ENUM = ["snapshot_then_retry", "repeated_read", "repeated_edit", "retry_loop", "redundant_navigation", "none", "other"];
export const SUGGESTION_ENUM = ["batch_clicks", "use_recall", "fewer_snapshots", "assert_first", "narrower_selector", "reuse_workflow", "none", "other"];
export const SEVERITY_ENUM = ["low", "medium", "high", "other"];

// ── first-party allowlists (mochi/built-in names) ───────────────────────────
// Built-in Claude Code tools + mochi plugin tool short-names. Anything else is
// bucketed. Keep this conservative: when in doubt, bucket.
export const ALLOW_TOOLS = [
  // built-in tools
  "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Task", "WebFetch", "WebSearch",
  "NotebookEdit", "TodoWrite", "MultiEdit",
  // mochi browser MCP (short names, mcp prefix stripped before lookup)
  "browser_navigate", "browser_click", "browser_click_at", "browser_type", "browser_snapshot",
  "browser_snapshot_query", "browser_evaluate", "browser_screenshot", "browser_wait",
  "browser_assert", "browser_assert_no_errors", "browser_console_messages",
  "browser_network_requests", "browser_scroll", "browser_press_key", "browser_links",
  "browser_text", "browser_session_start", "browser_session_end",
  // mochi comms MCP
  "comms_link_account", "comms_account_status", "comms_list_chats", "comms_list_groups",
  "comms_get_messages", "comms_recall", "comms_set_allowlist", "comms_sync_now",
  "comms_import_history", "comms_unlink_account",
  // continuum recall + session signals
  "recall", "session_close", "session_compact",
];
export const ALLOW_MCPS = ["mochi_browser", "mochi_comms", "mochi_continuum", "continuum"];

// ── helpers ──────────────────────────────────────────────────────────────────
function coerceEnum(value, enumList) {
  return enumList.includes(value) ? value : "other";
}

// Strip the mcp__plugin_<server>__ / mcp__<server>__ prefix to compare the bare
// tool name against ALLOW_TOOLS; the prefix itself is never used as a value.
function bareToolName(tool) {
  if (typeof tool !== "string") return "";
  const m = /^mcp__(?:plugin_)?[^_]+(?:_[^_]+)*?__(.+)$/.exec(tool);
  return m ? m[1] : tool;
}

function bucketTool(tool) {
  const bare = bareToolName(tool);
  return ALLOW_TOOLS.includes(bare) ? bare : "thirdparty_tool";
}

function bucketMcp(mcp) {
  if (typeof mcp !== "string" || mcp === "") return ""; // built-in tools have no mcp
  return ALLOW_MCPS.includes(mcp) ? mcp : "thirdparty_mcp";
}

// err is NEVER a raw message. Map a known enum value through; otherwise drop the
// raw string entirely and emit "other" (a best-effort categorize is allowed only
// for a SMALL set of unambiguous tokens, and only the ENUM word is kept).
function coerceErr(err) {
  if (ERR_ENUM.includes(err)) return err;
  if (typeof err !== "string" || err === "") return err === "" ? "" : "other";
  const s = err.toLowerCase();
  if (s.includes("etimedout") || s.includes("timeout") || s.includes("timed out")) return "timeout";
  if (s.includes("enoent") || s.includes("not found") || s.includes("404")) return "not_found";
  if (s.includes("eacces") || s.includes("permission") || s.includes("forbidden") || s.includes("403")) return "permission";
  if (s.includes("econnrefused") || s.includes("econnreset") || s.includes("network") || s.includes("dns") || s.includes("socket")) return "network";
  if (s.includes("invalid") || s.includes("bad request") || s.includes("400") || s.includes("malformed")) return "bad_input";
  return "other"; // raw string discarded — only the enum word ever survives
}

function toBool(v) { return v === true; }

function toIntOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function str(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

// ── public API ────────────────────────────────────────────────────────────
// redactEvent(raw) -> Zone-A event with EXACTLY these keys (no model).
export function redactEvent(raw) {
  const r = raw || {};
  return {
    ts: toIntOr(r.ts, 0),
    sid: str(r.sid),
    iid: str(r.iid),
    tool: bucketTool(r.tool),
    mcp: bucketMcp(r.mcp),
    ok: toBool(r.ok),
    err: coerceErr(r.err),
    dur_b: str(r.dur_b),
    v: str(r.v),
    os: str(r.os),
  };
}

// redactDistillation(raw) -> Zone-A distillation. suggestion_text + quality_issue
// are Zone-B and are NEVER read into the output.
export function redactDistillation(raw) {
  const r = raw || {};
  return {
    task_category: coerceEnum(r.task_category, TASK_ENUM),
    tool_calls: toIntOr(r.tool_calls, 0),
    efficiency_score: clamp01(r.efficiency_score),
    redundancy_pattern: coerceEnum(r.redundancy_pattern, REDUNDANCY_ENUM),
    suggestion_tag: coerceEnum(r.suggestion_tag, SUGGESTION_ENUM),
    severity: coerceEnum(r.severity, SEVERITY_ENUM),
  };
}
```

4. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-redact.mjs`. Expected: `✓ telemetry_redact ...`, exit 0.

5. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_redact.js plugins/continuum/tests/run-telemetry-redact.mjs && git commit -m "feat(telemetry): fail-closed redactor — whitelist + thirdparty bucketing + enum coercion (planted-secret tests)"`

---

### Task 5: `telemetry_log.js` — append + prune, hot-path-safe (mirrors run-history)

**Files:** Create `plugins/continuum/lib/telemetry_log.js` / Create `plugins/continuum/tests/run-telemetry-log.mjs`. Mirrors the append-only JSONL + capped-prune shape of `server/src/memory.js` (`startRun` append + `pruneRuns`).

Contract: `appendEvent(projectDir, event)` synchronously appends ONE JSONL line (`fs.appendFileSync` after `mkdirSync`) to `events.jsonl` — NO network, NO LLM, NO redact, NO heavy parse (hot-path-safe; redaction happens at emit time). `readEvents(projectDir)` parses the JSONL into an array (skip blank/corrupt lines, fault-tolerant). `pruneEvents(projectDir, { maxLines, maxAgeDays, now })` keeps the newest events within the line-cap AND drops events older than `maxAgeDays` (by `ts`), rewriting atomically (tmp + rename), preserving chronological order.

1. [ ] **Write failing test.** Create `plugins/continuum/tests/run-telemetry-log.mjs`:
```js
// plugins/continuum/tests/run-telemetry-log.mjs
// telemetry_log.js: append-only JSONL (hot-path-safe) + capped/aged prune,
// mirroring server/src/memory.js run-history (append + _writeRunsAll prune).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendEvent, readEvents, pruneEvents } from "../lib/telemetry_log.js";
import { telemetryEventsPath } from "../lib/paths.js";

function ev(over = {}) {
  return { ts: 1000, sid: "s", iid: "i", tool: "Read", mcp: "", ok: true,
    err: "other", dur_b: "0-1s", v: "0.7.0", os: "darwin", ...over };
}

// 1) appendEvent writes ONE JSONL line per call; readEvents round-trips in order.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-rt-"));
  appendEvent(dir, ev({ ts: 1, tool: "Read" }));
  appendEvent(dir, ev({ ts: 2, tool: "Edit" }));
  const text = fs.readFileSync(telemetryEventsPath(dir), "utf8");
  assert.equal(text.trim().split("\n").length, 2, "one line per appended event");
  const rows = readEvents(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, "Read");
  assert.equal(rows[1].tool, "Edit");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) hot-path safety: appendEvent writes the object verbatim (NO redaction here)
//    — redaction is the emit boundary; the hook must stay ~1ms append-only.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-verbatim-"));
  appendEvent(dir, ev({ tool: "mcp__client_x__do" }));
  assert.equal(readEvents(dir)[0].tool, "mcp__client_x__do",
    "log stores verbatim; bucketing happens at emit-time redact, not in the hot path");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) readEvents skips blank + corrupt lines (fault-tolerant).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-corrupt-"));
  fs.mkdirSync(path.dirname(telemetryEventsPath(dir)), { recursive: true });
  fs.writeFileSync(telemetryEventsPath(dir),
    JSON.stringify(ev({ ts: 1 })) + "\n\n{bad json\n" + JSON.stringify(ev({ ts: 2 })) + "\n");
  const rows = readEvents(dir);
  assert.equal(rows.length, 2, "blank + corrupt lines skipped");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4) pruneEvents caps to the newest maxLines, preserving chronological order.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-cap-"));
  for (let i = 1; i <= 5; i++) appendEvent(dir, ev({ ts: i }));
  pruneEvents(dir, { maxLines: 3, maxAgeDays: 9999, now: 5 * 1000 });
  const rows = readEvents(dir);
  assert.equal(rows.length, 3, "capped to newest 3");
  assert.deepEqual(rows.map((r) => r.ts), [3, 4, 5], "kept newest, chronological order");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5) pruneEvents drops events older than maxAgeDays (by ts seconds).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-age-"));
  const nowSec = 1_700_000_000;
  const DAY = 86400;
  appendEvent(dir, ev({ ts: nowSec - 200 * DAY })); // too old
  appendEvent(dir, ev({ ts: nowSec - 10 * DAY }));  // recent
  pruneEvents(dir, { maxLines: 9999, maxAgeDays: 180, now: nowSec * 1000 });
  const rows = readEvents(dir);
  assert.equal(rows.length, 1, "old event aged out");
  assert.equal(rows[0].ts, nowSec - 10 * DAY);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6) prune writes atomically (no leftover .tmp) and no-ops under cap.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-atomic-"));
  appendEvent(dir, ev({ ts: 1 }));
  pruneEvents(dir, { maxLines: 100, maxAgeDays: 9999, now: 2000 });
  const leftovers = fs.readdirSync(path.dirname(telemetryEventsPath(dir))).filter((f) => f.includes(".tmp"));
  assert.equal(leftovers.length, 0, "no .tmp leftovers (atomic rename)");
  assert.equal(readEvents(dir).length, 1, "under cap => unchanged");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("✓ telemetry_log (append + prune, hot-path-safe)");
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-log.mjs`. Expected: `ERR_MODULE_NOT_FOUND` for `../lib/telemetry_log.js`. Exit code 1.

3. [ ] **Implement.** Create `plugins/continuum/lib/telemetry_log.js`:
```js
// telemetry_log.js — local Zone-A event store (Arm 1). Mirrors the run-history
// shape in server/src/memory.js: append-only JSONL + a capped/aged prune that
// rewrites atomically (tmp + rename), preserving chronological order.
//
// HOT-PATH SAFETY (spec §4/§13.7): appendEvent is the ONLY thing the PreToolUse
// hook calls. It does ONE synchronous fs.appendFileSync of a single line — NO
// network, NO LLM, NO redaction, NO heavy parse. Redaction is the EMIT boundary
// (telemetry_redact.js), not the capture boundary, so the hook stays ~1ms.

import fs from "node:fs";
import path from "node:path";
import { telemetryEventsPath, telemetryDir } from "./paths.js";

// appendEvent — one JSONL line, append-only. Fault-tolerant: a write failure is
// swallowed (telemetry must never crash a session). Stores the event VERBATIM.
export function appendEvent(projectDir, event) {
  try {
    const file = telemetryEventsPath(projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    // swallow — never throw in the hot path.
  }
}

// readEvents — parse the JSONL into an array; skip blank/corrupt lines.
export function readEvents(projectDir) {
  const file = telemetryEventsPath(projectDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function writeAllAtomic(projectDir, rows) {
  const dir = telemetryDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = telemetryEventsPath(projectDir);
  const tmp = file + "." + process.pid + ".tmp";
  const text = rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// pruneEvents — cap by size (newest maxLines) AND age (drop ts older than
// maxAgeDays). Mirrors memory.js pruneRuns: keep newest, restore chronological
// order, rewrite atomically. `ts` is in seconds; `now` is in ms (injectable).
export function pruneEvents(projectDir, { maxLines = 5000, maxAgeDays = 180, now = Date.now() } = {}) {
  const rows = readEvents(projectDir);
  if (rows.length === 0) return;
  const cutoffSec = Math.floor(now / 1000) - maxAgeDays * 86400;
  let kept = rows.filter((r) => Number(r.ts) >= cutoffSec);
  if (kept.length > maxLines) {
    // newest-first by ts, take maxLines, then restore chronological order.
    kept = kept.slice().sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, maxLines);
    kept.sort((a, b) => Number(a.ts) - Number(b.ts));
  }
  if (kept.length !== rows.length) writeAllAtomic(projectDir, kept);
}
```

4. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-log.mjs`. Expected: `✓ telemetry_log (append + prune, hot-path-safe)`, exit 0.

5. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_log.js plugins/continuum/tests/run-telemetry-log.mjs && git commit -m "feat(telemetry): hot-path-safe append + capped/aged prune (mirrors run-history)"`

---

### Task 6: Aggregator runner for the five foundation runners

**Files:** Create `plugins/continuum/tests/run-telemetry-all.mjs`. (No new lib code; CI wiring into `server/package.json` happens in Phase 2 Task 13 alongside emit/aggregate runners.)

1. [ ] **Write the aggregator runner.** Create `plugins/continuum/tests/run-telemetry-all.mjs`:
```js
// plugins/continuum/tests/run-telemetry-all.mjs
// Runs every telemetry unit runner in one shot (CI entry point).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runners = [
  "run-telemetry-paths.mjs",
  "run-telemetry-install-id.mjs",
  "run-telemetry-config.mjs",
  "run-telemetry-redact.mjs",
  "run-telemetry-log.mjs",
  "run-telemetry-emit.mjs",
  "run-telemetry-aggregate.mjs",
];
let failed = 0;
for (const r of runners) {
  const res = spawnSync(process.execPath, [path.join(here, r)], { stdio: "inherit" });
  if (res.status !== 0) { failed++; console.error(`✗ ${r} failed`); }
}
if (failed) { console.error(`\n${failed} telemetry runner(s) failed`); process.exit(1); }
console.log("\n✓ ALL telemetry runners passed");
```
> Note: `run-telemetry-emit.mjs` + `run-telemetry-aggregate.mjs` land in Phase 2. If this runner is executed before they exist, it exits 1 listing the missing runners — that is expected until Phase 2 completes.

2. [ ] **Run it.** Cmd: `node plugins/continuum/tests/run-telemetry-all.mjs`. Expected (after Phase 1 only): the five foundation runners pass; the two not-yet-created runners report failure → exit 1. After Phase 2: all seven `✓` + `✓ ALL telemetry runners passed`, exit 0.

3. [ ] **Commit.** `git add plugins/continuum/tests/run-telemetry-all.mjs && git commit -m "test(telemetry): aggregator runner for the telemetry unit suite"`

## Phase 2 — Emit (send-time consent) + Aggregate

Both modules depend on Phase-1 siblings: `telemetry_config.js` (`readConfig`, `writeConfig`, `isSharingEnabled`, `INGEST_URL`, `INGEST_WRITE_KEY`), `telemetry_redact.js` (`redactEvent`/`redactDistillation` + enums), `telemetry_log.js` (`readEvents`), and the paths helpers. Every fetch in every test is a **mock injected via a `deps` parameter** — never the real network, never a monkey-patched global.

---

### Task 7: `telemetry_emit.js` — opted-out emits zero POSTs (consent re-check at SEND time)

**Files:** Create `plugins/continuum/lib/telemetry_emit.js` / Create `plugins/continuum/tests/run-telemetry-emit.mjs`.

> `flush(projectDir, env, deps)` re-reads config + env on every call and gates on `isSharingEnabled(cfg, env)`. `deps.fetch` is injected so tests never touch the network. The injected fetch is the ONLY thing the test counts; opted-out ⇒ count must be 0.

1. [ ] **Write failing test.** Create `plugins/continuum/tests/run-telemetry-emit.mjs`:
```js
// Unit tests for lib/telemetry_emit.js — Zone-A batch emission.
// Dependency-free. Every fetch is a MOCK injected via deps.fetch — no network.
//   Usage: node plugins/continuum/tests/run-telemetry-emit.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const { flush, MAX_QUEUE_BATCHES } = await import(path.join(PLUGIN_DIR, "lib/telemetry_emit.js"));
const { writeConfig, INGEST_URL, INGEST_WRITE_KEY } = await import(path.join(PLUGIN_DIR, "lib/telemetry_config.js"));
const { telemetryEventsPath, telemetryDir, telemetryQueuePath } = await import(path.join(PLUGIN_DIR, "lib/paths.js"));

let pass = 0, fail = 0;
const ok  = (m) => { console.log("  ✓", m); pass++; };
const bad = (m, e) => { console.log("  ✗", m, e ? "\n    " + (e.stack || e.message || e) : ""); fail++; };

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "telem-emit-"));
  fs.mkdirSync(telemetryDir(d), { recursive: true });
  return d;
}
// A mock fetch that records every call and returns a configurable response.
function mockFetch({ status = 200, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok: status >= 200 && status < 300, status, async text() { return "ok"; } };
  };
  fn.calls = calls;
  return fn;
}
// One valid Zone-A event line (already-redacted shape per §13).
const EV = { ts: 1717900000, sid: "s1", iid: "i1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", dur_b: "1-3s", v: "0.7.0", os: "darwin" };
function writeEvents(dir, evs) {
  fs.writeFileSync(telemetryEventsPath(dir), evs.map((e) => JSON.stringify(e)).join("\n") + (evs.length ? "\n" : ""));
}

// E1: OPTED OUT → zero POSTs. share=true but MOCHI_TELEMETRY=off ⇒ no send (§13.3).
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, reviewAuto: false, killSwitch: "on", sampleN: 1 });
  writeEvents(dir, [EV]);
  const f = mockFetch();
  await flush(dir, { MOCHI_TELEMETRY: "off" }, { fetch: f });
  assert.equal(f.calls.length, 0, "expected zero POSTs when opted out");
  ok("opted-out (env kill) ⇒ zero POST");
} catch (e) { bad("opted-out (env kill) ⇒ zero POST", e); }

// E2: never decided / share absent → zero POSTs (absence = no send, §13.3).
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: false }); // no share key at all
  writeEvents(dir, [EV]);
  const f = mockFetch();
  await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 0, "absence of share ⇒ no send");
  ok("share absent ⇒ zero POST");
} catch (e) { bad("share absent ⇒ zero POST", e); }

// E3: killSwitch === "off" → zero POSTs even if share=true and env clean.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "off", sampleN: 1 });
  writeEvents(dir, [EV]);
  const f = mockFetch();
  await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 0, "killSwitch off ⇒ no send");
  ok("killSwitch off ⇒ zero POST");
} catch (e) { bad("killSwitch off ⇒ zero POST", e); }

// E4: OPTED IN, clean env → POSTs once with correct URL, header, body shape.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", sampleN: 1, iid: "iid-xyz" });
  writeEvents(dir, [EV, { ...EV, ts: EV.ts + 5, tool: "browser_type" }]);
  const f = mockFetch({ status: 200 });
  const r = await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 1, "exactly one POST for one batch");
  const c = f.calls[0];
  assert.equal(c.url, INGEST_URL, "POSTs to INGEST_URL");
  assert.equal(c.opts.method, "POST");
  assert.equal(c.opts.headers["x-mochi-key"], INGEST_WRITE_KEY, "carries x-mochi-key header");
  const body = JSON.parse(c.opts.body);
  assert.equal(body.iid, "iid-xyz", "body.iid set");
  assert.ok(Array.isArray(body.batch) && body.batch.length === 2, "body.batch holds both events");
  assert.deepEqual(Object.keys(body.batch[0]).sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"], "Zone-A keys only");
  assert.equal(r.sent, 1);
  ok("opted-in ⇒ one POST, INGEST_URL + x-mochi-key + {iid,batch} body");
} catch (e) { bad("opted-in POST shape", e); }

// E5: short timeout — fetch wired with an AbortController signal.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  writeEvents(dir, [EV]);
  const f = mockFetch({ status: 200 });
  await flush(dir, {}, { fetch: f });
  assert.ok(f.calls[0].opts.signal, "fetch called with an abort signal (short timeout)");
  ok("fetch invoked with an AbortController signal");
} catch (e) { bad("fetch timeout signal", e); }

// E6: FAIL-OPEN — fetch throws ⇒ flush does NOT throw, returns, queues unsent.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  writeEvents(dir, [EV]);
  const f = mockFetch({ throwErr: new Error("ECONNREFUSED") });
  let threw = false; let r;
  try { r = await flush(dir, {}, { fetch: f }); } catch { threw = true; }
  assert.equal(threw, false, "flush must swallow fetch errors (fail-open)");
  assert.equal(r.sent, 0, "nothing counted as sent on failure");
  const q = fs.readFileSync(telemetryQueuePath(dir), "utf8").split("\n").filter(Boolean);
  assert.equal(q.length, 1, "failed batch persisted to queue");
  ok("fetch throws ⇒ fail-open + unsent batch queued");
} catch (e) { bad("fail-open + queue", e); }

// E7: RETRY — a queued batch from a prior flush is re-sent on the next flush.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  writeEvents(dir, []); // no new events this time
  fs.writeFileSync(telemetryQueuePath(dir), JSON.stringify([EV]) + "\n");
  const f = mockFetch({ status: 200 });
  const r = await flush(dir, {}, { fetch: f });
  assert.equal(f.calls.length, 1, "queued batch re-POSTed");
  assert.equal(r.sent, 1);
  const q = fs.existsSync(telemetryQueuePath(dir)) ? fs.readFileSync(telemetryQueuePath(dir), "utf8").split("\n").filter(Boolean) : [];
  assert.equal(q.length, 0, "queue cleared after successful retry");
  ok("queued batch retried + cleared on success");
} catch (e) { bad("retry queued batch", e); }

// E8: CAP — queue never grows past MAX_QUEUE_BATCHES; oldest dropped.
try {
  const dir = tmpRepo();
  writeConfig(dir, { decided: true, share: true, killSwitch: "on", iid: "i1" });
  const seed = Array.from({ length: MAX_QUEUE_BATCHES }, (_, i) => [{ ...EV, ts: EV.ts + i }]);
  fs.writeFileSync(telemetryQueuePath(dir), seed.map((b) => JSON.stringify(b)).join("\n") + "\n");
  writeEvents(dir, [{ ...EV, ts: 9999999999, tool: "browser_wait" }]);
  const f = mockFetch({ throwErr: new Error("down") });
  await flush(dir, {}, { fetch: f });
  const q = fs.readFileSync(telemetryQueuePath(dir), "utf8").split("\n").filter(Boolean);
  assert.ok(q.length <= MAX_QUEUE_BATCHES, `queue capped at ${MAX_QUEUE_BATCHES}, got ${q.length}`);
  const last = JSON.parse(q[q.length - 1]);
  assert.equal(last[0].tool, "browser_wait", "newest failed batch retained after cap");
  ok("offline queue capped (oldest dropped, newest kept)");
} catch (e) { bad("queue cap", e); }

console.log("─────────────────────────────");
console.log("passed:", pass); console.log("failed:", fail);
process.exit(fail === 0 ? 0 : 1);
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-emit.mjs`. Expected: import error (`Cannot find module .../telemetry_emit.js`), exit 1.

3. [ ] **Implement.** Create `plugins/continuum/lib/telemetry_emit.js`:
```js
// Zone-A telemetry emission. The GATED boundary: capture-to-local is always
// allowed, but emission only happens here and only when sharing is enabled,
// RE-CHECKED on every flush (spec §13.3 / §6). Fail-open: any error is
// swallowed so telemetry can never break a user's session. No LLM, off the
// hot path (called at session end / opportunistically, never in PreToolUse).
//
// flush(projectDir, env, deps):
//   deps.fetch  — injected fetch (defaults to global fetch) so tests mock it.
//   Re-reads config + env, gates on isSharingEnabled. If disabled → ZERO POST.

import fs from "node:fs";
import { readConfig, isSharingEnabled, INGEST_URL, INGEST_WRITE_KEY } from "./telemetry_config.js";
import { redactEvent } from "./telemetry_redact.js";
import { readEvents } from "./telemetry_log.js";
import { telemetryQueuePath, telemetryDir } from "./paths.js";

export const FETCH_TIMEOUT_MS = 4000;
export const MAX_QUEUE_BATCHES = 50;   // cap offline queue (drop oldest beyond)
export const MAX_BATCH_EVENTS = 500;   // cap a single POST body

// readQueue / writeQueue: unsent batches persist one-JSON-array-per-line.
function readQueue(projectDir) {
  const p = telemetryQueuePath(projectDir);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function writeQueue(projectDir, batches) {
  try {
    fs.mkdirSync(telemetryDir(projectDir), { recursive: true });
    const capped = batches.slice(-MAX_QUEUE_BATCHES); // keep newest
    fs.writeFileSync(telemetryQueuePath(projectDir), capped.map((b) => JSON.stringify(b)).join("\n") + (capped.length ? "\n" : ""));
  } catch { /* fail-open */ }
}

// POST one batch with a short timeout. Returns true on 2xx, false otherwise
// (including timeout / network error). NEVER throws (fail-open).
async function postBatch(fetchFn, iid, batch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mochi-key": INGEST_WRITE_KEY },
      body: JSON.stringify({ iid, batch }),
      signal: ctrl.signal,
    });
    return !!(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function flush(projectDir, env = process.env, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  try {
    // RE-CHECK consent at SEND time (the gated boundary). Absence ⇒ no send.
    const cfg = readConfig(projectDir);
    if (!isSharingEnabled(cfg, env)) return { sent: 0, queued: 0, skipped: true };

    // Re-redact every event through the whitelist serializer (defense in depth;
    // the SAME serializer used by /mochi:telemetry show).
    const fresh = readEvents(projectDir).map(redactEvent).filter(Boolean);
    const queued = readQueue(projectDir); // arrays of already-redacted events
    const iid = cfg.iid || (fresh[0] && fresh[0].iid) || (queued[0] && queued[0][0] && queued[0][0].iid) || "";

    // Build batches: each queued batch + one new-events batch (capped).
    const batches = [...queued];
    for (let i = 0; i < fresh.length; i += MAX_BATCH_EVENTS) {
      batches.push(fresh.slice(i, i + MAX_BATCH_EVENTS));
    }
    if (batches.length === 0) return { sent: 0, queued: 0, skipped: false };

    let sent = 0;
    const unsent = [];
    for (const batch of batches) {
      const okPost = await postBatch(fetchFn, iid, batch);
      if (okPost) sent++; else unsent.push(batch);
    }
    // Persist whatever failed for next-flush retry (capped). On full success
    // the queue is cleared.
    writeQueue(projectDir, unsent);
    return { sent, queued: unsent.length, skipped: false };
  } catch {
    return { sent: 0, queued: 0, skipped: false }; // fail-open
  }
}
```

4. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-emit.mjs`. Expected: `passed: 8`, `failed: 0`, exit 0.

5. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_emit.js plugins/continuum/tests/run-telemetry-emit.mjs && git commit -m "feat(telemetry): emit gates on consent at send-time (opted-out=>zero POST) + fail-open capped queue + retry"`

---

### Task 8: `telemetry_aggregate.js` — topTools, topMcps, errorRates

**Files:** Create `plugins/continuum/lib/telemetry_aggregate.js` / Create `plugins/continuum/tests/run-telemetry-aggregate.mjs`.

> `aggregate(events)` returns `{ topTools, topMcps, errorRates, sequences, callsPerTask, backlog, toolsPerTaskCategory }`. This task lands the first three keys; later tasks add the rest. Tests use plain in-memory Zone-A event arrays (no fetch, no fs).

1. [ ] **Write failing test.** Create `plugins/continuum/tests/run-telemetry-aggregate.mjs`:
```js
// Unit tests for lib/telemetry_aggregate.js — pure JS over Zone-A event arrays.
// No network, no fs. Usage: node plugins/continuum/tests/run-telemetry-aggregate.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const { aggregate } = await import(path.join(PLUGIN_DIR, "lib/telemetry_aggregate.js"));

let pass = 0, fail = 0;
const ok  = (m) => { console.log("  ✓", m); pass++; };
const bad = (m, e) => { console.log("  ✗", m, e ? "\n    " + (e.stack || e.message || e) : ""); fail++; };

const E = (o) => ({ ts: 0, sid: "s", iid: "i", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", dur_b: "0-1s", v: "0.7.0", os: "darwin", ...o });
const D = (o) => ({ sid: "s", iid: "i", task_category: "web-qa", tool_calls: 5, efficiency_score: 0.5, redundancy_pattern: "other", suggestion_tag: "other", severity: "low", ...o });

// A1: topTools — counts per tool, descending.
try {
  const out = aggregate([ E({ tool: "browser_click" }), E({ tool: "browser_click" }), E({ tool: "browser_type" }) ]);
  assert.deepEqual(out.topTools[0], { tool: "browser_click", count: 2 });
  assert.deepEqual(out.topTools[1], { tool: "browser_type", count: 1 });
  ok("topTools counts + sorts descending");
} catch (e) { bad("topTools", e); }

// A2: topMcps — counts per mcp, descending.
try {
  const out = aggregate([ E({ mcp: "mochi_browser" }), E({ mcp: "mochi_browser" }), E({ mcp: "mochi_comms" }) ]);
  assert.deepEqual(out.topMcps[0], { mcp: "mochi_browser", count: 2 });
  ok("topMcps counts + sorts descending");
} catch (e) { bad("topMcps", e); }

// A3: errorRates — per-tool {calls, errors, rate} where rate = errors/calls.
try {
  const out = aggregate([
    E({ tool: "browser_click", ok: true }),
    E({ tool: "browser_click", ok: false, err: "timeout" }),
    E({ tool: "browser_type", ok: true }),
  ]);
  const click = out.errorRates.find((r) => r.tool === "browser_click");
  assert.equal(click.calls, 2);
  assert.equal(click.errors, 1);
  assert.equal(click.rate, 0.5);
  const type = out.errorRates.find((r) => r.tool === "browser_type");
  assert.equal(type.rate, 0);
  ok("errorRates computes per-tool failure ratio");
} catch (e) { bad("errorRates", e); }

// A4: empty input → empty arrays, never throws.
try {
  const out = aggregate([]);
  assert.deepEqual(out.topTools, []);
  assert.deepEqual(out.topMcps, []);
  assert.deepEqual(out.errorRates, []);
  ok("empty input ⇒ empty aggregates");
} catch (e) { bad("empty input", e); }

// A5: sequences — adjacent tool→tool transitions counted PER session (by sid), ordered by ts.
try {
  const out = aggregate([
    E({ sid: "s1", ts: 1, tool: "browser_snapshot" }),
    E({ sid: "s1", ts: 2, tool: "browser_click" }),
    E({ sid: "s1", ts: 3, tool: "browser_click" }),
    E({ sid: "s2", ts: 1, tool: "browser_type" }),
  ]);
  const find = (from, to) => out.sequences.find((s) => s.from === from && s.to === to);
  assert.equal(find("browser_snapshot", "browser_click").count, 1);
  assert.equal(find("browser_click", "browser_click").count, 1);
  assert.equal(out.sequences.some((s) => s.from === "browser_click" && s.to === "browser_type"), false,
    "no transition across the s1→s2 boundary");
  ok("sequences = per-session adjacent tool transitions");
} catch (e) { bad("sequences", e); }

// A6: sequences sorted descending by count.
try {
  const out = aggregate([
    E({ sid: "s1", ts: 1, tool: "a" }), E({ sid: "s1", ts: 2, tool: "b" }),
    E({ sid: "s2", ts: 1, tool: "a" }), E({ sid: "s2", ts: 2, tool: "b" }),
    E({ sid: "s3", ts: 1, tool: "a" }), E({ sid: "s3", ts: 2, tool: "c" }),
  ]);
  assert.equal(out.sequences[0].from, "a");
  assert.equal(out.sequences[0].to, "b");
  assert.equal(out.sequences[0].count, 2);
  ok("sequences sorted descending by count");
} catch (e) { bad("sequences sort", e); }

// A7: callsPerTask — per task_category avg/min/max/n of tool_calls (from distillations).
try {
  const out = aggregate([
    D({ task_category: "web-qa", tool_calls: 10 }),
    D({ task_category: "web-qa", tool_calls: 4 }),
    D({ task_category: "refactor", tool_calls: 7 }),
  ]);
  const wq = out.callsPerTask.find((c) => c.task_category === "web-qa");
  assert.equal(wq.n, 2);
  assert.equal(wq.avg, 7);
  assert.equal(wq.min, 4);
  assert.equal(wq.max, 10);
  ok("callsPerTask aggregates tool_calls per category");
} catch (e) { bad("callsPerTask", e); }

// A8: toolsPerTaskCategory — tools used in sessions tagged with each category.
try {
  const out = aggregate([
    D({ sid: "s1", task_category: "web-qa" }),
    E({ sid: "s1", tool: "browser_click" }),
    E({ sid: "s1", tool: "browser_click" }),
    E({ sid: "s1", tool: "browser_snapshot" }),
    D({ sid: "s2", task_category: "refactor" }),
    E({ sid: "s2", tool: "Edit" }),
  ]);
  const wq = out.toolsPerTaskCategory.find((t) => t.task_category === "web-qa");
  const click = wq.tools.find((x) => x.tool === "browser_click");
  assert.equal(click.count, 2);
  assert.ok(wq.tools.some((x) => x.tool === "browser_snapshot"));
  const rf = out.toolsPerTaskCategory.find((t) => t.task_category === "refactor");
  assert.ok(rf.tools.some((x) => x.tool === "Edit"));
  ok("toolsPerTaskCategory maps tools to the session's task category");
} catch (e) { bad("toolsPerTaskCategory", e); }

// A9: backlog — ranked suggestion_tags with count, top redundancy_pattern, dominant severity, avg efficiency.
try {
  const out = aggregate([
    D({ suggestion_tag: "batch_clicks", redundancy_pattern: "snapshot_then_retry", severity: "medium", efficiency_score: 0.4 }),
    D({ suggestion_tag: "batch_clicks", redundancy_pattern: "snapshot_then_retry", severity: "high",   efficiency_score: 0.2 }),
    D({ suggestion_tag: "batch_clicks", redundancy_pattern: "redundant_navigation", severity: "medium", efficiency_score: 0.6 }),
    D({ suggestion_tag: "assert_first", redundancy_pattern: "other", severity: "low", efficiency_score: 0.9 }),
  ]);
  const top = out.backlog[0];
  assert.equal(top.suggestion_tag, "batch_clicks");
  assert.equal(top.count, 3);
  assert.equal(top.topRedundancy, "snapshot_then_retry", "most common redundancy pattern surfaced");
  assert.equal(top.severity, "medium", "dominant (modal) severity surfaced");
  assert.equal(top.avgEfficiency, 0.4, "avg efficiency_score across the tag");
  assert.equal(out.backlog[1].suggestion_tag, "assert_first");
  ok("backlog ranks suggestion_tags with redundancy/severity/efficiency");
} catch (e) { bad("backlog", e); }

// A10: backlog ignores usage events (no task_category) — distillations only.
try {
  const out = aggregate([ E({ tool: "browser_click" }), E({ tool: "browser_type" }) ]);
  assert.deepEqual(out.backlog, [], "no distillations ⇒ empty backlog");
  ok("backlog empty when only usage events present");
} catch (e) { bad("backlog usage-only", e); }

console.log("─────────────────────────────");
console.log("passed:", pass); console.log("failed:", fail);
process.exit(fail === 0 ? 0 : 1);
```

2. [ ] **Run it, expect failure.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: `Cannot find module .../telemetry_aggregate.js`, exit 1. (After this task lands topTools/topMcps/errorRates, A5-A10 still fail — those keys arrive in Tasks 9-11.)

3. [ ] **Implement (topTools/topMcps/errorRates).** Create `plugins/continuum/lib/telemetry_aggregate.js`:
```js
// Pure-JS aggregation over Zone-A telemetry events (and Arm-2 distillations).
// No I/O, no network — the caller passes an array of already-redacted Zone-A
// objects (from telemetry_log.readEvents). Powers /mochi:telemetry show and,
// server-side, the dashboard + /v1/summary. Mirrors the run-history reduce
// shape from server/src/memory.js (cheap, allocation-light, no deps).
//
// aggregate(events) -> { topTools, topMcps, errorRates, sequences,
//                        callsPerTask, backlog, toolsPerTaskCategory }
// Distillations (Arm-2 Zone-A) are events carrying a `task_category` field;
// usage events carry `tool`/`mcp`. Both may appear in one array.

function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function rankDesc(map, label) {
  return [...map.entries()]
    .map(([k, count]) => ({ [label]: k, count }))
    .sort((a, b) => b.count - a.count || String(a[label]).localeCompare(String(b[label])));
}

export function aggregate(events = []) {
  const usage = events.filter((e) => e && typeof e.tool === "string");

  // topTools / topMcps
  const topTools = rankDesc(countBy(usage, (e) => e.tool), "tool");
  const topMcps  = rankDesc(countBy(usage.filter((e) => e.mcp), (e) => e.mcp), "mcp");

  // errorRates: per tool calls/errors/rate (error = ok === false)
  const byTool = new Map();
  for (const e of usage) {
    const t = byTool.get(e.tool) || { tool: e.tool, calls: 0, errors: 0 };
    t.calls++;
    if (e.ok === false) t.errors++;
    byTool.set(e.tool, t);
  }
  const errorRates = [...byTool.values()]
    .map((t) => ({ ...t, rate: t.calls ? Number((t.errors / t.calls).toFixed(4)) : 0 }))
    .sort((a, b) => b.rate - a.rate || b.calls - a.calls);

  // Placeholders filled by later tasks (kept so the contract shape is stable).
  const sequences = [];
  const callsPerTask = [];
  const backlog = [];
  const toolsPerTaskCategory = [];

  return { topTools, topMcps, errorRates, sequences, callsPerTask, backlog, toolsPerTaskCategory };
}
```

4. [ ] **Run partial.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: A1-A4 + A10 pass; A5-A9 fail (placeholders empty). Proceed to Task 9.

5. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_aggregate.js plugins/continuum/tests/run-telemetry-aggregate.mjs && git commit -m "feat(telemetry): aggregate topTools/topMcps/errorRates (TDD)"`

---

### Task 9: `telemetry_aggregate.js` — sequences (tool→tool co-occurrence)

**Files:** Modify `plugins/continuum/lib/telemetry_aggregate.js` (tests A5/A6 already in the runner from Task 8).

> `sequences` = adjacent tool→tool transition counts within a session (`sid`), ordered by `ts`.

1. [ ] **Confirm failing.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: A5/A6 fail (`sequences` is `[]`).

2. [ ] **Implement.** Add this helper above `export function aggregate` and wire it in:
```js
// Group usage events by session, sort each by ts, then count adjacent
// tool→tool transitions. Transitions never span a session boundary.
function buildSequences(usage) {
  const bySid = new Map();
  for (const e of usage) {
    if (!e.sid) continue;
    if (!bySid.has(e.sid)) bySid.set(e.sid, []);
    bySid.get(e.sid).push(e);
  }
  const pairs = new Map(); // "from→to" -> count
  for (const evs of bySid.values()) {
    evs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (let i = 1; i < evs.length; i++) {
      const key = evs[i - 1].tool + "→" + evs[i].tool;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  return [...pairs.entries()]
    .map(([k, count]) => { const [from, to] = k.split("→"); return { from, to, count }; })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
```
Then replace `const sequences = [];` with `const sequences = buildSequences(usage);`.

3. [ ] **Run partial.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: A5/A6 now pass; A7-A9 still fail.

4. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_aggregate.js && git commit -m "feat(telemetry): aggregate tool->tool sequences/co-occurrence (TDD)"`

---

### Task 10: `telemetry_aggregate.js` — callsPerTask + toolsPerTaskCategory (from distillations)

**Files:** Modify `plugins/continuum/lib/telemetry_aggregate.js` (tests A7/A8 already in the runner).

1. [ ] **Confirm failing.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: A7/A8 fail (`callsPerTask`/`toolsPerTaskCategory` are `[]`).

2. [ ] **Implement.** In `aggregate`, add `const distill = events.filter((e) => e && typeof e.task_category === "string");`, add these helpers, and wire them in:
```js
// callsPerTask: avg/min/max/n of distillation tool_calls per task_category.
function buildCallsPerTask(distill) {
  const m = new Map();
  for (const d of distill) {
    const n = Number(d.tool_calls);
    if (!Number.isFinite(n)) continue;
    const c = m.get(d.task_category) || { task_category: d.task_category, n: 0, sum: 0, min: Infinity, max: -Infinity };
    c.n++; c.sum += n; c.min = Math.min(c.min, n); c.max = Math.max(c.max, n);
    m.set(d.task_category, c);
  }
  return [...m.values()]
    .map((c) => ({ task_category: c.task_category, n: c.n, avg: Number((c.sum / c.n).toFixed(2)), min: c.min, max: c.max }))
    .sort((a, b) => b.n - a.n || a.task_category.localeCompare(b.task_category));
}

// toolsPerTaskCategory: for each task_category, count the tools used in the
// sessions (sid) carrying a distillation of that category — the "what tools
// for what task" table. A sid maps to its distillation's category.
function buildToolsPerTaskCategory(usage, distill) {
  const sidToCat = new Map();
  for (const d of distill) if (d.sid) sidToCat.set(d.sid, d.task_category);
  const byCat = new Map(); // category -> Map(tool -> count)
  for (const e of usage) {
    const cat = sidToCat.get(e.sid);
    if (!cat) continue;
    const tools = byCat.get(cat) || new Map();
    tools.set(e.tool, (tools.get(e.tool) || 0) + 1);
    byCat.set(cat, tools);
  }
  return [...byCat.entries()]
    .map(([task_category, tools]) => ({
      task_category,
      tools: [...tools.entries()].map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    }))
    .sort((a, b) => a.task_category.localeCompare(b.task_category));
}
```
Then replace `const callsPerTask = [];` with `const callsPerTask = buildCallsPerTask(distill);` and `const toolsPerTaskCategory = [];` with `const toolsPerTaskCategory = buildToolsPerTaskCategory(usage, distill);`.

3. [ ] **Run partial.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: A7/A8 pass; A9 still fails.

4. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_aggregate.js && git commit -m "feat(telemetry): aggregate callsPerTask + toolsPerTaskCategory from distillations (TDD)"`

---

### Task 11: `telemetry_aggregate.js` — improvement backlog (ranked suggestion_tags)

**Files:** Modify `plugins/continuum/lib/telemetry_aggregate.js` (tests A9/A10 already in the runner).

> `backlog` = ranked `suggestion_tag` counts, each annotated with the modal `redundancy_pattern`, modal `severity`, and avg `efficiency_score`. Built only from Arm-2 distillations.

1. [ ] **Confirm failing.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: A9 fails (`backlog` is `[]`).

2. [ ] **Implement.** Add these helpers and wire in:
```js
function modal(values) {
  const m = new Map();
  for (const v of values) if (v != null) m.set(v, (m.get(v) || 0) + 1);
  let best = null, bestN = -1;
  for (const [v, n] of m) if (n > bestN || (n === bestN && best != null && String(v) < String(best))) { best = v; bestN = n; }
  return best;
}
function buildBacklog(distill) {
  const m = new Map(); // suggestion_tag -> rows
  for (const d of distill) {
    const tag = d.suggestion_tag;
    if (tag == null) continue;
    if (!m.has(tag)) m.set(tag, []);
    m.get(tag).push(d);
  }
  return [...m.entries()].map(([suggestion_tag, rows]) => {
    const effs = rows.map((r) => Number(r.efficiency_score)).filter(Number.isFinite);
    return {
      suggestion_tag,
      count: rows.length,
      topRedundancy: modal(rows.map((r) => r.redundancy_pattern)),
      severity: modal(rows.map((r) => r.severity)),
      avgEfficiency: effs.length ? Number((effs.reduce((a, b) => a + b, 0) / effs.length).toFixed(4)) : null,
    };
  }).sort((a, b) => b.count - a.count || a.suggestion_tag.localeCompare(b.suggestion_tag));
}
```
Then replace `const backlog = [];` with `const backlog = buildBacklog(distill);`.

3. [ ] **Run pass.** Cmd: `node plugins/continuum/tests/run-telemetry-aggregate.mjs`. Expected: `passed: 10`, `failed: 0`, exit 0.

4. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_aggregate.js && git commit -m "feat(telemetry): aggregate improvement backlog from distillations (TDD)"`

---

### Task 12: Wire the telemetry foundation runners into CI

**Files:** Modify `server/package.json` (`test` script).

1. [ ] **Implement.** Append ` && node ../plugins/continuum/tests/run-telemetry-all.mjs` to the end of the existing chained `"test"` command in `server/package.json` (after the last `_comms_*.test.mjs`). The path is relative to `server/` (the cwd where `npm test` runs); the aggregator from Phase-1 Task 6 now runs all seven foundation runners.

2. [ ] **Run pass.** Cmd (from `server/`): `npm test 2>&1 | tail -20`. Expected: existing comms/playbook tests pass AND `✓ ALL telemetry runners passed` appears, exit 0.

3. [ ] **Commit.** `git add server/package.json && git commit -m "test(telemetry): wire foundation runners into the CI test suite"`

## Phase 3 — Hooks Wiring + Commands + Manifest

Builds on the Phase-1/2 lib. These tasks wire the libs into the hook lifecycle, add the three commands + CLIs, and register them in the manifest. Plugin unit tests here use the synthetic bash-harness style (`plugins/continuum/tests/run-telemetry.sh`, asserting via `node -e` / piping hook JSON). The harness sandboxes `HOME` so install-id writes to a throwaway `~/.mochi`.

> Hook calls to `getInstallId()` pass NO args; `homeDir` defaults to `os.homedir()` and `version` defaults so major=0 (the hot path never reads `plugin.json`). The `v` field is sourced from `process.env.MOCHI_PLUGIN_VERSION || "0.7.0"`.

---

### Task 13: Create the bash telemetry harness `run-telemetry.sh`

**Files:** Create `plugins/continuum/tests/run-telemetry.sh` (chmod +x).

> This is the harness all Phase-3 hook/command tasks append assertions to. It sandboxes `HOME` and seeds tmp project dirs. The lib modules it exercises (paths, install_id, config, redact, log) already exist from Phase 1.

1. [ ] **Create the harness.** Create `plugins/continuum/tests/run-telemetry.sh`:
```bash
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
```

2. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✓ install_id no-arg`, `passed: 1`, exit 0.

3. [ ] **Commit.** `git add plugins/continuum/tests/run-telemetry.sh && git commit -m "test(telemetry): bash harness for hook/command wiring (sandboxed HOME)"`

---

### Task 14: `pre_tool_use.js` — telemetry append FIRST, before the sentinel fast-skip

**Files:** Modify `plugins/continuum/hooks/pre_tool_use.js` / append to `plugins/continuum/tests/run-telemetry.sh`.

1. [ ] **Write failing test.** Insert before the summary block in `run-telemetry.sh`:
```bash
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
```

2. [ ] **Run it, expect failure.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✗ no telemetry append before sentinel skip`, exit 1.

3. [ ] **Implement.** In `plugins/continuum/hooks/pre_tool_use.js`, add imports near the top (after the existing import block):
```js
import { appendEvent } from "../lib/telemetry_log.js";
import { redactEvent } from "../lib/telemetry_redact.js";
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { getInstallId } from "../lib/install_id.js";
```
   Then insert, as the FIRST statements inside `main()` (immediately after `projectDir`/`sessionId` are resolved, BEFORE the sentinel-existence fast-skip):
```js
  // [telemetry Arm-1] Record this tool call FIRST, unconditionally, BEFORE the
  // sentinel fast-skip below (§13.7). Hot-path safe: one synchronous JSONL line,
  // NO network/LLM. killSwitch "off" disables capture too (§7). Never throws.
  try {
    const tcfg = readTelemetryConfig(projectDir);
    if (tcfg.killSwitch !== "off") {
      const rawTool = String(payload.tool_name || payload.toolName || "");
      let tool = rawTool, mcp = "";
      const mm = rawTool.match(/^mcp__plugin_([a-z0-9_]+?)__(.+)$/i);
      if (mm) { mcp = mm[1]; tool = mm[2]; }
      appendEvent(projectDir, redactEvent({
        ts: Math.floor(Date.now() / 1000),
        sid: sessionId || "",
        iid: getInstallId(),
        tool, mcp,
        ok: true,            // PreToolUse precedes the result; ok/err set by PostToolUse
        err: "",
        dur_b: "",
        v: process.env.MOCHI_PLUGIN_VERSION || "0.7.0",
        os: process.platform,
      }));
    }
  } catch {}
```
   Note: `mcp__plugin_mochi_browser__browser_click` → `mcp="mochi_browser"`, `tool="browser_click"`. The redactor keeps `mochi_browser`/`browser_click` (allowlisted) and buckets anything else.

4. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh` (all TT6 `✓`). Then `bash plugins/continuum/tests/run-synthetic.sh` — confirm no regression (inbox fast-skip still works; telemetry precedes it).

5. [ ] **Commit.** `git add plugins/continuum/hooks/pre_tool_use.js plugins/continuum/tests/run-telemetry.sh && git commit -m "feat(telemetry): pre_tool_use Zone-A append before sentinel skip (no network on hot path)"`

---

### Task 15: `post_tool_use.js` — record result/err BEFORE the FILE_EDIT early-return + widen matcher to `*`

**Files:** Modify `plugins/continuum/hooks/post_tool_use.js` / Modify `plugins/continuum/hooks/hooks.json` / append to `plugins/continuum/tests/run-telemetry.sh`.

1. [ ] **Write failing test.** Insert before the summary:
```bash
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
```

2. [ ] **Run it, expect failure.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✗ no telemetry record for non-edit tool` (current hook early-returns on non-edit), exit 1.

3. [ ] **Implement.** In `plugins/continuum/hooks/post_tool_use.js` add imports (after the existing import block):
```js
import { appendEvent } from "../lib/telemetry_log.js";
import { redactEvent } from "../lib/telemetry_redact.js";
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { getInstallId } from "../lib/install_id.js";
```
   Add a Zone-A error-classifier helper near the other top-level helpers:
```js
// Map a tool_response into a coarse Zone-A error category — NEVER the raw text.
const ERR_PATTERNS = [
  [/time(d)? ?out|deadline exceeded|etimedout/i, "timeout"],
  [/not found|no such|enoent|404|missing/i, "not_found"],
  [/permission|denied|forbidden|eacces|401|403/i, "permission"],
  [/network|econnrefused|econnreset|enotfound|dns|socket/i, "network"],
  [/invalid|bad request|malformed|parse|400|unexpected/i, "bad_input"],
];
function classifyResponse(resp) {
  const s = typeof resp === "string" ? resp : (resp == null ? "" : JSON.stringify(resp));
  if (!s) return { ok: true, err: "" };
  const looksError = /error|fail|exception|denied|timeout|refused|invalid|not found/i.test(s);
  if (!looksError) return { ok: true, err: "" };
  for (const [re, cat] of ERR_PATTERNS) if (re.test(s)) return { ok: false, err: cat };
  return { ok: false, err: "other" };
}
```
   Insert the telemetry-record block as the FIRST statements inside `main()`, immediately after `toolName` is resolved and BEFORE the `if (!FILE_EDIT_TOOLS.has(toolName))` early-return:
```js
  // [telemetry Arm-1] Record the RESULT of this tool call FIRST, BEFORE the
  // FILE_EDIT_TOOLS early-return below (§13.7) — so every tool's ok/err category
  // is captured, not just file edits. Hot-path safe, no network, never throws.
  try {
    const tcfg = readTelemetryConfig(projectDir);
    if (tcfg.killSwitch !== "off") {
      const rawTool = String(toolName);
      let tool = rawTool, mcp = "";
      const mm = rawTool.match(/^mcp__plugin_([a-z0-9_]+?)__(.+)$/i);
      if (mm) { mcp = mm[1]; tool = mm[2]; }
      const { ok, err } = classifyResponse(payload.tool_response ?? payload.toolResponse);
      appendEvent(projectDir, redactEvent({
        ts: Math.floor(Date.now() / 1000),
        sid: payload.session_id || "",
        iid: getInstallId(),
        tool, mcp, ok, err,
        dur_b: "",
        v: process.env.MOCHI_PLUGIN_VERSION || "0.7.0",
        os: process.platform,
      }));
    }
  } catch {}
```
   In `plugins/continuum/hooks/hooks.json`, widen the PostToolUse matcher from `"Write|Edit|MultiEdit|NotebookEdit"` to `"*"`:
```json
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PLUGIN_ROOT/plugins/continuum/hooks/post_tool_use.js\"" }
        ]
      }
    ],
```

4. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh` (TT7+TT8 `✓`). Then `bash plugins/continuum/tests/run-synthetic.sh` — T23 (frontend directive) and T24 (silent on non-frontend edit) still pass (the telemetry block writes a file but emits nothing on stdout).

5. [ ] **Commit.** `git add plugins/continuum/hooks/post_tool_use.js plugins/continuum/hooks/hooks.json plugins/continuum/tests/run-telemetry.sh && git commit -m "feat(telemetry): post_tool_use records result/err before FILE_EDIT return + widen matcher to *"`

---

### Task 16: `session_start.js` — two-toggle consent gate + auto-review directive + `telemetry/` in giWanted

**Files:** Modify `plugins/continuum/hooks/session_start.js` / append to `plugins/continuum/tests/run-telemetry.sh`.

1. [ ] **Write failing test.** Insert before the summary:
```bash
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
```

2. [ ] **Run it, expect failure.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✗ telemetry/ not appended`, `✗ telemetry consent gate missing`, `✗ auto-review directive missing`, exit 1.

3. [ ] **Implement.** In `plugins/continuum/hooks/session_start.js`:
   (a) Add imports (after the existing import block):
```js
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { telemetryReviewsDir } from "../lib/paths.js";
```
   (b) Add `"telemetry/"` to the `giWanted` array (insert after `"screenshots/",`):
```js
    const giWanted = [
      "verification/",
      "runs/",
      "uploads/",
      "screenshots/",
      "telemetry/",
      ".env-provenance.json",
      "comms/*",
      "!comms/config.json",
    ];
```
   (c) Add a `telemetryGate(projectDir, source)` function next to `commsGate`:
```js
// Telemetry consent + auto-review gate (§7, §13.3). fs-only — emits directives;
// the agent does the asking/reviewing. Two independent opt-ins (M4): share +
// reviewAuto. Single-emit: the pending-review marker is consumed here.
function telemetryGate(projectDir, source) {
  let out = "";
  let cfg;
  try { cfg = readTelemetryConfig(projectDir); } catch { return ""; }
  if (cfg.killSwitch === "off") return ""; // fully disabled

  // 1) Undecided about SHARING → ask once, on a real init (startup/clear) only.
  if (!cfg.decided) {
    if (source === "startup" || source === "clear") {
      out +=
        "\n\n---\n\n" +
        "[continuum:telemetry] This repo hasn't decided about sharing anonymous usage telemetry. " +
        "Ask the user, once, with BOTH opt-ins (they are independent):\n" +
        "(1) *\"Help improve mochi? I can share **anonymous, content-free** usage stats — tool names, " +
        "counts, error types, durations — **never** your prompts, code, file contents, or messages. " +
        "You can see exactly what would be sent with `/mochi:telemetry show`. Share? (yes/no)\"*\n" +
        "(2) *\"Separately: enable **auto efficiency-review**? It reviews a sampled session with the " +
        "agent and **spends your own Claude tokens** (~a few thousand tokens per sampled session, " +
        "1-in-N sampling). Default off; `/mochi:review-session` is always available on demand. Enable? (yes/no)\"*\n" +
        "Write the answers immediately via `/mochi:telemetry on|off` and `/mochi:telemetry review-auto on|off` " +
        "so I never ask again. A rotating random install-id links your sessions over a short period; " +
        "lawful basis is your explicit consent; opt out + purge any time with `/mochi:telemetry off` / `/mochi:telemetry purge`.";
    }
    return out;
  }

  // 2) Decided + reviewAuto on → if a pending-review marker exists and the
  //    session is sampled, emit a one-shot auto-review directive and consume it.
  if (cfg.reviewAuto === true) {
    try {
      const markerPath = path.join(telemetryReviewsDir(projectDir), "..", ".pending-review.json");
      if (fs.existsSync(markerPath)) {
        let marker = {};
        try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch {}
        const n = Number(cfg.sampleN) > 0 ? Math.trunc(cfg.sampleN) : 10;
        const sampled = (Math.floor(Math.random() * n) === 0);
        try { fs.unlinkSync(markerPath); } catch {} // consume unconditionally (single-emit)
        if (sampled) {
          const archive = marker.archive_path || "(the most recent archived transcript)";
          out +=
            "\n\n---\n\n" +
            "[continuum:telemetry] Auto efficiency-review is on and the previous session was sampled. " +
            "Run `/mochi:review-session` against the archived transcript:\n\n`" + archive + "`\n\n" +
            "Read it, produce the Arm-2 critique + distillation, save the full critique locally under " +
            "`.continuum/telemetry/reviews/`, and (if sharing is on) emit the Zone-A distillation. " +
            "Keep it bounded — this spends the user's tokens.";
        }
      }
    } catch {}
  }
  return out;
}
```
   (d) Wire it into `main()` right after the comms gate append:
```js
  context += commsGate(projectDir, payload.source);
  context += telemetryGate(projectDir, payload.source);
```
   _(The marker lives at `.continuum/telemetry/.pending-review.json`; `telemetryReviewsDir(...)` is `.continuum/telemetry/reviews`, so `path.join(reviewsDir, "..", ".pending-review.json")` resolves to the telemetry dir. SessionEnd writes it in Task 17.)_

4. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh` (TT11/TT12/TT13 `✓`). Then `bash plugins/continuum/tests/run-synthetic.sh` — existing gitignore/comms tests still pass (`telemetry/` is additive; the gate is silent when undecided on `resume`).

5. [ ] **Commit.** `git add plugins/continuum/hooks/session_start.js plugins/continuum/tests/run-telemetry.sh && git commit -m "feat(telemetry): session_start two-toggle consent gate + sampled auto-review directive + telemetry/ gitignore"`

---

### Task 17: `session_end.js` close-event + flush + pending-review marker; `pre_compact.js` compaction counter

**Files:** Modify `plugins/continuum/hooks/session_end.js` / Modify `plugins/continuum/hooks/pre_compact.js` / append to `plugins/continuum/tests/run-telemetry.sh`.

1. [ ] **Write failing test.** Insert before the summary:
```bash
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
```

2. [ ] **Run it, expect failure.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✗ no pending-review marker`, `✗ pre_compact`, exit 1.

3. [ ] **Implement `session_end.js`.** Add imports (after the existing import block):
```js
import path from "node:path";
import { telemetryDir } from "../lib/paths.js";
import { appendEvent } from "../lib/telemetry_log.js";
import { redactEvent } from "../lib/telemetry_redact.js";
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { getInstallId } from "../lib/install_id.js";
import { flush as flushTelemetry } from "../lib/telemetry_emit.js";
```
   (`fs` is already imported; if not, add `import fs from "node:fs";`.) After the broker-unregister/archive block (before the user-visible message), insert:
```js
  // [telemetry] Close event + pending-review marker + flush. OFF the hot path —
  // SessionEnd is not per-tool. Never throws.
  try {
    const tcfg = readTelemetryConfig(projectDir);
    if (tcfg.killSwitch !== "off") {
      // Close event: only a reason CATEGORY survives the redactor (tool field).
      appendEvent(projectDir, redactEvent({
        ts: Math.floor(Date.now() / 1000),
        sid: sessionId || "",
        iid: getInstallId(),
        tool: "session_close",
        mcp: "",
        ok: why !== "error",
        err: why === "error" ? "other" : "",
        dur_b: "",
        v: process.env.MOCHI_PLUGIN_VERSION || "0.7.0",
        os: process.platform,
      }));
      // Pending-review marker (Arm-2 trigger; consumed by next SessionStart).
      if (tcfg.reviewAuto === true && archivePath) {
        const dir = telemetryDir(projectDir);
        fs.mkdirSync(dir, { recursive: true });
        const marker = { sid: sessionId || "", archive_path: archivePath, ts: Math.floor(Date.now() / 1000) };
        const tmp = path.join(dir, `.pending-review.json.${process.pid}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(marker));
        fs.renameSync(tmp, path.join(dir, ".pending-review.json"));
      }
      // Flush queued + new Zone-A events (re-checks the send-time gate; opted-out
      // => zero POST; fail-open). Bounded by the emit timeout.
      try { await flushTelemetry(projectDir, process.env); } catch {}
    }
  } catch {}
```
   _(`why`, `archivePath`, `sessionId`, `projectDir` are already in scope in `session_end.js`. If the local var names differ, adapt to the actual identifiers.)_

4. [ ] **Implement `pre_compact.js`.** Add imports (after the existing import block):
```js
import { appendEvent } from "../lib/telemetry_log.js";
import { redactEvent } from "../lib/telemetry_redact.js";
import { readConfig as readTelemetryConfig } from "../lib/telemetry_config.js";
import { getInstallId } from "../lib/install_id.js";
```
   Inside the existing `try` (after the sentinel write, before the `catch`), insert:
```js
    // [telemetry] Compaction counter — a Zone-A signal used to prioritize Arm-2
    // auto-review (§5 confusion heuristics). Reason is a CATEGORY only.
    try {
      const tcfg = readTelemetryConfig(projectDir);
      if (tcfg.killSwitch !== "off") {
        appendEvent(projectDir, redactEvent({
          ts: Math.floor(Date.now() / 1000),
          sid: sessionId || "",
          iid: getInstallId(),
          tool: "session_compact",
          mcp: "",
          ok: true,
          err: "",
          dur_b: matcher === "auto" ? "auto" : "manual", // coarse reason bucket
          v: process.env.MOCHI_PLUGIN_VERSION || "0.7.0",
          os: process.platform,
        }));
      }
    } catch {}
```

5. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh` (TT14/TT15 `✓`). Then `bash plugins/continuum/tests/run-synthetic.sh` — T5/T8 (PreCompact/SessionEnd archive + sentinel + systemMessage) still pass.

6. [ ] **Commit.** `git add plugins/continuum/hooks/session_end.js plugins/continuum/hooks/pre_compact.js plugins/continuum/tests/run-telemetry.sh && git commit -m "feat(telemetry): session_end close-event + flush + pending-review marker; pre_compact compaction counter"`

---

### Task 18: Command `telemetry.md` + CLI shim `telemetry_cli.js`

**Files:** Create `plugins/continuum/lib/telemetry_cli.js` / Create `plugins/continuum/commands/telemetry.md` / append to `plugins/continuum/tests/run-telemetry.sh`.

> The CLI drives every subcommand; `show` output is byte-identical to the emit payload (§13.1 N2 — same `redactEvent` serializer); `purge` deletes local telemetry; `reset-id` rotates.

1. [ ] **Write failing test.** Insert before the summary:
```bash
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
```

2. [ ] **Run it, expect failure.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✗` for the CLI lines (shim missing), exit 1.

3. [ ] **Implement `telemetry_cli.js`** (mirrors the `feedback_cli.js` / `recall_cli.js` `--project-dir` style). Create the file:
```js
#!/usr/bin/env node
// CLI shim for /mochi:telemetry. Subcommands: status | show | on | off |
// review-auto on|off | flush | reset-id | purge. All operate on an explicit
// --project-dir (never cwd for writes). `show` prints the IDENTICAL redacted
// payload that would POST (§13.1 N2) so the audit is byte-for-byte truthful.
import fs from "node:fs";
import { telemetryDir } from "./paths.js";
import { readConfig, writeConfig, isSharingEnabled, INGEST_URL } from "./telemetry_config.js";
import { readEvents } from "./telemetry_log.js";
import { redactEvent } from "./telemetry_redact.js";
import { aggregate } from "./telemetry_aggregate.js";
import { flush } from "./telemetry_emit.js";
import { getInstallId, resetInstallId } from "./install_id.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const projectDir = arg("--project-dir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sub = process.argv[2];
const TOKENS_PER_REVIEW = "~2,000-5,000";

function out(o) { process.stdout.write(typeof o === "string" ? o + "\n" : JSON.stringify(o, null, 2) + "\n"); }

function status() {
  const cfg = readConfig(projectDir);
  const events = readEvents(projectDir);
  out([
    "## mochi telemetry status",
    `- decided: ${cfg.decided}`,
    `- share (anonymous telemetry): ${cfg.share ? "on" : "off"}`,
    `- review-auto (efficiency review): ${cfg.reviewAuto ? "on" : "off"}  (cost: ${TOKENS_PER_REVIEW} of YOUR tokens per sampled session, 1-in-${cfg.sampleN} sampling)`,
    `- kill-switch: ${cfg.killSwitch}`,
    `- env MOCHI_TELEMETRY: ${process.env.MOCHI_TELEMETRY || "(unset)"}`,
    `- would send now: ${isSharingEnabled(cfg, process.env) ? "yes" : "no"}`,
    `- ingest endpoint: ${INGEST_URL}`,
    `- install-id: ${getInstallId()}`,
    `- local events: ${events.length}`,
  ].join("\n"));
}

function show() {
  const events = readEvents(projectDir).map(redactEvent);
  out([
    "## EXACTLY what is stored locally and would be sent (redacted Zone-A):",
    "",
    "### Events (the literal POST batch entries):",
    JSON.stringify(events, null, 2),
    "",
    "### Local aggregate (never sent; for your eyes):",
    JSON.stringify(aggregate(readEvents(projectDir)), null, 2),
  ].join("\n"));
}

async function main() {
  switch (sub) {
    case "status": return status();
    case "show": return show();
    case "on": writeConfig(projectDir, { decided: true, share: true }); return status();
    case "off": writeConfig(projectDir, { decided: true, share: false }); return status();
    case "review-auto": {
      const v = process.argv[3] === "on";
      writeConfig(projectDir, { decided: true, reviewAuto: v });
      return status();
    }
    case "flush": { await flush(projectDir, process.env); return out({ flushed: true }); }
    case "reset-id": { resetInstallId(); return out(getInstallId()); }
    case "purge": {
      const dir = telemetryDir(projectDir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return out({ purged: true, note: "Local telemetry deleted. For server-side erasure, the owner runs DELETE /v1/data?iid=<your id>." });
    }
    default: return out("usage: telemetry status|show|on|off|review-auto on|off|flush|reset-id|purge --project-dir <dir>");
  }
}
main();
```
   _(`reset-id` deletes the file via `resetInstallId()` then calls `getInstallId()` to mint + print the fresh id — matching the contract that `resetInstallId` itself returns nothing.)_

4. [ ] **Implement `commands/telemetry.md`** (matches the `feedback.md` / `comms-status.md` front-matter + `.continuum/.plugin-root` resolution convention — NOT `$CLAUDE_PLUGIN_ROOT`, per synthetic T29):
````markdown
---
description: Inspect, opt in/out of, and audit mochi's anonymous usage telemetry
allowed-tools: Bash, Read
argument-hint: status|show|on|off|review-auto on|off|flush|reset-id|purge
---

mochi can learn how its tools are used (anonymously, content-free) to improve. Local capture is always on unless the kill-switch is off; nothing leaves your machine unless you opt in. This command is your audit + control surface.

## Subcommands

- `status` — show consent state, kill-switch, install-id, local event count, and the **token cost** of auto-review.
- `show` — print **exactly** what is stored locally and what would be POSTed (the literal redacted Zone-A payload — never prompts/code/messages). Use this before opting in.
- `on` / `off` — opt in / out of sharing anonymous telemetry.
- `review-auto on|off` — enable/disable auto efficiency-review. **This spends your own Claude tokens.** `/mochi:review-session` is always available on demand regardless.
- `flush` — send queued events now (only if opted in).
- `reset-id` — rotate your anonymous install-id.
- `purge` — delete all local telemetry. (For server-side erasure, the owner runs `DELETE /v1/data?iid=<id>`.)

Run the requested subcommand:

```bash
node "$(cat .continuum/.plugin-root)/lib/telemetry_cli.js" $ARGUMENTS --project-dir "$(pwd)"
```

Show the output to the user verbatim. For `show`, emphasize that this is byte-for-byte what would be sent — there is no hidden payload.
````

5. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh` (all TT16 `✓`), exit 0.

6. [ ] **Commit.** `git add plugins/continuum/lib/telemetry_cli.js plugins/continuum/commands/telemetry.md plugins/continuum/tests/run-telemetry.sh && git commit -m "feat(telemetry): /mochi:telemetry command + CLI (status/show/on/off/review-auto/flush/reset-id/purge); show===emit redact"`

---

### Task 19: Commands `review-session.md` (Arm-2) + `insights.md` (owner) + `telemetry_review_cli.js` + register all three in `plugin.json`

**Files:** Create `plugins/continuum/commands/review-session.md` / Create `plugins/continuum/commands/insights.md` / Create `plugins/continuum/lib/telemetry_review_cli.js` / Modify `.claude-plugin/plugin.json` / append to `plugins/continuum/tests/run-telemetry.sh`.

1. [ ] **Write failing test.** Insert before the summary:
```bash
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
```

2. [ ] **Run it, expect failure.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh`. Expected: `✗ missing review-session.md`, `✗ ... NOT registered`, etc., exit 1.

3. [ ] **Implement `commands/review-session.md`** (Arm-2: agent reads the archived transcript, emits the distillation via the redactor, then offers Arm-3 over GitHub only):
````markdown
---
description: Arm-2 — critique the current/last session for efficiency & quality, emit a Zone-A distillation, offer a deliberate GitHub feedback report
allowed-tools: Bash, Read
argument-hint: "[N | latest | <archive path>]"
---

Review a session to find where tool calls could have been leaner and surface concrete improvements. This runs locally with full content — the **full critique stays on this machine (Zone B)**; only a categorical distillation may leave (Zone A), and only if telemetry sharing is on.

## Steps

1. **Find the transcript.** If `$ARGUMENTS` names an archive path, use it. Otherwise read the latest archived transcript:

```bash
node "$(cat .continuum/.plugin-root)/lib/render_archive.js" --project-dir "$(pwd)" --latest
```

   Use `zcat` on the archived `.jsonl.gz` if you need the raw turns.

2. **Critique it.** Produce a structured critique. Choose `task_category`, `redundancy_pattern`, `suggestion_tag`, and `severity` from the SHIPPED enums (in `lib/telemetry_redact.js` — `TASK_ENUM`, `REDUNDANCY_ENUM`, `SUGGESTION_ENUM`, `SEVERITY_ENUM`); use `"other"` when nothing fits. Count `tool_calls` and estimate `efficiency_score` (0-1). Write `suggestion_text` (human-readable advice) and `quality_issue` as free text — **these are Zone B and never leave**.

3. **Save the full critique locally** (Zone B) under `.continuum/telemetry/reviews/` and show it to the user — this is the part that actually helps them.

4. **Emit the Zone-A distillation.** Pass the categorical-only fields through the redactor and append it as a telemetry line (flushed only if sharing is on). The redactor drops `suggestion_text`/`quality_issue` structurally:

```bash
node "$(cat .continuum/.plugin-root)/lib/telemetry_review_cli.js" emit --project-dir "$(pwd)" \
  --distillation '{"task_category":"...","tool_calls":0,"efficiency_score":0,"redundancy_pattern":"...","suggestion_tag":"...","severity":"..."}'
```

5. **Offer Arm-3 (deliberate context report).** Ask: *"Share the full critique as a feedback report? (y/n)"* — if yes, route it through **`/mochi:feedback` (GitHub issues via `gh`) ONLY**. Deliberate context reports are **NOT** sent to the telemetry ingest server (`/v1/ingest` validates Zone-A and would strip them). This is the only path by which deep context leaves, and only on explicit human confirmation.
````

4. [ ] **Implement `lib/telemetry_review_cli.js`** so step 4 is concrete:
```js
#!/usr/bin/env node
// CLI for /mochi:review-session: append a redacted Zone-A distillation as a
// telemetry line (Zone-B free text is structurally dropped by the redactor).
import { appendEvent } from "./telemetry_log.js";
import { redactDistillation } from "./telemetry_redact.js";
import { getInstallId } from "./install_id.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const projectDir = arg("--project-dir") || process.cwd();
if (process.argv[2] === "emit") {
  let raw = {};
  try { raw = JSON.parse(arg("--distillation") || "{}"); } catch {}
  const dist = redactDistillation(raw);
  appendEvent(projectDir, {
    ts: Math.floor(Date.now() / 1000),
    iid: getInstallId(),
    ...dist,
  });
  process.stdout.write(JSON.stringify({ emitted: dist }, null, 2) + "\n");
} else {
  process.stdout.write("usage: telemetry_review_cli emit --distillation '<json>' --project-dir <dir>\n");
}
```
   _(The Phase-2 aggregate treats rows carrying `task_category` as distillation rows, so these lines feed the backlog directly.)_

5. [ ] **Implement `commands/insights.md`** (owner-only: fetch `/v1/summary`):
````markdown
---
description: Owner-only — fetch and print the mochi-insight server's aggregate summary
allowed-tools: Bash, Read
argument-hint: "(owner bearer/credentials required)"
---

For the **plugin owner only**. Fetches aggregated, content-free usage insights from the self-hosted ingest server and prints them. Regular users do not have credentials and should use `/mochi:telemetry show` for their own local view.

1. Confirm the owner has the dashboard bearer token (or basic-auth) — never hard-code it.
2. Fetch and pretty-print the summary:

```bash
curl -fsS -H "authorization: Bearer $MOCHI_DASHBOARD_TOKEN" \
  https://mochi-insight.nexalance.cloud/v1/summary | python3 -m json.tool
```

Render the result as: top tools, top MCPs, per-tool error rates, tool co-occurrence, calls-per-task, tools-per-task-category, and the ranked improvement backlog. If the request 401s, the token is missing/wrong; if it times out, check the server health at `/v1/health`.
````

6. [ ] **Register all three in `.claude-plugin/plugin.json`** `commands[]` (after the existing continuum command entries):
```json
    "./plugins/continuum/commands/telemetry.md",
    "./plugins/continuum/commands/review-session.md",
    "./plugins/continuum/commands/insights.md",
```

7. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-telemetry.sh` (all TT17 `✓`). Validate JSON: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'));console.log('plugin.json OK')"`.

8. [ ] **Commit.** `git add plugins/continuum/commands/review-session.md plugins/continuum/commands/insights.md plugins/continuum/lib/telemetry_review_cli.js .claude-plugin/plugin.json plugins/continuum/tests/run-telemetry.sh && git commit -m "feat(telemetry): /mochi:review-session (Arm-2 + Arm-3 GitHub-only) + /mochi:insights; register all three commands"`

---

### Task 20: Wire `run-telemetry.sh` into the umbrella plugin suite

**Files:** Modify `plugins/continuum/tests/run-synthetic.sh`.

1. [ ] **Implement.** Read `plugins/continuum/tests/run-synthetic.sh`, locate where sibling runners (`run-comms-recall.sh`, `run-popup-synthetic.mjs`) are invoked, and add immediately after them (match the file's actual `TESTS_DIR`/fail-accumulator variable names):
```bash
echo; echo "=== telemetry hooks/commands ==="; bash "$TESTS_DIR/run-telemetry.sh" || SUITE_FAIL=1
```

2. [ ] **Run pass.** Cmd: `bash plugins/continuum/tests/run-synthetic.sh`. Expected: the telemetry section prints `passed: …` with `failed: 0` and the suite exits 0.

3. [ ] **Commit.** `git add plugins/continuum/tests/run-synthetic.sh && git commit -m "test(telemetry): wire run-telemetry.sh into the umbrella plugin suite"`

## Phase 4 — Ingest Server (`telemetry-server/`)

Self-hosted Zone-A ingest + dashboard. Node 22 ESM, built-in `http`/`crypto` only (no deps). Tests colocated `*.test.mjs`, run via `node --test`. The server re-implements the SAME Zone-A whitelist/enum/allowlist logic as the plugin redactor (copied — separate infra) so a tampered client can never inject content (§6, §13.1, §13.5). The server redactor's enums are byte-identical to the plugin's (Shared Contracts).

---

### Task 21: Scaffold `telemetry-server/` — package.json (type:module) + node --test wiring

**Files:** Create `telemetry-server/package.json` / Create `telemetry-server/_server_pkg.test.mjs`.

1. [ ] **Write failing test.** Create `telemetry-server/_server_pkg.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

test("package is ESM and dependency-free (built-in http/crypto only)", () => {
  assert.equal(pkg.type, "module", "must be type:module");
  assert.ok(pkg.private === true, "must be private");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "no runtime deps — built-in http/crypto only");
});

test("test script runs colocated *.test.mjs via node --test", () => {
  assert.ok(/node --test/.test(pkg.scripts.test), "test script must use node --test");
});

test("start script launches the server", () => {
  assert.equal(pkg.scripts.start, "node server.mjs", "start must run server.mjs");
});

test("engines require node >=22", () => {
  assert.ok(/>=\s*22/.test(pkg.engines.node), "must require node >=22");
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _server_pkg.test.mjs`. Expected: `ENOENT` (package.json absent).

3. [ ] **Implement.** Create `telemetry-server/package.json`:
```json
{
  "name": "mochi-insight-telemetry-server",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Mochi Insight Zone-A telemetry ingest + owner dashboard. Self-hosted on Dokploy. Node 22 ESM, no runtime deps.",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test"
  },
  "engines": { "node": ">=22" }
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _server_pkg.test.mjs`. Expected: `# pass 4  # fail 0`.

5. [ ] **Commit.** `git add telemetry-server/package.json telemetry-server/_server_pkg.test.mjs && git commit -m "test(telemetry-server): scaffold ESM package + node --test wiring"`

---

### Task 22: `telemetry_redact.js` (server copy) — enums, allowlists, Zone-A whitelist serializer

**Files:** Create `telemetry-server/telemetry_redact.js` / Create `telemetry-server/_redact.test.mjs`.

> Enums + allowlists are byte-identical to the plugin's `telemetry_redact.js` (Shared Contracts). This is the server-side defense-in-depth guard: a tampered client can POST anything, so the server re-applies the identical whitelist/enum/allowlist logic before any write.

1. [ ] **Write failing test.** Create `telemetry-server/_redact.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM, SEVERITY_ENUM,
  ALLOW_TOOLS, ALLOW_MCPS, ZONE_A_EVENT_KEYS, ZONE_A_DISTILL_KEYS,
  redactEvent, redactDistillation,
} from "./telemetry_redact.js";

test("enums match the canonical Shared Contracts set", () => {
  assert.deepEqual(ERR_ENUM, ["timeout","not_found","bad_input","permission","network","other"]);
  assert.deepEqual(TASK_ENUM, ["web-qa","coding","refactor","debug","research","docs","comms","other"]);
  assert.deepEqual(SEVERITY_ENUM, ["low","medium","high","other"]);
  for (const e of [ERR_ENUM, TASK_ENUM, REDUNDANCY_ENUM, SUGGESTION_ENUM]) assert.ok(e.includes("other"));
});

test("event keys are exactly the Zone-A contract — NO model field", () => {
  assert.deepEqual([...ZONE_A_EVENT_KEYS].sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"].sort());
  assert.ok(!ZONE_A_EVENT_KEYS.includes("model"), "model removed per §13.6");
});

test("redactEvent whitelists known keys and DROPS everything else", () => {
  const out = redactEvent({
    ts: 1717900000, sid: "s1", iid: "i1", tool: "browser_click", mcp: "mochi_browser",
    ok: true, err: "other", dur_b: "1-3s", v: "0.7.0", os: "darwin",
    prompt: "the user said hello", model: "claude-opus", secret: "sk-live-123",
    tool_input: { url: "https://client.example/secret" },
  });
  assert.deepEqual(Object.keys(out).sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"].sort());
  const s = JSON.stringify(out);
  for (const leak of ["prompt","hello","model","claude","secret","sk-live","client.example"]) {
    assert.ok(!s.includes(leak), `Zone-A payload must not contain "${leak}"`);
  }
});

test("B1 — non-allowlisted tool/mcp names are bucketed", () => {
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", ok: true, err: "other", dur_b: "0-1s", v: "0.7.0", os: "linux",
    tool: "mcp__client_secret_project__do_thing", mcp: "client_secret_project" });
  assert.equal(out.tool, "thirdparty_tool");
  assert.equal(out.mcp, "thirdparty_mcp");
  assert.ok(!JSON.stringify(out).includes("client_secret_project"));
});

test("known mochi/built-in tool + mcp names pass through verbatim", () => {
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", ok: true, err: "other", dur_b: "0-1s", v: "0.7.0", os: "linux",
    tool: "browser_click", mcp: "mochi_browser" });
  assert.equal(out.tool, "browser_click");
  assert.equal(out.mcp, "mochi_browser");
});

test("B2 — bad err value coerced to enum-or-other, raw string absent", () => {
  const out = redactEvent({ ts: 1, sid: "s", iid: "i", tool: "Read", mcp: "", ok: false,
    err: "/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-abc", dur_b: "1-3s", v: "0.7.0", os: "darwin" });
  assert.ok(["network","other"].includes(out.err));
  assert.ok(!JSON.stringify(out).includes("sk-live"));
  assert.ok(!JSON.stringify(out).includes("ECONNREFUSED"));
});

test("redactDistillation whitelists categorical keys; Zone-B free text dropped", () => {
  const out = redactDistillation({
    task_category: "web-qa", tool_calls: 10, efficiency_score: 0.4,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "medium",
    suggestion_text: "advice mentioning /secret", quality_issue: "missing_assertion in /Users/j/login.test.ts",
  });
  assert.deepEqual([...ZONE_A_DISTILL_KEYS].sort(), Object.keys(out).sort());
  assert.ok(!("suggestion_text" in out) && !("quality_issue" in out));
  assert.ok(!JSON.stringify(out).includes("/secret") && !JSON.stringify(out).includes("login.test.ts"));
});

test("B2 — distillation categoricals coerced to enum-or-other", () => {
  const out = redactDistillation({ task_category: "made up /etc/passwd", tool_calls: "10", efficiency_score: 1.5,
    redundancy_pattern: "leak sk-live", suggestion_tag: "free text", severity: "EXTREME" });
  assert.equal(out.task_category, "other");
  assert.equal(out.redundancy_pattern, "other");
  assert.equal(out.suggestion_tag, "other");
  assert.equal(out.severity, "other");
  assert.equal(typeof out.tool_calls, "number");
  assert.ok(out.efficiency_score >= 0 && out.efficiency_score <= 1);
  assert.ok(!JSON.stringify(out).includes("passwd") && !JSON.stringify(out).includes("sk-live"));
});

test("redactEvent returns null for non-object input (fail-closed)", () => {
  assert.equal(redactEvent(null), null);
  assert.equal(redactEvent("a string"), null);
  assert.equal(redactEvent(42), null);
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _redact.test.mjs`. Expected: `Cannot find module './telemetry_redact.js'`.

3. [ ] **Implement.** Create `telemetry-server/telemetry_redact.js`:
```js
// telemetry-server/telemetry_redact.js
// Server-side COPY of the plugin's Zone-A redactor (telemetry-server is separate
// infra — it must not import plugin code). Privacy keystone + defense-in-depth
// (§13.1, §13.5): a tampered client can POST anything, so the server re-applies
// the identical whitelist/enum/allowlist logic before any write. Fail-closed.
// Enums are byte-identical to plugins/continuum/lib/telemetry_redact.js.

export const ERR_ENUM = ["timeout", "not_found", "bad_input", "permission", "network", "other"];
export const TASK_ENUM = ["web-qa", "coding", "refactor", "debug", "research", "docs", "comms", "other"];
export const REDUNDANCY_ENUM = ["snapshot_then_retry", "repeated_read", "repeated_edit", "retry_loop", "redundant_navigation", "none", "other"];
export const SUGGESTION_ENUM = ["batch_clicks", "use_recall", "fewer_snapshots", "assert_first", "narrower_selector", "reuse_workflow", "none", "other"];
export const SEVERITY_ENUM = ["low", "medium", "high", "other"];

export const ALLOW_MCPS = new Set(["mochi_browser", "mochi_comms", "mochi_continuum", "continuum"]);
export const ALLOW_TOOLS = new Set([
  "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Task", "WebFetch", "WebSearch",
  "NotebookEdit", "TodoWrite", "MultiEdit",
  "browser_navigate", "browser_click", "browser_click_at", "browser_type", "browser_snapshot",
  "browser_snapshot_query", "browser_evaluate", "browser_screenshot", "browser_wait",
  "browser_assert", "browser_assert_no_errors", "browser_console_messages",
  "browser_network_requests", "browser_scroll", "browser_press_key", "browser_links",
  "browser_text", "browser_session_start", "browser_session_end",
  "comms_link_account", "comms_account_status", "comms_list_chats", "comms_list_groups",
  "comms_get_messages", "comms_recall", "comms_set_allowlist", "comms_sync_now",
  "comms_import_history", "comms_unlink_account",
  "recall", "session_close", "session_compact",
]);

export const ZONE_A_EVENT_KEYS = ["ts", "sid", "iid", "tool", "mcp", "ok", "err", "dur_b", "v", "os"];
export const ZONE_A_DISTILL_KEYS = ["task_category", "tool_calls", "efficiency_score", "redundancy_pattern", "suggestion_tag", "severity"];

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const str = (x, max = 64) => (typeof x === "string" ? x.slice(0, max) : String(x ?? "").slice(0, max));
const enumOrOther = (x, enumArr) => (enumArr.includes(x) ? x : "other");
const numOr = (x, fb) => { const n = typeof x === "number" ? x : Number(x); return Number.isFinite(n) ? n : fb; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function bucketTool(t) { return ALLOW_TOOLS.has(t) ? t : "thirdparty_tool"; }
function bucketMcp(m) { return m === "" ? "" : (ALLOW_MCPS.has(m) ? m : "thirdparty_mcp"); }

export function redactEvent(raw) {
  if (!isObj(raw)) return null;
  return {
    ts: Math.trunc(numOr(raw.ts, 0)),
    sid: str(raw.sid, 64),
    iid: str(raw.iid, 64),
    tool: bucketTool(str(raw.tool, 80)),
    mcp: bucketMcp(str(raw.mcp, 80)),
    ok: raw.ok === true || raw.ok === "true",
    err: str(raw.err) === "" ? "" : enumOrOther(raw.err, ERR_ENUM),
    dur_b: str(raw.dur_b, 16),
    v: str(raw.v, 24),
    os: str(raw.os, 24),
  };
}

export function redactDistillation(raw) {
  if (!isObj(raw)) return null;
  return {
    task_category: enumOrOther(raw.task_category, TASK_ENUM),
    tool_calls: Math.trunc(clamp(numOr(raw.tool_calls, 0), 0, 100000)),
    efficiency_score: clamp(numOr(raw.efficiency_score, 0), 0, 1),
    redundancy_pattern: enumOrOther(raw.redundancy_pattern, REDUNDANCY_ENUM),
    suggestion_tag: enumOrOther(raw.suggestion_tag, SUGGESTION_ENUM),
    severity: enumOrOther(raw.severity, SEVERITY_ENUM),
  };
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _redact.test.mjs`. Expected: all pass.

5. [ ] **Commit.** `git add telemetry-server/telemetry_redact.js telemetry-server/_redact.test.mjs && git commit -m "feat(telemetry-server): server-side Zone-A redactor (canonical enums, bucketing, whitelist serializer)"`

---

### Task 23: `store.mjs` — date-bucketed JSONL append + retention sweep + iid drop + erasure

**Files:** Create `telemetry-server/store.mjs` / Create `telemetry-server/_store.test.mjs`.

1. [ ] **Write failing test.** Create `telemetry-server/_store.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dayBucket, eventsPath, appendEvents, readAllEvents, sweepRetention, eraseIid } from "./store.mjs";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tele-store-")); }

test("dayBucket converts epoch-seconds ts to YYYY-MM-DD (UTC)", () => {
  assert.equal(dayBucket(1717900000), "2024-06-09");
});

test("appendEvents writes one JSONL line per event to /data/events/<day>.jsonl", () => {
  const dir = tmp();
  appendEvents(dir, [{ ts: 1717900000, tool: "Read" }, { ts: 1717900001, tool: "Edit" }]);
  const p = eventsPath(dir, "2024-06-09");
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).tool, "Read");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendEvents day-buckets by each event's own ts (cross-midnight)", () => {
  const dir = tmp();
  appendEvents(dir, [{ ts: 1717900000, tool: "A" }, { ts: 1718000000, tool: "B" }]);
  assert.ok(fs.existsSync(eventsPath(dir, "2024-06-09")));
  assert.ok(fs.existsSync(eventsPath(dir, "2024-06-10")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readAllEvents reads every day-file back as parsed objects", () => {
  const dir = tmp();
  appendEvents(dir, [{ ts: 1717900000, tool: "A" }, { ts: 1718000000, tool: "B" }]);
  const all = readAllEvents(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.tool).sort(), ["A", "B"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepRetention deletes day-files older than RETENTION_DAYS", () => {
  const dir = tmp();
  const evDir = path.join(dir, "events");
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, "2000-01-01.jsonl"), "{}\n");
  const today = dayBucket(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(evDir, `${today}.jsonl`), "{}\n");
  const removed = sweepRetention(dir, 180, Date.now());
  assert.ok(removed.includes("2000-01-01.jsonl"));
  assert.ok(!fs.existsSync(path.join(evDir, "2000-01-01.jsonl")));
  assert.ok(fs.existsSync(path.join(evDir, `${today}.jsonl`)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepRetention drops iid after the dedup window (keeps aggregate fields)", () => {
  const dir = tmp();
  const oldTs = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const day = dayBucket(oldTs);
  appendEvents(dir, [{ ts: oldTs, iid: "i-secret", tool: "Read", mcp: "", ok: true }]);
  sweepRetention(dir, 180, Date.now(), { dedupWindowDays: 7 });
  const lines = fs.readFileSync(eventsPath(dir, day), "utf8").split("\n").filter(Boolean);
  const ev = JSON.parse(lines[0]);
  assert.ok(!("iid" in ev) || ev.iid === "", "iid dropped after dedup window");
  assert.equal(ev.tool, "Read", "aggregate fields preserved");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("eraseIid removes every stored event for an iid (GDPR erasure), returns count", () => {
  const dir = tmp();
  appendEvents(dir, [
    { ts: 1717900000, iid: "i-erase", tool: "A" },
    { ts: 1717900001, iid: "i-keep", tool: "B" },
    { ts: 1718000000, iid: "i-erase", tool: "C" },
  ]);
  const removed = eraseIid(dir, "i-erase");
  assert.equal(removed, 2);
  const left = readAllEvents(dir);
  assert.deepEqual(left.map((e) => e.iid), ["i-keep"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _store.test.mjs`. Expected: `Cannot find module './store.mjs'`.

3. [ ] **Implement.** Create `telemetry-server/store.mjs`:
```js
// telemetry-server/store.mjs
// Date-bucketed JSONL persistence on the /data volume. No DB (§6). Mirrors the
// append+prune discipline of server/src/memory.js run-history. All retention,
// iid-dropping (§13.4) and erasure (§13.4 DELETE) operate over plain day-files.
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayBucket(tsSeconds) {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
export function eventsDir(dataDir) { return path.join(dataDir, "events"); }
export function eventsPath(dataDir, day) { return path.join(eventsDir(dataDir), `${day}.jsonl`); }

export function appendEvents(dataDir, events) {
  const byDay = new Map();
  for (const e of events) {
    const day = dayBucket(typeof e.ts === "number" ? e.ts : 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(JSON.stringify(e));
  }
  fs.mkdirSync(eventsDir(dataDir), { recursive: true });
  for (const [day, lines] of byDay) {
    fs.appendFileSync(eventsPath(dataDir, day), lines.join("\n") + "\n");
  }
}

function dayFiles(dataDir) {
  const dir = eventsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
}

export function readAllEvents(dataDir) {
  const out = [];
  for (const f of dayFiles(dataDir)) {
    const txt = fs.readFileSync(path.join(eventsDir(dataDir), f), "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
  }
  return out;
}

// Expire whole day-files older than retentionDays; within still-kept files,
// strip `iid` from events older than the dedup window. Returns removed filenames.
export function sweepRetention(dataDir, retentionDays, nowMs = Date.now(), { dedupWindowDays = 7 } = {}) {
  const removed = [];
  const cutoffExpire = nowMs - retentionDays * DAY_MS;
  const cutoffDedup = Math.floor((nowMs - dedupWindowDays * DAY_MS) / 1000);
  for (const f of dayFiles(dataDir)) {
    const day = f.slice(0, 10);
    const dayMs = Date.parse(day + "T00:00:00Z");
    if (Number.isFinite(dayMs) && dayMs < cutoffExpire) {
      fs.rmSync(path.join(eventsDir(dataDir), f), { force: true });
      removed.push(f);
      continue;
    }
    const p = path.join(eventsDir(dataDir), f);
    let changed = false;
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return line; }
      if ("iid" in ev && typeof ev.ts === "number" && ev.ts < cutoffDedup) {
        delete ev.iid; changed = true; return JSON.stringify(ev);
      }
      return line;
    });
    if (changed) fs.writeFileSync(p, lines.join("\n") + "\n");
  }
  return removed;
}

// Owner-triggered erasure for a single install-id across all day-files.
export function eraseIid(dataDir, iid) {
  let removed = 0;
  for (const f of dayFiles(dataDir)) {
    const p = path.join(eventsDir(dataDir), f);
    const kept = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { kept.push(line); continue; }
      if (ev.iid === iid) { removed++; continue; }
      kept.push(line);
    }
    if (kept.length) fs.writeFileSync(p, kept.join("\n") + "\n");
    else fs.rmSync(p, { force: true });
  }
  return removed;
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _store.test.mjs`. Expected: all pass.

5. [ ] **Commit.** `git add telemetry-server/store.mjs telemetry-server/_store.test.mjs && git commit -m "feat(telemetry-server): date-bucketed JSONL store + retention sweep + iid-drop + erasure"`

---

### Task 24: `aggregate.mjs` — Zone-A aggregates incl. tools-per-task-category + improvement backlog

**Files:** Create `telemetry-server/aggregate.mjs` / Create `telemetry-server/_aggregate.test.mjs`.

> The server dashboard renders this shape: `{topTools[{name,count}], topMcps[{name,count}], errorRates[{tool,total,fail,rate}], sequences[{from,to,count}], callsPerTask[{task_category,count,avgCalls}], toolsPerTaskCategory[{task_category,tools[{name,count}]}], backlog[{suggestion_tag,count,topRedundancy,lowConfidence}]}`. (This is the server-internal aggregate shape consumed by `dashboard.mjs`; it intentionally differs from the plugin's `aggregate` shape, which feeds `/mochi:telemetry show`.) A distillation event is tagged `kind:"distill"`.

1. [ ] **Write failing test.** Create `telemetry-server/_aggregate.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "./aggregate.mjs";

const EVENTS = [
  { ts: 1, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other" },
  { ts: 2, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: false, err: "timeout" },
  { ts: 3, sid: "s1", tool: "browser_snapshot", mcp: "mochi_browser", ok: true, err: "other" },
  { ts: 4, sid: "s2", tool: "Read", mcp: "", ok: true, err: "other" },
  { kind: "distill", task_category: "web-qa", tool_calls: 10, efficiency_score: 0.4,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "medium" },
  { kind: "distill", task_category: "web-qa", tool_calls: 8, efficiency_score: 0.5,
    redundancy_pattern: "snapshot_then_retry", suggestion_tag: "batch_clicks", severity: "low" },
];

test("topTools ranks tool usage by count", () => {
  const a = aggregate(EVENTS);
  assert.equal(a.topTools[0].name, "browser_click");
  assert.equal(a.topTools[0].count, 2);
});

test("topMcps ranks mcp usage by count", () => {
  const a = aggregate(EVENTS);
  assert.equal(a.topMcps.find((m) => m.name === "mochi_browser").count, 3);
});

test("errorRates reports fail/total per tool", () => {
  const a = aggregate(EVENTS);
  const click = a.errorRates.find((e) => e.tool === "browser_click");
  assert.equal(click.total, 2);
  assert.equal(click.fail, 1);
  assert.ok(Math.abs(click.rate - 0.5) < 1e-9);
});

test("sequences counts adjacent tool->tool co-occurrence within a session", () => {
  const a = aggregate(EVENTS);
  const seq = a.sequences.find((s) => s.from === "browser_click" && s.to === "browser_snapshot");
  assert.ok(seq && seq.count >= 1);
  assert.ok(!a.sequences.some((s) => s.to === "Read" && s.from === "browser_snapshot"));
});

test("callsPerTask buckets tool_calls per task_category from distillations", () => {
  const a = aggregate(EVENTS);
  const webqa = a.callsPerTask.find((c) => c.task_category === "web-qa");
  assert.equal(webqa.count, 2);
  assert.equal(webqa.avgCalls, 9);
});

test("toolsPerTaskCategory maps each task_category to its tools+counts (N3)", () => {
  const tagged = [
    { ts: 1, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", task_category: "web-qa" },
    { ts: 2, sid: "s1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", task_category: "web-qa" },
    { ts: 3, sid: "s2", tool: "Read", mcp: "", ok: true, err: "other", task_category: "coding" },
  ];
  const a = aggregate(tagged);
  const webqa = a.toolsPerTaskCategory.find((t) => t.task_category === "web-qa");
  assert.equal(webqa.tools[0].name, "browser_click");
  assert.equal(webqa.tools[0].count, 2);
  assert.equal(a.toolsPerTaskCategory.find((t) => t.task_category === "coding").tools[0].name, "Read");
});

test("backlog ranks suggestion_tags with counts + example redundancy + confidence", () => {
  const a = aggregate(EVENTS);
  assert.equal(a.backlog[0].suggestion_tag, "batch_clicks");
  assert.equal(a.backlog[0].count, 2);
  assert.equal(a.backlog[0].topRedundancy, "snapshot_then_retry");
  assert.ok("lowConfidence" in a.backlog[0]);
});

test("aggregate is robust to empty input", () => {
  const a = aggregate([]);
  assert.deepEqual(a.topTools, []);
  assert.deepEqual(a.backlog, []);
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _aggregate.test.mjs`. Expected: `Cannot find module './aggregate.mjs'`.

3. [ ] **Implement.** Create `telemetry-server/aggregate.mjs`:
```js
// telemetry-server/aggregate.mjs
// Pure JS aggregation over Zone-A events. Powers /v1/summary and /dashboard.
// All counts are UNTRUSTED lower-confidence signal (§13.5) — surfaced with a
// lowConfidence flag where volume is thin.
const LOW_CONFIDENCE_THRESHOLD = 5;
function isDistill(e) { return e && e.kind === "distill"; }
function rank(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function aggregate(events) {
  const evs = Array.isArray(events) ? events : [];
  const usage = evs.filter((e) => e && !isDistill(e) && typeof e.tool === "string");
  const distills = evs.filter(isDistill);

  const toolCounts = new Map();
  const mcpCounts = new Map();
  const errBuckets = new Map();
  const seqCounts = new Map();
  const toolsByTask = new Map();
  const bySession = new Map();

  for (const e of usage) {
    toolCounts.set(e.tool, (toolCounts.get(e.tool) || 0) + 1);
    if (e.mcp) mcpCounts.set(e.mcp, (mcpCounts.get(e.mcp) || 0) + 1);
    const b = errBuckets.get(e.tool) || { total: 0, fail: 0 };
    b.total++; if (e.ok === false) b.fail++;
    errBuckets.set(e.tool, b);
    if (typeof e.task_category === "string") {
      if (!toolsByTask.has(e.task_category)) toolsByTask.set(e.task_category, new Map());
      const tm = toolsByTask.get(e.task_category);
      tm.set(e.tool, (tm.get(e.tool) || 0) + 1);
    }
    const sid = e.sid ?? "_";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ tool: e.tool, ts: e.ts || 0 });
  }

  for (const stream of bySession.values()) {
    stream.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < stream.length; i++) {
      const key = stream[i - 1].tool + " " + stream[i].tool;
      seqCounts.set(key, (seqCounts.get(key) || 0) + 1);
    }
  }

  const taskAgg = new Map();
  const sugAgg = new Map();
  for (const d of distills) {
    const tc = d.task_category ?? "other";
    const ta = taskAgg.get(tc) || { count: 0, sumCalls: 0 };
    ta.count++; ta.sumCalls += Number(d.tool_calls) || 0;
    taskAgg.set(tc, ta);
    const tag = d.suggestion_tag ?? "other";
    const sa = sugAgg.get(tag) || { count: 0, redundancy: new Map() };
    sa.count++;
    if (d.redundancy_pattern) sa.redundancy.set(d.redundancy_pattern, (sa.redundancy.get(d.redundancy_pattern) || 0) + 1);
    sugAgg.set(tag, sa);
  }

  return {
    topTools: rank(toolCounts),
    topMcps: rank(mcpCounts),
    errorRates: [...errBuckets.entries()]
      .map(([tool, b]) => ({ tool, total: b.total, fail: b.fail, rate: b.total ? b.fail / b.total : 0 }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total),
    sequences: [...seqCounts.entries()]
      .map(([k, count]) => { const [from, to] = k.split(" "); return { from, to, count }; })
      .sort((a, b) => b.count - a.count),
    callsPerTask: [...taskAgg.entries()]
      .map(([task_category, t]) => ({ task_category, count: t.count, avgCalls: t.count ? t.sumCalls / t.count : 0 }))
      .sort((a, b) => b.count - a.count),
    toolsPerTaskCategory: [...toolsByTask.entries()]
      .map(([task_category, tm]) => ({ task_category, tools: rank(tm) }))
      .sort((a, b) => b.tools.reduce((s, x) => s + x.count, 0) - a.tools.reduce((s, x) => s + x.count, 0)),
    backlog: [...sugAgg.entries()]
      .map(([suggestion_tag, s]) => ({
        suggestion_tag, count: s.count,
        topRedundancy: rank(s.redundancy)[0]?.name ?? null,
        lowConfidence: s.count < LOW_CONFIDENCE_THRESHOLD,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _aggregate.test.mjs`. Expected: all pass.

5. [ ] **Commit.** `git add telemetry-server/aggregate.mjs telemetry-server/_aggregate.test.mjs && git commit -m "feat(telemetry-server): Zone-A aggregation incl tools-per-task-category + improvement backlog"`

---

### Task 25: `auth.mjs` — write-key check + constant-time owner auth + token-bucket rate-limit

**Files:** Create `telemetry-server/auth.mjs` / Create `telemetry-server/_auth.test.mjs`.

1. [ ] **Write failing test.** Create `telemetry-server/_auth.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr, checkWriteKey, checkOwner, TokenBucket } from "./auth.mjs";

test("timingSafeEqualStr matches equal strings, rejects unequal/length-mismatch", () => {
  assert.equal(timingSafeEqualStr("abc123", "abc123"), true);
  assert.equal(timingSafeEqualStr("abc123", "abc124"), false);
  assert.equal(timingSafeEqualStr("abc", "abc123"), false);
  assert.equal(timingSafeEqualStr("", "x"), false);
});

test("checkWriteKey requires exact x-mochi-key header (constant-time)", () => {
  assert.equal(checkWriteKey({ "x-mochi-key": "secret-key" }, "secret-key"), true);
  assert.equal(checkWriteKey({ "x-mochi-key": "wrong" }, "secret-key"), false);
  assert.equal(checkWriteKey({}, "secret-key"), false);
});

test("checkWriteKey rejects when server key is unset (fail-closed)", () => {
  assert.equal(checkWriteKey({ "x-mochi-key": "anything" }, ""), false);
  assert.equal(checkWriteKey({ "x-mochi-key": "anything" }, undefined), false);
});

test("checkOwner accepts a correct Bearer token (constant-time)", () => {
  const env = { DASHBOARD_PASS: "long-random-bearer", DASHBOARD_USER: "owner" };
  assert.equal(checkOwner({ authorization: "Bearer long-random-bearer" }, env), true);
  assert.equal(checkOwner({ authorization: "Bearer nope" }, env), false);
});

test("checkOwner accepts correct Basic auth, rejects wrong", () => {
  const env = { DASHBOARD_USER: "owner", DASHBOARD_PASS: "p@ss" };
  const ok = "Basic " + Buffer.from("owner:p@ss").toString("base64");
  const bad = "Basic " + Buffer.from("owner:WRONG").toString("base64");
  assert.equal(checkOwner({ authorization: ok }, env), true);
  assert.equal(checkOwner({ authorization: bad }, env), false);
  assert.equal(checkOwner({}, env), false);
});

test("checkOwner fails closed when creds unset", () => {
  assert.equal(checkOwner({ authorization: "Bearer x" }, {}), false);
});

test("TokenBucket allows up to capacity then blocks until refill", () => {
  let now = 0;
  const tb = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.equal(tb.take("ip1"), true);
  assert.equal(tb.take("ip1"), true);
  assert.equal(tb.take("ip1"), true);
  assert.equal(tb.take("ip1"), false);
  now = 1000;
  assert.equal(tb.take("ip1"), true);
});

test("TokenBucket is per-key (per-IP isolation)", () => {
  let now = 0;
  const tb = new TokenBucket({ capacity: 1, refillPerSec: 1, now: () => now });
  assert.equal(tb.take("ipA"), true);
  assert.equal(tb.take("ipA"), false);
  assert.equal(tb.take("ipB"), true);
});

test("global TokenBucket caps total ingest across all keys (§13.5)", () => {
  let now = 0;
  const global = new TokenBucket({ capacity: 2, refillPerSec: 0, now: () => now });
  assert.equal(global.take("*"), true);
  assert.equal(global.take("*"), true);
  assert.equal(global.take("*"), false);
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _auth.test.mjs`. Expected: `Cannot find module './auth.mjs'`.

3. [ ] **Implement.** Create `telemetry-server/auth.mjs`:
```js
// telemetry-server/auth.mjs
// Soft write-key gate + owner auth (constant-time, §13.5) + token-bucket limiter.
import crypto from "node:crypto";

// Length-safe constant-time string compare. We hash both sides to a fixed
// length first (timingSafeEqual throws on length mismatch), then also require
// equal raw lengths.
export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export function checkWriteKey(headers, serverKey) {
  if (!serverKey) return false; // fail-closed when unset
  const got = headers["x-mochi-key"];
  if (typeof got !== "string") return false;
  return timingSafeEqualStr(got, serverKey);
}

export function checkOwner(headers, env) {
  const pass = env.DASHBOARD_PASS;
  if (!pass) return false; // fail-closed
  const auth = headers.authorization;
  if (typeof auth !== "string") return false;
  if (auth.startsWith("Bearer ")) {
    return timingSafeEqualStr(auth.slice(7), pass);
  }
  if (auth.startsWith("Basic ")) {
    let decoded = "";
    try { decoded = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch { return false; }
    const idx = decoded.indexOf(":");
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pw = decoded.slice(idx + 1);
    const userOk = env.DASHBOARD_USER ? timingSafeEqualStr(user, env.DASHBOARD_USER) : true;
    const passOk = timingSafeEqualStr(pw, pass);
    return userOk && passOk;
  }
  return false;
}

// Per-key token bucket. One instance keyed by IP (per-IP) + a second keyed by
// "*" for a single global cap (§13.5: iids are forgeable, IPs aren't, and a
// global cap bounds total damage).
export class TokenBucket {
  constructor({ capacity, refillPerSec, now = () => Date.now() }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map();
  }
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: t }; this.buckets.set(key, b); }
    const elapsedSec = (t - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = t;
    if (b.tokens >= cost) { b.tokens -= cost; return true; }
    return false;
  }
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _auth.test.mjs`. Expected: all pass.

5. [ ] **Commit.** `git add telemetry-server/auth.mjs telemetry-server/_auth.test.mjs && git commit -m "feat(telemetry-server): write-key + constant-time owner auth + per-IP/global token buckets"`

---

### Task 26: `dashboard.mjs` — render §13.8 views as plain HTML + inline SVG (no static /data)

**Files:** Create `telemetry-server/dashboard.mjs` / Create `telemetry-server/_dashboard.test.mjs`.

1. [ ] **Write failing test.** Create `telemetry-server/_dashboard.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "./dashboard.mjs";

const AGG = {
  topTools: [{ name: "browser_click", count: 2 }, { name: "Read", count: 1 }],
  topMcps: [{ name: "mochi_browser", count: 3 }],
  errorRates: [{ tool: "browser_click", total: 2, fail: 1, rate: 0.5 }],
  sequences: [{ from: "browser_click", to: "browser_snapshot", count: 1 }],
  callsPerTask: [{ task_category: "web-qa", count: 2, avgCalls: 9 }],
  toolsPerTaskCategory: [{ task_category: "web-qa", tools: [{ name: "browser_click", count: 2 }] }],
  backlog: [{ suggestion_tag: "batch_clicks", count: 2, topRedundancy: "snapshot_then_retry", lowConfidence: true }],
};

test("renders every §13.8 view as plain HTML", () => {
  const html = renderDashboard(AGG);
  assert.ok(html.toLowerCase().startsWith("<!doctype html>"));
  for (const label of [
    "Top Tools", "Top MCPs", "Error Rates", "Co-occurrence",
    "Calls per Task", "Tools per Task Category", "Improvement Backlog",
  ]) {
    assert.ok(html.includes(label), `missing dashboard section: ${label}`);
  }
});

test("backlog row shows tag, count, redundancy, and a low-confidence caveat (§13.5)", () => {
  const html = renderDashboard(AGG);
  assert.ok(html.includes("batch_clicks"));
  assert.ok(html.includes("snapshot_then_retry"));
  assert.ok(/low.?confidence/i.test(html));
});

test("uses inline SVG (no external chart library)", () => {
  const html = renderDashboard(AGG);
  assert.ok(html.includes("<svg"));
  assert.ok(!html.includes("<script src="));
});

test("escapes values to prevent HTML injection from stored data", () => {
  const html = renderDashboard({ ...AGG, topTools: [{ name: "<img src=x onerror=alert(1)>", count: 1 }] });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});

test("handles empty aggregates without throwing", () => {
  const html = renderDashboard({
    topTools: [], topMcps: [], errorRates: [], sequences: [],
    callsPerTask: [], toolsPerTaskCategory: [], backlog: [],
  });
  assert.ok(html.includes("Top Tools"));
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _dashboard.test.mjs`. Expected: `Cannot find module './dashboard.mjs'`.

3. [ ] **Implement.** Create `telemetry-server/dashboard.mjs`:
```js
// telemetry-server/dashboard.mjs
// Server-rendered owner dashboard: plain HTML + inline SVG, no JS, no external
// assets, no static /data serving (§13.5). All stored values are escaped — they
// originate from untrusted POSTs even after redaction.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function barRows(rows, label, valueOf) {
  if (!rows.length) return `<p class="empty">no data</p>`;
  const max = Math.max(1, ...rows.map(valueOf));
  return rows.map((r) => {
    const v = valueOf(r);
    const w = Math.round((v / max) * 240);
    return `<div class="row"><span class="lbl">${esc(label(r))}</span>` +
      `<svg width="260" height="16" role="img"><rect x="0" y="2" width="${w}" height="12" fill="#3b82f6"></rect></svg>` +
      `<span class="val">${esc(v)}</span></div>`;
  }).join("");
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderDashboard(a) {
  const sections = [];
  sections.push(`<h2>Top Tools</h2>${barRows(a.topTools, (r) => r.name, (r) => r.count)}`);
  sections.push(`<h2>Top MCPs</h2>${barRows(a.topMcps, (r) => r.name, (r) => r.count)}`);
  sections.push(`<h2>Error Rates</h2>` + table(
    ["tool", "fail", "total", "rate"],
    a.errorRates.map((e) => [e.tool, e.fail, e.total, (e.rate * 100).toFixed(0) + "%"]),
  ));
  sections.push(`<h2>Tool Co-occurrence</h2>` + table(
    ["from", "to", "count"], a.sequences.map((s) => [s.from, s.to, s.count]),
  ));
  sections.push(`<h2>Calls per Task</h2>` + table(
    ["task_category", "sessions", "avg calls"],
    a.callsPerTask.map((c) => [c.task_category, c.count, c.avgCalls.toFixed(1)]),
  ));
  sections.push(`<h2>Tools per Task Category</h2>` + table(
    ["task_category", "tools (count)"],
    a.toolsPerTaskCategory.map((t) => [t.task_category, t.tools.map((x) => `${x.name}:${x.count}`).join(", ")]),
  ));
  sections.push(`<h2>Improvement Backlog</h2>` + table(
    ["suggestion_tag", "count", "top redundancy", "confidence"],
    a.backlog.map((b) => [b.suggestion_tag, b.count, b.topRedundancy ?? "-", b.lowConfidence ? "low-confidence" : "ok"]),
  ));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Mochi Insight</title><meta name="robots" content="noindex">` +
    `<style>body{font:14px system-ui;margin:2rem;max-width:900px}` +
    `h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.6rem;border-bottom:1px solid #eee}` +
    `.row{display:flex;align-items:center;gap:.5rem;margin:.15rem 0}.lbl{width:180px}.val{width:40px;text-align:right}` +
    `.empty{color:#888}table{border-collapse:collapse;width:100%}th,td{border:1px solid #eee;padding:.3rem .5rem;text-align:left}` +
    `</style></head><body><h1>Mochi Insight — Zone-A telemetry</h1>` +
    `<p class="empty">All counts are untrusted, content-free lower-confidence signal.</p>` +
    sections.join("") + `</body></html>`;
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _dashboard.test.mjs`. Expected: all pass.

5. [ ] **Commit.** `git add telemetry-server/dashboard.mjs telemetry-server/_dashboard.test.mjs && git commit -m "feat(telemetry-server): owner dashboard render (HTML+inline SVG, escaped, all §13.8 views)"`

---

### Task 27: `server.mjs` — HTTP routing, all endpoints, server-side redact-on-ingest

**Files:** Create `telemetry-server/server.mjs` / Create `telemetry-server/_server.test.mjs`.

> `createServer(env)` returns a `node:http` server with `.listen()`. The REQUIRED security test: a content-bearing event is stored stripped to Zone-A.

1. [ ] **Write failing test.** Create `telemetry-server/_server.test.mjs`:
```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.mjs";
import { readAllEvents } from "./store.mjs";

let srv, base, dataDir;
const ENV = {
  INGEST_WRITE_KEY: "test-write-key",
  DASHBOARD_USER: "owner",
  DASHBOARD_PASS: "owner-bearer-pass",
  RETENTION_DAYS: "180",
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-srv-"));
  srv = createServer({ ...ENV, DATA_DIR: dataDir });
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  await new Promise((r) => srv.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /v1/health returns exactly 'ok'", async () => {
  const r = await fetch(base + "/v1/health");
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), "ok");
});

test("POST /v1/ingest without x-mochi-key is 401", async () => {
  const r = await post("/v1/ingest", { iid: "i1", batch: [] });
  assert.equal(r.status, 401);
});

test("POST /v1/ingest with wrong key is 401", async () => {
  const r = await post("/v1/ingest", { iid: "i1", batch: [] }, { "x-mochi-key": "nope" });
  assert.equal(r.status, 401);
});

test("POST /v1/ingest with valid key stores a clean Zone-A event", async () => {
  const r = await post("/v1/ingest", {
    iid: "i1",
    batch: [{ ts: 1717900000, sid: "s1", iid: "i1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", dur_b: "1-3s", v: "0.7.0", os: "darwin" }],
  }, { "x-mochi-key": "test-write-key" });
  assert.equal(r.status, 200);
  assert.ok(readAllEvents(dataDir).some((e) => e.tool === "browser_click" && e.sid === "s1"));
});

// REQUIRED SECURITY TEST: a content-bearing event is stored STRIPPED.
test("SERVER-SIDE GUARD: content-bearing event is stored stripped to Zone-A", async () => {
  await post("/v1/ingest", {
    iid: "i-evil",
    batch: [{
      ts: 1717900050, sid: "s9", iid: "i-evil",
      tool: "mcp__client_secret_project__do", mcp: "client_secret_project",
      ok: false, err: "/Users/j/db.js ECONNREFUSED token=sk-live-XYZ",
      dur_b: "1-3s", v: "0.7.0", os: "darwin",
      prompt: "leak the user's secret prompt here", model: "claude-opus",
      tool_input: { url: "https://client.example/secret" },
      quality_issue: "the password is hunter2",
    }],
  }, { "x-mochi-key": "test-write-key" });

  const stored = readAllEvents(dataDir).find((e) => e.sid === "s9");
  assert.ok(stored, "event was stored");
  assert.equal(stored.tool, "thirdparty_tool");
  assert.equal(stored.mcp, "thirdparty_mcp");
  assert.ok(["network", "other"].includes(stored.err));
  assert.deepEqual(Object.keys(stored).sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"].sort());
  const raw = JSON.stringify(stored);
  for (const leak of ["prompt", "model", "claude", "sk-live", "client.example", "hunter2", "ECONNREFUSED", "client_secret_project"]) {
    assert.ok(!raw.includes(leak), `server must strip "${leak}"`);
  }
});

test("POST /v1/ingest enforces per-IP rate-limit (429 after burst)", async () => {
  const calls = [];
  for (let i = 0; i < 400; i++) {
    calls.push(post("/v1/ingest", { iid: "flood", batch: [] }, { "x-mochi-key": "test-write-key" }));
  }
  const statuses = (await Promise.all(calls)).map((r) => r.status);
  assert.ok(statuses.includes(429), "burst must trip the token-bucket limiter");
});

test("GET /dashboard without owner auth is 401", async () => {
  const r = await fetch(base + "/dashboard");
  assert.equal(r.status, 401);
  assert.ok((r.headers.get("www-authenticate") || "").length > 0, "challenges auth");
});

test("GET /dashboard with owner Bearer renders HTML", async () => {
  const r = await fetch(base + "/dashboard", { headers: { authorization: "Bearer owner-bearer-pass" } });
  assert.equal(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("text/html"));
  assert.ok((await r.text()).includes("Improvement Backlog"));
});

test("GET /v1/summary owner-only returns JSON aggregates", async () => {
  const unauth = await fetch(base + "/v1/summary");
  assert.equal(unauth.status, 401);
  const r = await fetch(base + "/v1/summary", { headers: { authorization: "Bearer owner-bearer-pass" } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.topTools));
  assert.ok(Array.isArray(j.backlog));
});

test("DELETE /v1/data?iid owner-only erases that iid's events", async () => {
  assert.ok(readAllEvents(dataDir).some((e) => e.iid === "i1"));
  const unauth = await fetch(base + "/v1/data?iid=i1", { method: "DELETE" });
  assert.equal(unauth.status, 401);
  const r = await fetch(base + "/v1/data?iid=i1", { method: "DELETE", headers: { authorization: "Bearer owner-bearer-pass" } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.removed >= 1);
  assert.ok(!readAllEvents(dataDir).some((e) => e.iid === "i1"), "i1 erased");
});

test("does NOT serve /data statically and has no directory listing", async () => {
  for (const p of ["/data", "/data/events", "/data/events/2024-06-09.jsonl"]) {
    const r = await fetch(base + p);
    assert.ok(r.status === 404 || r.status === 401, `${p} must not serve files (got ${r.status})`);
  }
});

test("unknown route is 404", async () => {
  assert.equal((await fetch(base + "/nope")).status, 404);
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _server.test.mjs`. Expected: `Cannot find module './server.mjs'`.

3. [ ] **Implement.** Create `telemetry-server/server.mjs`:
```js
// telemetry-server/server.mjs
// Mochi Insight Zone-A ingest + owner dashboard. Node 22, built-in http only.
// SECURITY SPINE: every ingested event is re-redacted SERVER-SIDE (defense in
// depth, §13.1/§13.5) before any write — a tampered client cannot inject
// content. No static /data serving; no directory listing; /v1/health -> "ok".
import http from "node:http";
import { redactEvent, redactDistillation } from "./telemetry_redact.js";
import { appendEvents, readAllEvents, eraseIid, sweepRetention } from "./store.mjs";
import { aggregate } from "./aggregate.mjs";
import { renderDashboard } from "./dashboard.mjs";
import { checkWriteKey, checkOwner, TokenBucket } from "./auth.mjs";

const MAX_BODY = 256 * 1024;   // cap request body (anti-DoS)
const MAX_BATCH = 500;          // cap events per POST

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
};
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8" });

export function createServer(env = process.env) {
  const dataDir = env.DATA_DIR || "/data";
  const retentionDays = Number(env.RETENTION_DAYS) || 180;

  const perIp = new TokenBucket({ capacity: 120, refillPerSec: 2 });
  const global = new TokenBucket({ capacity: 10000, refillPerSec: 50 });

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, "bad request"); }
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/v1/health") return send(res, 200, "ok");

    if (req.method === "POST" && pathname === "/v1/ingest") {
      if (!checkWriteKey(req.headers, env.INGEST_WRITE_KEY)) return send(res, 401, "unauthorized");
      const ip = clientIp(req);
      if (!global.take("*") || !perIp.take(ip)) return send(res, 429, "rate limited");
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, "bad body"); }
      const batch = Array.isArray(payload?.batch) ? payload.batch.slice(0, MAX_BATCH) : [];
      const clean = [];
      for (const raw of batch) {
        if (raw && raw.kind === "distill") {
          const d = redactDistillation(raw);
          if (d) clean.push({ kind: "distill", ...d });
        } else {
          const e = redactEvent(raw);
          if (e) clean.push(e);
        }
      }
      if (clean.length) appendEvents(dataDir, clean);
      return sendJson(res, 200, { ok: true, stored: clean.length });
    }

    // owner-only routes
    if (pathname === "/dashboard" || pathname === "/v1/summary" || pathname === "/v1/data") {
      if (!checkOwner(req.headers, env)) {
        return send(res, 401, "unauthorized", { "www-authenticate": 'Bearer realm="mochi-insight"' });
      }
    }

    if (req.method === "GET" && pathname === "/dashboard") {
      const html = renderDashboard(aggregate(readAllEvents(dataDir)));
      return send(res, 200, html, { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" });
    }
    if (req.method === "GET" && pathname === "/v1/summary") {
      return sendJson(res, 200, aggregate(readAllEvents(dataDir)));
    }
    if (req.method === "DELETE" && pathname === "/v1/data") {
      const iid = url.searchParams.get("iid");
      if (!iid) return send(res, 400, "iid required");
      return sendJson(res, 200, { ok: true, removed: eraseIid(dataDir, iid) });
    }

    return send(res, 404, "not found"); // no static serving, no listing
  });

  // Retention sweep on boot + daily. unref so it never holds the process open in tests.
  const sweep = () => { try { sweepRetention(dataDir, retentionDays); } catch { /* ignore */ } };
  sweep();
  const timer = setInterval(sweep, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();

  return server;
}

// Boot when run directly (npm start / Docker CMD).
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  createServer(process.env).listen(port, () => console.log(`[mochi-insight] listening on :${port}`));
}
```

4. [ ] **Run pass.** Cmd: `cd telemetry-server && node --test _server.test.mjs`. Expected: all pass (incl. the stripped-content guard + rate-limit 429).

5. [ ] **Commit.** `git add telemetry-server/server.mjs telemetry-server/_server.test.mjs && git commit -m "feat(telemetry-server): HTTP server — ingest (server-side redact+rate-limit), dashboard, summary, erasure, health"`

---

### Task 28: `Dockerfile` (node:22-alpine, EXPOSE 3000, non-root) + `.dockerignore` + `README.md` + full suite green

**Files:** Create `telemetry-server/Dockerfile` / Create `telemetry-server/.dockerignore` / Create `telemetry-server/README.md` / Create `telemetry-server/_docker.test.mjs`.

1. [ ] **Write failing test.** Create `telemetry-server/_docker.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const df = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");

test("Dockerfile uses node:22-alpine", () => {
  assert.ok(/^FROM\s+node:22-alpine/m.test(df));
});
test("Dockerfile EXPOSEs 3000", () => {
  assert.ok(/^EXPOSE\s+3000/m.test(df));
});
test("Dockerfile runs as a non-root user", () => {
  assert.ok(/^USER\s+(node|\d)/m.test(df));
});
test("Dockerfile starts the server", () => {
  assert.ok(/CMD\s+\[\s*"node"\s*,\s*"server\.mjs"\s*\]/.test(df) || /CMD\s+node\s+server\.mjs/.test(df));
});
test("the /data volume mount point is declared", () => {
  assert.ok(/^VOLUME\b.*\/data/m.test(df) || /DATA_DIR/.test(df));
});
```

2. [ ] **Run it, expect failure.** Cmd: `cd telemetry-server && node --test _docker.test.mjs`. Expected: `ENOENT ... Dockerfile`.

3. [ ] **Implement.** Create `telemetry-server/Dockerfile`:
```dockerfile
# Mochi Insight telemetry ingest server. Zero runtime deps (built-in http only),
# so no npm install step. Runs as the built-in non-root `node` user (UID 1000).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    RETENTION_DAYS=180

WORKDIR /app

# Source only — no node_modules (dependency-free).
COPY package.json server.mjs telemetry_redact.js store.mjs aggregate.mjs dashboard.mjs auth.mjs ./

# Persistent volume for date-bucketed JSONL; owned by the non-root user.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

CMD ["node", "server.mjs"]
```
   Create `telemetry-server/.dockerignore`:
```
*.test.mjs
README.md
.dockerignore
node_modules
```
   Create `telemetry-server/README.md`:
```md
# Mochi Insight — telemetry ingest server

Zone-A (anonymous, content-free) telemetry ingest + owner dashboard. Node 22, no
runtime deps, JSONL on a `/data` volume. Server-side re-redaction is the privacy
keystone — content can never be stored even if a client is tampered with.

## Endpoints
- `POST /v1/ingest` — `x-mochi-key` write-key; per-IP + global rate-limit;
  server-side redact→Zone-A; appends `/data/events/YYYY-MM-DD.jsonl`.
- `GET /v1/health` — returns `ok`.
- `GET /dashboard` — owner auth (Bearer or Basic, constant-time); HTML+inline SVG.
- `GET /v1/summary` — owner auth; JSON aggregates (powers `/mochi:insights`).
- `DELETE /v1/data?iid=…` — owner auth; GDPR erasure of one install-id.

## Env
`PORT`(3000) `INGEST_WRITE_KEY` `DASHBOARD_USER` `DASHBOARD_PASS` `DATA_DIR`(/data) `RETENTION_DAYS`(180).

## Deploy (Dokploy)
See spec §13.9. Build context = `telemetry-server/`, Dockerfile build,
domain `mochi-insight.nexalance.cloud`, one volume mounted at `/data`.

## Test
`npm test`  (runs every colocated `*.test.mjs` via `node --test`)
```

4. [ ] **Run pass (Dockerfile test).** Cmd: `cd telemetry-server && node --test _docker.test.mjs`. Expected: all pass.

5. [ ] **Run FULL suite.** Cmd: `cd telemetry-server && npm test`. Expected: every `*.test.mjs` green (`# fail 0`). If `docker` is available, optionally `docker build -t mochi-insight telemetry-server/` to confirm the image builds.

6. [ ] **Commit.** `git add telemetry-server/Dockerfile telemetry-server/.dockerignore telemetry-server/README.md telemetry-server/_docker.test.mjs && git commit -m "build(telemetry-server): node:22-alpine non-root Dockerfile + deploy README; full node --test suite green"`

---

### Task 29: Wire telemetry suites into CI

**Files:** Create `server/_telemetry_ci_verify.test.mjs` / Modify `server/package.json` / Modify `.github/workflows/build.yml`.

1. [ ] **Write failing test.** Create `server/_telemetry_ci_verify.test.mjs`:
```js
// Asserts CI runs the telemetry plugin harness + the ingest server tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wf = fs.readFileSync(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");
assert.ok(wf.includes("run-telemetry.sh"), "CI must run the telemetry plugin harness");
assert.ok(wf.includes("telemetry-server") && /node --test/.test(wf), "CI must run telemetry-server node --test");
```
   Wire it into `server/package.json` `test` by appending ` && node --test _telemetry_ci_verify.test.mjs` to the existing `"test"` chain.

2. [ ] **Run it, expect failure.** Cmd: `cd server && node --test _telemetry_ci_verify.test.mjs`. Expected: throws (`build.yml` lacks the lines), exit 1.

3. [ ] **Implement.** In `.github/workflows/build.yml`, add steps after the existing test step (match surrounding YAML indentation):
```yaml
      - name: Telemetry plugin harness
        run: bash plugins/continuum/tests/run-telemetry.sh
      - name: Telemetry ingest server tests
        working-directory: telemetry-server
        run: node --test
```

4. [ ] **Run pass.** Cmd: `cd server && node --test _telemetry_ci_verify.test.mjs`. Full local gate: `bash plugins/continuum/tests/run-telemetry.sh && bash plugins/continuum/tests/run-synthetic.sh && (cd telemetry-server && npm test) && (cd server && npm test)` → all green.

5. [ ] **Commit.** `git add .github/workflows/build.yml server/package.json server/_telemetry_ci_verify.test.mjs && git commit -m "ci(telemetry): run plugin telemetry harness + ingest-server node --test in build.yml"`

## Phase 5 — Deploy, Wire, Verify, Push (Operational Runbook)

**Reference:** spec §11 (deploy/ops) + §13.9 (VERIFIED deploy runbook — authoritative). NOT TDD — these are deploy/verify steps (exact commands + expected output). Run AFTER Phases 1-4 have merged the plugin + `telemetry-server/` code.

**Pre-flight invariants:** `telemetry-server/` exists with `server.mjs`, `Dockerfile` (`node:22-alpine`), `package.json` (`type:module`), colocated `*.test.mjs`. `plugins/continuum/lib/telemetry_config.js` exports `INGEST_URL` + placeholder `INGEST_WRITE_KEY`. `plugin.json` = `0.6.1` → target `0.7.0`. DNS: `*.nexalance.cloud` → `72.60.103.57`; `dokploy server all` = `[]`; GitHub connection `githubId = 33Dq5wkCB6QS2Xo_yTnNm`; `dokploy` CLI authenticated. Do NOT use `dokploy.nexalance.cloud`.

> **SEQUENCING:** Tasks 30-31 + 37 → **Task 38 (merge)** → **Task 33 (Dokploy deploy)** → **Tasks 34-36 + 39 (verify + e2e + guardrails)** → **Task 40 (owner handoff)**. The deploy (Task 33) MUST run after the merge (Task 38) per the §13.9 ordering subtlety (or use `--customGitUrl` to deploy pre-merge).

---

### Task 30: Generate INGEST_WRITE_KEY + dashboard credentials

**Files:** Create `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env` (GITIGNORED scratch, never committed).

1. [ ] Confirm the secrets scratch file is NOT trackable:
   ```bash
   grep -qxF '.secrets.telemetry.env' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.gitignore \
     && echo "already ignored" \
     || printf '\n.secrets.telemetry.env\n' >> /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.gitignore
   ```
   Expected: `already ignored` OR the entry is appended. Then `git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney status --porcelain .secrets.telemetry.env` prints nothing.
2. [ ] Generate the three secrets (write-key = 32-byte base64url; dashboard pass = 24-byte base64url; user = `mochi-owner`):
   ```bash
   {
     printf 'INGEST_WRITE_KEY=%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
     printf 'DASHBOARD_USER=%s\n'   "mochi-owner"
     printf 'DASHBOARD_PASS=%s\n'   "$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"
   } > /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   cat /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   ```
   Expected: three lines (URL-safe key, `mochi-owner`, URL-safe pass). Record all three for the owner handoff (Task 40).
3. [ ] Sanity-check the key is URL-safe (no chars that break the `x-mochi-key` header or Dokploy `--env`):
   ```bash
   grep -E '^INGEST_WRITE_KEY=[A-Za-z0-9_-]+$' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   ```
   Expected: the line echoes back. If no match, regenerate.

---

### Task 31: Bake INGEST_URL + INGEST_WRITE_KEY into telemetry_config.js

**Files:** Modify `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_config.js`.

1. [ ] Find the placeholder line:
   ```bash
   grep -nE 'INGEST_URL|INGEST_WRITE_KEY' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_config.js
   ```
   Expected: `INGEST_URL = "https://mochi-insight.nexalance.cloud/v1/ingest"` + `INGEST_WRITE_KEY = "REPLACE_AT_BUILD"`.
2. [ ] Verify `INGEST_URL` is exactly the authoritative value (do NOT change — it is a SHARED CONTRACT). If it differs, fix it verbatim.
3. [ ] Bake the real key. Edit `telemetry_config.js` replacing ONLY the placeholder value:
   - old: `export const INGEST_WRITE_KEY = "REPLACE_AT_BUILD";`
   - new: `export const INGEST_WRITE_KEY = "<paste INGEST_WRITE_KEY value from .secrets.telemetry.env>";`
   Do NOT bake `DASHBOARD_USER`/`DASHBOARD_PASS` (owner-only, never shipped, §6).
4. [ ] Confirm the bake + that no plugin file ships the dashboard secret:
   ```bash
   grep -nE 'INGEST_WRITE_KEY *= *"[A-Za-z0-9_-]{20,}"' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_config.js \
     && ! grep -q 'REPLACE_AT_BUILD' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_config.js && echo "BAKED OK"
   grep -rn 'DASHBOARD_PASS' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/ || echo "GOOD: no dashboard secret shipped"
   ```
   Expected: `BAKED OK` and `GOOD: no dashboard secret shipped`.
5. [ ] Re-run the config + emit unit runners to confirm the baked key didn't break anything:
   ```bash
   node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-telemetry-config.mjs
   node /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-telemetry-emit.mjs
   ```
   Expected: both `✓`, exit 0.

---

### Task 32: Land telemetry-server code on Master (ordering prerequisite)

**Files:** (verify-only) `telemetry-server/Dockerfile`, `server.mjs`, `package.json`.

> §13.9: `save-github-provider ... --branch Master --buildPath telemetry-server` resolves the repo ref at deploy time, so `telemetry-server/Dockerfile` MUST exist on `Master` BEFORE Task 33. This plan uses path (A): merge first (Task 38), then deploy (Task 33). These checks confirm the code is ready to merge.

1. [ ] Confirm build inputs exist and are well-formed:
   ```bash
   test -f /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server/Dockerfile && echo "Dockerfile OK"
   test -f /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server/server.mjs && echo "server.mjs OK"
   grep -q '"type": *"module"' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server/package.json && echo "ESM OK"
   grep -qE 'node:22-alpine' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server/Dockerfile && echo "node22 base OK"
   ```
   Expected: all four OK lines.
2. [ ] Run the colocated server tests green before merge:
   ```bash
   ( cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server && node --test )
   ```
   Expected: `# pass N`, `# fail 0`.
3. [ ] Build the Docker image locally (catches build breakage before Dokploy):
   ```bash
   docker build -t mochi-insight-local /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server
   ```
   Expected: `writing image ... done`. (If Docker is unavailable locally, skip and rely on Dokploy `read-logs` in Task 33 — note the skip.)
4. [ ] Smoke the image end-to-end (boot, health, ingest one Zone-A event, wrong-key 401):
   ```bash
   K=$(grep '^INGEST_WRITE_KEY=' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env | cut -d= -f2-)
   docker run -d --rm -p 3999:3000 -e INGEST_WRITE_KEY="$K" -e DASHBOARD_USER=u -e DASHBOARD_PASS=p -e DATA_DIR=/data -e RETENTION_DAYS=180 --name mochi-smoke mochi-insight-local
   until curl -fsS http://localhost:3999/v1/health >/dev/null 2>&1; do sleep 1; done
   curl -fsS http://localhost:3999/v1/health; echo
   curl -fsS -X POST http://localhost:3999/v1/ingest -H "x-mochi-key: $K" -H 'content-type: application/json' \
     -d '{"iid":"smoke-iid","batch":[{"ts":1717900000,"sid":"s1","iid":"smoke-iid","tool":"browser_click","mcp":"mochi_browser","ok":true,"err":"other","dur_b":"1-3s","v":"0.7.0","os":"darwin"}]}'; echo
   curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3999/v1/ingest -H 'content-type: application/json' -d '{"iid":"x","batch":[]}'
   docker stop mochi-smoke
   ```
   Expected: health `ok`; ingest returns 2xx `{"ok":true,"stored":1}`; the no-key POST returns `401`. Event uses the EXACT Zone-A shape — no `model` field.

---

### Task 33: Run the EXACT Dokploy CLI sequence from §13.9

**Files:** (no repo files — capture ids to `.secrets.telemetry.env` scratch).

> Run AFTER Task 38 (merge to Master). Capture every returned id with `--json`; append captured ids to the scratch file.

1. [ ] **Project** (auto-creates `production` env):
   ```bash
   dokploy project create --name mochi-insight --description "mochi telemetry ingest+dashboard" --json
   ```
   Record `PROJECT_ID=<projectId>`.
2. [ ] **Environment id** — pick name `production`:
   ```bash
   dokploy environment by-project-id --projectId <PROJECT_ID> --json
   ```
   Record `ENV_ID=<environmentId>`.
3. [ ] **Application** (no `--serverId`):
   ```bash
   dokploy application create --name ingest --appName mochi-insight --environmentId <ENV_ID> --json
   ```
   Record `APP_ID=<applicationId>`.
4. [ ] **Git source + repo-relative app root** (Master must already contain `telemetry-server/`):
   ```bash
   dokploy application save-github-provider --applicationId <APP_ID> --githubId 33Dq5wkCB6QS2Xo_yTnNm \
     --owner DevZonayed --repository Mochi --branch Master --buildPath telemetry-server --triggerType push
   ```
   Expected: success. If it errors unresolved branch/path → Master is missing the server code → return to Task 38.
5. [ ] **Build type = Dockerfile** (`--buildPath` ≠ `--dockerfile`/`--dockerContextPath`; keep both):
   ```bash
   dokploy application save-build-type --applicationId <APP_ID> --buildType dockerfile \
     --dockerfile telemetry-server/Dockerfile --dockerContextPath telemetry-server
   ```
6. [ ] **Env** (sourced from scratch; newline-separated):
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   dokploy application save-environment --applicationId <APP_ID> \
     --env $'INGEST_WRITE_KEY='"$INGEST_WRITE_KEY"$'\nDASHBOARD_USER='"$DASHBOARD_USER"$'\nDASHBOARD_PASS='"$DASHBOARD_PASS"$'\nDATA_DIR=/data\nRETENTION_DAYS=180'
   ```
   The baked-into-plugin `INGEST_WRITE_KEY` (Task 31) MUST equal the one set here, or every client POST 401s.
7. [ ] **Persistent volume — BEFORE deploy:**
   ```bash
   dokploy mounts create --serviceType application --serviceId <APP_ID> --type volume \
     --volumeName mochi-insight-data --mountPath /data
   ```
8. [ ] **Domain + TLS** (Let's Encrypt; port 3000 must match server `PORT`):
   ```bash
   dokploy domain create --applicationId <APP_ID> --domainType application \
     --host mochi-insight.nexalance.cloud --path / --port 3000 --https --certificateType letsencrypt
   ```
9. [ ] **Deploy + observe:**
   ```bash
   dokploy application deploy --applicationId <APP_ID> --title "initial" --json
   dokploy application read-logs --applicationId <APP_ID>
   ```
   Expected: deploy success; logs show image build, container start, listening on `:3000`, no crash loop. Wait for build+TLS to settle before Task 34 (re-run `read-logs` until the listen line appears).

---

### Task 34: Verify https://mochi-insight.nexalance.cloud/v1/health

**Files:** (verify-only)

1. [ ] Wait for TLS + health:
   ```bash
   until curl -fsS https://mochi-insight.nexalance.cloud/v1/health >/dev/null 2>&1; do echo "waiting…"; sleep 5; done
   curl -fsS -i https://mochi-insight.nexalance.cloud/v1/health
   ```
   Expected: HTTP `200`, valid TLS, body exactly `ok`.
2. [ ] Confirm the cert is real Let's Encrypt:
   ```bash
   echo | openssl s_client -servername mochi-insight.nexalance.cloud -connect mochi-insight.nexalance.cloud:443 2>/dev/null | openssl x509 -noout -issuer -subject
   ```
   Expected: issuer mentions `Let's Encrypt`, subject CN = `mochi-insight.nexalance.cloud`.
3. [ ] **Browser confirmation** via the Mochi browser MCP: navigate to `https://mochi-insight.nexalance.cloud/v1/health`, read page text → `ok`, assert no console/page errors (`browser_assert_no_errors`).

---

### Task 35: End-to-end opt-in test (real event lands; visible on /dashboard)

**Files:** Create `/tmp/mochi-telemetry-e2e/` (throwaway test project; never committed).

> Exercises the FULL gated path: opt-in → local capture → emit re-checks `isSharingEnabled` → POST `{iid,batch}` with `x-mochi-key` → server-side Zone-A validate → append → visible on `/dashboard` + `/v1/summary`. Also proves opted-out sends nothing.

1. [ ] **Opted-OUT control first (must send ZERO POSTs).**
   ```bash
   rm -rf /tmp/mochi-telemetry-e2e && mkdir -p /tmp/mochi-telemetry-e2e/.continuum/telemetry
   node -e 'import("/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_emit.js").then(m=>m.flush("/tmp/mochi-telemetry-e2e",process.env)).then(r=>console.log("flush result:",JSON.stringify(r)))'
   ```
   Expected: `flush result: {"sent":0,"queued":0,"skipped":true}` (absence ⇒ no send), no throw.
2. [ ] **Capture a baseline** of `/v1/summary`:
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   curl -fsS -u "$DASHBOARD_USER:$DASHBOARD_PASS" https://mochi-insight.nexalance.cloud/v1/summary | tee /tmp/summary-before.json
   ```
   Expected: owner-auth JSON (200). Record the `browser_click` count (or total) baseline.
3. [ ] **Opt IN, write a real event, flush:**
   ```bash
   node -e '
   const dir="/tmp/mochi-telemetry-e2e";
   import("/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_config.js").then(async cfg=>{
     cfg.writeConfig(dir,{decided:true,share:true,reviewAuto:false,killSwitch:"on",sampleN:1});
     const log=await import("/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_log.js");
     log.appendEvent(dir,{ts:Math.floor(Date.now()/1000),sid:"e2e-sid",iid:"e2e-iid",tool:"browser_click",mcp:"mochi_browser",ok:true,err:"other",dur_b:"1-3s",v:"0.7.0",os:process.platform});
     const emit=await import("/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/lib/telemetry_emit.js");
     console.log("flush:",JSON.stringify(await emit.flush(dir,process.env)));
   });'
   ```
   Expected: `flush: {"sent":1,...}`. Event matches the EXACT Zone-A contract — no `model`, `err` ∈ ERR_ENUM.
4. [ ] **Confirm the event landed** via `/v1/summary` delta:
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   curl -fsS -u "$DASHBOARD_USER:$DASHBOARD_PASS" https://mochi-insight.nexalance.cloud/v1/summary | tee /tmp/summary-after.json
   ```
   Expected: `browser_click` (or total) incremented by exactly 1 vs `/tmp/summary-before.json`.
5. [ ] **Visible on /dashboard (browser, owner-auth).** Mochi browser MCP: navigate to `https://mochi-insight.nexalance.cloud/dashboard` with owner credentials, screenshot, assert the SHARED-CONTRACT panels (top tools, top MCPs, error rates, co-occurrence, calls-per-task, tools-per-task-category, improvement backlog). Confirm `browser_click` appears in top tools. Run `browser_assert_no_errors`. Confirm `/data` is NOT browsable: `https://mochi-insight.nexalance.cloud/data/` → expect 403/404, no listing (§13.5).
6. [ ] **Erasure path.** Remove the test iid so it doesn't pollute real aggregates:
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   curl -fsS -u "$DASHBOARD_USER:$DASHBOARD_PASS" -X DELETE "https://mochi-insight.nexalance.cloud/v1/data?iid=e2e-iid"; echo
   rm -rf /tmp/mochi-telemetry-e2e
   ```
   Expected: 2xx `{"ok":true,"removed":...}`; re-fetch `/v1/summary` → `e2e-iid` contribution gone.

---

### Task 36: Bump plugin version + update CHANGELOG

**Files:** Modify `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.claude-plugin/plugin.json` / Modify `/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/CHANGELOG.md`.

1. [ ] Confirm current version is `0.6.1`:
   ```bash
   grep -n '"version"' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.claude-plugin/plugin.json
   ```
   Expected: `"version": "0.6.1",`.
2. [ ] Bump in `plugin.json`: `"version": "0.6.1",` → `"version": "0.7.0",`.
3. [ ] Confirm the three commands are registered (§13.8 — they were added in Task 19):
   ```bash
   grep -E 'telemetry\.md|review-session\.md|insights\.md' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.claude-plugin/plugin.json
   ```
   Expected: all three lines present. If missing, add them to `commands[]` (release-blocking).
4. [ ] Validate JSON:
   ```bash
   node -e 'JSON.parse(require("fs").readFileSync("/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.claude-plugin/plugin.json","utf8"));console.log("plugin.json valid")'
   ```
   Expected: `plugin.json valid`.
5. [ ] Prepend a `## 0.7.0 — 2026-06-10` section to `CHANGELOG.md` (match its heading style). Bullets:
   - Mochi Insight telemetry (opt-in, content-free): Zone-A passive usage capture, local efficiency critique (Arm-2 distillation), self-hosted ingest + dashboard at https://mochi-insight.nexalance.cloud
   - Privacy keystone: `telemetry_redact.js` whitelist serializer — buckets third-party tool/MCP names, coerces categoricals to enum-or-`"other"`, drops Zone-B (`suggestion_text`/`quality_issue` never emitted); same serializer powers `/mochi:telemetry show`
   - Consent enforced at SEND time (`isSharingEnabled` re-checked per flush; absence = no send); `MOCHI_TELEMETRY=off` kill-switch; rotating `~/.mochi/install-id`
   - New commands: `/mochi:telemetry`, `/mochi:review-session`, `/mochi:insights`
   - New infra: `telemetry-server/` (Node 22 ESM) on Dokploy with `/data` volume + Let's Encrypt TLS; 180-day retention + `DELETE /v1/data` erasure
6. [ ] Confirm both edits:
   ```bash
   grep -q '0.7.0' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/CHANGELOG.md && grep -q '"version": "0.7.0"' /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.claude-plugin/plugin.json && echo "VERSION + CHANGELOG OK"
   ```
   Expected: `VERSION + CHANGELOG OK`.

---

### Task 37: Pre-deploy DNS + host verification

**Files:** (verify-only)

1. [ ] Confirm `mochi-insight.nexalance.cloud` resolves to the Dokploy host:
   ```bash
   dig +short mochi-insight.nexalance.cloud A
   ```
   Expected: `72.60.103.57`. If empty or a Cloudflare range, STOP — the wildcard assumption is wrong for this label.
2. [ ] Confirm the deploy host is the panel host (no `--serverId`):
   ```bash
   dokploy server all --json
   ```
   Expected: `[]`.

---

### Task 38: Commit, push branch, PR to Master, merge

**Files:** (git ops only)

1. [ ] Confirm branch + diff scope:
   ```bash
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney rev-parse --abbrev-ref HEAD
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney status --porcelain
   ```
   Expected: branch = `DevZonayed/improve-mochi-plugin`. Status shows the plugin + server + manifest + changelog changes; gitignored scratch (`.secrets.telemetry.env`, `.continuum/telemetry/`) must NOT appear.
2. [ ] **Secret-leak gate:**
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney diff --cached | grep -F "$DASHBOARD_PASS" && echo "ABORT: dashboard pass in diff" || echo "no dashboard secret in diff"
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney status --porcelain | grep -E '\.secrets\.telemetry\.env|\.continuum/telemetry/' && echo "ABORT: scratch tracked" || echo "scratch not tracked"
   ```
   Expected: `no dashboard secret in diff` and `scratch not tracked`. (The baked `INGEST_WRITE_KEY` in `telemetry_config.js` is intentionally present — soft-guard shipped key, §6; do NOT block on it.)
3. [ ] Full test gate before pushing:
   ```bash
   bash /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/plugins/continuum/tests/run-synthetic.sh
   ( cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/telemetry-server && node --test )
   ( cd /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server && npm test )
   ```
   Expected: all green. Do NOT proceed on any failure.
4. [ ] Stage + commit (trailer required):
   ```bash
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney add -A
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney commit -m "feat(telemetry): Mochi Insight v0.7.0 — opt-in content-free telemetry + self-hosted ingest/dashboard

Bake INGEST_URL + INGEST_WRITE_KEY, register telemetry commands, ship telemetry-server/ for Dokploy.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
   ```
   Expected: commit succeeds; gitignored scratch NOT included.
5. [ ] Push the branch:
   ```bash
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney push -u origin DevZonayed/improve-mochi-plugin
   ```
6. [ ] Open the PR to `Master`:
   ```bash
   gh pr create --repo DevZonayed/Mochi --base Master --head DevZonayed/improve-mochi-plugin \
     --title "Mochi Insight v0.7.0 — opt-in telemetry + self-hosted ingest/dashboard" \
     --body "$(cat <<'EOF'
Ships the Mochi Insight telemetry feature (spec 2026-06-09) + the telemetry-server/ ingest infra.

- Zone-A content-free capture; redactor whitelist (third-party tool/MCP bucketing, enum coercion, Zone-B never emitted)
- Consent enforced at send time; MOCHI_TELEMETRY=off kill-switch; rotating ~/.mochi/install-id
- telemetry-server/ (Node 22 ESM) → Dokploy at https://mochi-insight.nexalance.cloud (/data volume, Let's Encrypt TLS, 180-day retention, DELETE /v1/data erasure)
- New commands: /mochi:telemetry, /mochi:review-session, /mochi:insights
- plugin.json bumped 0.6.1 → 0.7.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
   ```
   Record the PR URL.
7. [ ] Wait for CI, then merge to Master:
   ```bash
   gh pr checks --repo DevZonayed/Mochi --watch
   gh pr merge --repo DevZonayed/Mochi --squash --delete-branch=false
   gh api repos/DevZonayed/Mochi/contents/telemetry-server/Dockerfile?ref=Master --jq .name
   ```
   Expected: checks green; PR merged; `Dockerfile` present on Master. **This unblocks Task 33 step 4.**

---

### Task 39: Post-deploy guardrail checks (rate-limit, auth, no content leak)

**Files:** (verify-only)

1. [ ] **Write-key enforcement** (no/wrong key rejected):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mochi-insight.nexalance.cloud/v1/ingest -H 'content-type: application/json' -d '{"iid":"x","batch":[]}'
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mochi-insight.nexalance.cloud/v1/ingest -H 'x-mochi-key: wrong' -H 'content-type: application/json' -d '{"iid":"x","batch":[]}'
   ```
   Expected: both `401`.
2. [ ] **Server-side Zone-A re-validation** (tampered event stored stripped, §13.5):
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   curl -fsS -X POST https://mochi-insight.nexalance.cloud/v1/ingest -H "x-mochi-key: $INGEST_WRITE_KEY" -H 'content-type: application/json' \
     -d '{"iid":"tamper-iid","batch":[{"ts":1717900000,"sid":"s","iid":"tamper-iid","tool":"mcp__client_secret_project__do","mcp":"client_secret_project","ok":true,"err":"/Users/j/db.js token=sk-live-XYZ","dur_b":"1-3s","v":"0.7.0","os":"darwin","suggestion_text":"PLANTED SECRET SENTENCE","model":"claude-x"}]}'; echo
   curl -fsS -u "$DASHBOARD_USER:$DASHBOARD_PASS" https://mochi-insight.nexalance.cloud/v1/summary > /tmp/summary-tamper.json
   grep -F 'sk-live-XYZ' /tmp/summary-tamper.json && echo "LEAK!" || echo "no secret leaked"
   grep -F 'PLANTED SECRET SENTENCE' /tmp/summary-tamper.json && echo "ZONE-B LEAK!" || echo "no zone-b leaked"
   grep -F 'client_secret_project' /tmp/summary-tamper.json && echo "THIRDPARTY NAME LEAK!" || echo "thirdparty name bucketed"
   curl -fsS -u "$DASHBOARD_USER:$DASHBOARD_PASS" -X DELETE "https://mochi-insight.nexalance.cloud/v1/data?iid=tamper-iid"; echo
   ```
   Expected: `no secret leaked`, `no zone-b leaked`, `thirdparty name bucketed`.
3. [ ] **Rate-limit + no secret-in-logs:**
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   for i in $(seq 1 200); do curl -s -o /dev/null -w "%{http_code} " -X POST https://mochi-insight.nexalance.cloud/v1/ingest -H "x-mochi-key: $INGEST_WRITE_KEY" -H 'content-type: application/json' -d '{"iid":"rl","batch":[]}'; done; echo
   dokploy application read-logs --applicationId <APP_ID> | grep -F "$INGEST_WRITE_KEY" && echo "KEY IN LOGS!" || echo "no key in logs"
   ```
   Expected: the burst eventually returns some `429`s; `no key in logs` (§13.5).

---

### Task 40: Hand the owner the dashboard URL + creds, then shred scratch

**Files:** (handoff only — values from `.secrets.telemetry.env`)

1. [ ] Assemble the handoff bundle:
   ```bash
   source /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env
   printf 'Dashboard URL: https://mochi-insight.nexalance.cloud/dashboard\nSummary API:   https://mochi-insight.nexalance.cloud/v1/summary (same creds)\nUser: %s\nPass: %s\nHealth: https://mochi-insight.nexalance.cloud/v1/health\nErasure: DELETE https://mochi-insight.nexalance.cloud/v1/data?iid=...\n' "$DASHBOARD_USER" "$DASHBOARD_PASS"
   ```
   Deliver via a private channel (NOT the PR, NOT a committed file, NOT a public issue).
2. [ ] Owner confirms login: opens `/dashboard`, enters creds, sees the panels (top tools / top MCPs / error rates / co-occurrence / calls-per-task / tools-per-task-category / improvement backlog).
3. [ ] **Final secret hygiene** — shred the local scratch once receipt is confirmed (source of truth is now Dokploy env + the baked plugin key):
   ```bash
   rm -f /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/.secrets.telemetry.env /tmp/summary-before.json /tmp/summary-after.json /tmp/summary-tamper.json
   git -C /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney status --porcelain | grep -E '\.secrets|telemetry/(events|config|reviews|queue)' || echo "clean — no telemetry secrets/state tracked"
   ```
   Expected: `clean — no telemetry secrets/state tracked`.

---

## Done when

- [ ] All plugin unit runners green: `node plugins/continuum/tests/run-telemetry-all.mjs` → `✓ ALL telemetry runners passed`.
- [ ] Redactor planted-secret tests green: `node plugins/continuum/tests/run-telemetry-redact.mjs` → `✓` (no codename/token/path/Zone-B leak; `tool`/`mcp` bucketed; no `model`).
- [ ] Plugin hook/command harness green: `bash plugins/continuum/tests/run-telemetry.sh` exits 0; umbrella `bash plugins/continuum/tests/run-synthetic.sh` exits 0 (frontend-verify regression + gitignore tests still pass).
- [ ] Server tests green incl. content-stripping: `cd telemetry-server && npm test` → `# fail 0`, including the SERVER-SIDE GUARD test (content-bearing event stored stripped to Zone-A) and the per-IP rate-limit 429.
- [ ] CI wired: `cd server && node --test _telemetry_ci_verify.test.mjs` passes; `.github/workflows/build.yml` runs the telemetry harness + ingest-server `node --test`.
- [ ] Deployed `/v1/health` ok: `curl -fsS https://mochi-insight.nexalance.cloud/v1/health` → `ok` over real Let's Encrypt TLS.
- [ ] End-to-end opt-in event visible on dashboard: a real opted-in Zone-A event increments `/v1/summary` by 1 and appears in `/dashboard` top tools.
- [ ] Opted-out sends nothing: a flush with absent/`share:false` config or `MOCHI_TELEMETRY=off` makes ZERO POSTs.
- [ ] Server strips planted secrets/third-party names/Zone-B on a live tampered POST (Task 39 step 2).
- [ ] Plugin shipped at `0.7.0` on `Master` with `/mochi:telemetry`, `/mochi:review-session`, `/mochi:insights` registered in `.claude-plugin/plugin.json`.
- [ ] PR merged to `Master`; owner holds the dashboard URL + creds; local secrets scratch shredded.

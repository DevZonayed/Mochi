# Mochi Insight — Usage Telemetry, Efficiency Critique & Feedback

**Status:** Design (awaiting hardening + user review)
**Date:** 2026-06-09
**Plugin:** `mochi` v0.6.x → target v0.7.0
**Companion infra:** self-hosted ingest service on Dokploy at a `nexalance.cloud` subdomain

---

## 1. Goal

Learn how the `mochi` plugin is *actually* used so it can be improved: **which tools/MCPs are
used most, where the model struggles or wastes calls, what breaks, and concrete "this took 10
calls — here's the leaner/better way" advice.** Collect this from real opted-in users, privately
and cheaply, and surface it to the developer as a dashboard + an improvement backlog.

### Success criteria

1. Every install can **locally** see its own usage + efficiency review (no opt-in required for
   local-only).
2. Users can **opt in once** (comms-style gate) to share **anonymous, content-free** telemetry.
3. The developer sees, on a self-owned endpoint: top tools, top MCPs, per-tool error rates, tool
   co-occurrence, tool-calls-per-task, and a ranked list of **constructive improvement
   suggestions** (the efficiency/quality backlog).
4. No prompt text, code, file contents, or chat/WhatsApp data ever leaves a machine
   automatically. Deep context leaves only when a human **deliberately** sends a report.
5. Zero paid services; the ingest + dashboard run on the existing Dokploy box.

### Non-goals (v1)

- No real-time streaming/analytics engine; batch POST + file storage + JS aggregation.
- No cross-user identity beyond one anonymous random install-id.
- No automatic capture of prompt/response content (only deliberate per-incident reports carry context).

---

## 2. Privacy spine (non-negotiable, governs everything)

Two data zones, enforced by construction:

- **Zone A — anonymous, content-free (may auto-leave if opted in):** tool/MCP *names*, counts,
  ok/fail booleans, sanitized error *types* (never messages), durations (bucketed), tool→tool
  sequences, session/compaction counts, plugin version, model name, OS family, and **Arm-2
  distillations** (task *category*, tool-call count, efficiency score, redundancy-pattern *tag*,
  suggestion *tag*, severity). All categorical/numeric. No free text from the user/model.
- **Zone B — content (NEVER auto-leaves):** prompts, model output, code, file paths/contents,
  tool arguments, chat/WhatsApp data, full transcripts, the full human-readable Arm-2 critique.
  Stays local. Leaves **only** when a human runs a deliberate report and confirms.

- **Anonymous install-id:** one random UUID v4 written once to `~/.mochi/install-id` (machine/user
  scoped, NOT per-project, NO PII). Lets the developer tell "10 users once" from "1 user 10×".
  Resettable; deleting the file rotates it.
- **Opt-in, not opt-out.** Default = local capture only, **nothing leaves**. Sharing requires
  explicit consent via the gate (§7). A kill-switch fully disables both capture and sending.
- **Transparency:** `/mochi:telemetry show` prints *exactly* what is stored and what would be (or
  was) sent — the literal payloads — so a user can audit before/after opting in.

---

## 3. Architecture overview — three arms + one endpoint

```
PLUGIN (each user's machine)                         INGEST (your Dokploy)
─────────────────────────────                        ─────────────────────
Arm 1  hooks → content-free events  ─┐
       .continuum/telemetry/events.jsonl              mochi-insight.nexalance.cloud
Arm 2  agent reviews transcript →    ─┼─ batched ───►  POST /v1/ingest  (write-key)
       local critique + distillation │   anon POST       → append JSONL on a volume
Arm 3  deliberate report (context) ──┘   (if opted in)  GET  /dashboard  (owner basic-auth)
       (reuses /mochi:feedback)                          GET  /v1/summary (owner; powers /mochi:insights)
                                                         GET  /v1/health
```

- **Arm 1 — passive usage capture** (content-free, automatic locally).
- **Arm 2 — efficiency & quality critique** (agent-driven, local; the constructive-advice arm).
- **Arm 3 — deliberate reports** (human-initiated, may carry context).
- **Transport** — a single self-hosted Node+JSON ingest service; `gh`-issue feedback stays as an
  optional secondary path for users who prefer GitHub.

### Component boundaries

| Unit | Responsibility | Where |
|---|---|---|
| `install_id.js` | read/create `~/.mochi/install-id` | plugin lib |
| `telemetry_config.js` | consent state, kill-switch, sampling, endpoint cfg | plugin lib |
| `telemetry_log.js` | append + prune content-free events (run-history-shaped) | plugin lib |
| `telemetry_emit.js` | batch + POST Zone-A payloads, fail-open, offline queue | plugin lib |
| `telemetry_redact.js` | enforce Zone-A schema (whitelist fields, drop everything else) | plugin lib |
| hooks (extend) | write events; emit consent/review directives | plugin hooks |
| `/mochi:telemetry` cmd | opt in/out, show, report, flush | plugin command |
| `/mochi:review-session` cmd | Arm-2 critique on demand | plugin command |
| `/mochi:insights` cmd | owner: fetch `/v1/summary`, print | plugin command |
| ingest server | receive, validate, store, aggregate, dashboard | `telemetry-server/` (Dokploy) |

---

## 4. Arm 1 — passive usage capture (content-free)

**Capture point:** `PreToolUse` (fires before *every* tool) records the call; `PostToolUse`
(matcher widened to `*`) records the result/error. (Hook payloads — to confirm against the hooks
reference — provide `tool_name` + `tool_input` on PreToolUse and add `tool_response` on
PostToolUse; we read **only** `tool_name`, derive `mcp` from the `mcp__plugin_<server>__` prefix,
and a boolean ok/`err_type` from the response — never the arguments or response body.)

**Event shape** (the only thing written; Zone A): appended to
`.continuum/telemetry/events.jsonl`:
```json
{ "ts": 1717900000, "sid": "<session uuid>", "iid": "<install uuid>",
  "tool": "browser_click", "mcp": "mochi_browser", "ok": false,
  "err": "timeout", "dur_b": "1-3s", "v": "0.7.0", "model": "claude-...", "os": "darwin" }
```
- `err` is a **mapped category** (`timeout|not_found|bad_input|permission|network|other`) derived
  from the response, never the raw message. `dur_b` is a coarse bucket, not a precise ms (reduces
  fingerprinting).
- **Hot-path safety:** the PreToolUse hook stays ~1ms — synchronous append of one line, **no
  network, no LLM, no heavy parse** (mirrors the existing sentinel fast-skip discipline). Emission
  to the server happens later, off the hot path (§6).

**Session header:** extend the existing `.env-provenance.json` writer in `session_start.js` to
also stamp a session-open event (`plugin_version`, `bundle_hash`, `model`, `os`, `sid`, `iid`).
`session_end.js`/`pre_compact.js` add close/compaction events (reason categories only).

**Local aggregation:** `telemetry_log.js` mirrors `server/src/memory.js` run-history (append +
capped prune, e.g. keep last N MB / N days). Aggregation is JS over the JSONL at read time
(`/mochi:telemetry show`). **No SQLite, no native deps.**

---

## 5. Arm 2 — efficiency & quality critique (the constructive-advice arm)

The signal the developer most wants ("10 calls could be 3 — here's how") requires *reasoning about
a session*, which only an LLM can do. **The agent itself does it** — no extra API key, it uses the
Claude Code session already running.

**Trigger:**
- **On-demand:** `/mochi:review-session [N]` — review the current/last session now.
- **Auto (opt-in, sampled):** `session_end.js` writes a `pending-review` marker for the just-ended
  session; on the next `SessionStart`, if `telemetry.review_auto` is on and the session is sampled
  (e.g. 1-in-N, or only sessions exceeding a tool-call threshold), the gate emits a directive
  asking the agent to run the review on the **archived transcript** and emit the distillation.
  Cost = the user's own tokens, so it is **off by default, disclosed, sampled, and bounded**.

**What the review does (locally, with full content — Zone B stays local):** the agent reads the
archived transcript and produces a structured critique:
```json
{ "task_category": "web-qa", "tool_calls": 10, "efficiency_score": 0.4,
  "redundancy_pattern": "snapshot_then_retry", "quality_issue": "missing_assertion",
  "suggestion_tag": "batch_clicks", "suggestion_text": "<human-readable advice, LOCAL ONLY>",
  "severity": "medium" }
```
- The **full critique + `suggestion_text`** is shown to the user (helps them) and saved locally
  under `.continuum/telemetry/reviews/`. It is **Zone B** — never auto-sent.
- The **distillation** (everything *except* `suggestion_text`/`quality_issue` free text — i.e. the
  categorical tags + numbers) is **Zone A** and, if opted in, is emitted (§6). `task_category`,
  `redundancy_pattern`, and `suggestion_tag` are drawn from a **fixed enum** the plugin ships
  (so they're categories, not free text); a `suggestion_tag:"other"` bucket avoids forcing a fit.
- The review ends by offering: *"Share the full critique as a feedback report? (y/n)"* → Arm 3.

**Developer payoff:** the dashboard aggregates distillations into a ranked **improvement backlog**:
"web-qa tasks avg 10 calls; top waste = snapshot_then_retry (38%); top suggestion = batch_clicks"
— actionable, without ever seeing anyone's content.

**Confusion heuristics (cheap, no LLM):** compaction frequency, abnormal session-end reason,
repeated same-tool failures, stop-loops, repeated edits to one file → emitted as Zone-A counters
in Arm 1, and used to *prioritize* which sessions Arm 2 auto-reviews.

---

## 6. Arm 1/2 transport — self-hosted ingest (Dokploy)

**Emission (`telemetry_emit.js`), only if opted in:**
- Batches Zone-A events; flushes at session end (and opportunistically), **off the hot path**.
- `POST https://mochi-insight.nexalance.cloud/v1/ingest` with header `x-mochi-key: <write-key>`
  and a JSON body `{ iid, batch: [<events>] }`.
- **Fail-open & private:** uses `fetch` with a short timeout; any failure is swallowed (telemetry
  never breaks a user's session). Unsent batches queue locally (capped) and retry next flush.
- **`telemetry_redact.js` is the gate:** emit passes every object through a strict **whitelist**
  serializer — only the known Zone-A keys survive; anything else is dropped. A unit test asserts a
  payload containing a planted "secret"/prompt string is stripped. This is the structural PII guard.

**Ingest server (`telemetry-server/`, Node 22 ESM, deployed to Dokploy):**
- `POST /v1/ingest` — validate `x-mochi-key`; rate-limit per `iid`/IP (token bucket); re-validate
  each event against the Zone-A schema **server-side** (defense in depth — reject/strip unknown
  fields so a tampered client can't inject content); append to a date-bucketed JSONL on a
  **persistent volume** (`/data/events/YYYY-MM-DD.jsonl`). No DB (JSONL + JS; SQLite optional later
  if volume grows — allowed server-side, but start simple).
- `GET /dashboard` — **HTTP basic-auth (owner password)**; server-rendered HTML: top tools, top
  MCPs, per-tool error-rate, tool co-occurrence, calls-per-task histogram, and the **improvement
  backlog** (ranked suggestion_tags with counts + example redundancy patterns). Plain HTML +
  inline SVG/CSS, no heavy frontend.
- `GET /v1/summary` — owner-auth JSON aggregates (powers `/mochi:insights`).
- `GET /v1/health` — liveness.
- **Secrets via Dokploy env:** `INGEST_WRITE_KEY` (shared, baked into the plugin build — soft
  guard, see below), `DASHBOARD_USER`/`DASHBOARD_PASS` (owner only, never shipped).
- **Honest limitation:** a write-key shipped in distributed plugin code is discoverable. It is a
  spam deterrent, not a secret; real protection = server-side rate-limit + Zone-A schema
  validation + the fact that only content-free anonymous data is accepted anyway.

**Deploy:** the server lives in the mochi repo under `telemetry-server/` (with a `Dockerfile`),
deployed as a Dokploy **application** (Git source = the GitHub repo, build context
`telemetry-server/`), domain `mochi-insight.nexalance.cloud` (wildcard `*.nexalance.cloud` already
resolves to the Dokploy host; Dokploy provisions TLS), one persistent **volume** mounted at
`/data`. The server is **not** bundled into the plugin — it is independent infra.

---

## 7. Consent, control & onboarding

Reuse the **comms onboarding-gate pattern** in `session_start.js` (ask once, persist, never nag,
source-aware):
- First eligible session: emit a directive → agent asks the user once:
  *"Help improve mochi? I can share anonymous, content-free usage stats (tool names + counts +
  error types — never your prompts, code, or messages). You can see exactly what's sent with
  `/mochi:telemetry show`. Share? (yes/no)"*
- Decision persists in `.continuum/telemetry/config.json` (committed? **No — gitignored**, it's a
  per-user/per-machine choice; the consent decision is not a repo artifact). Default un-shared.
- `/mochi:telemetry` subcommands: `status`, `show` (print exact stored + would-send payloads),
  `on`/`off` (opt in/out), `review-auto on|off`, `flush` (send now), `reset-id`, `purge` (delete
  local telemetry). Kill-switch `off` disables capture **and** emission.
- Honors a global kill via env (`MOCHI_TELEMETRY=off`) for enterprise/CI.

---

## 8. Files & reuse

**New (plugin lib `plugins/continuum/lib/`):** `install_id.js`, `telemetry_config.js`,
`telemetry_log.js`, `telemetry_redact.js`, `telemetry_emit.js`, `telemetry_aggregate.js`,
`telemetry_review.js` (helpers for the review command).
**New commands (`plugins/continuum/commands/`):** `telemetry.md`, `review-session.md`,
`insights.md`.
**Extend hooks:** `pre_tool_use.js` (record call, hot-path-safe), `post_tool_use.js` (widen matcher
to `*`, record result/err category), `session_start.js` (header + consent gate + auto-review
directive), `session_end.js` (close event + pending-review marker + flush), `pre_compact.js`
(compaction counter).
**New infra:** `telemetry-server/` (`server.mjs`, `Dockerfile`, `package.json`, `README.md`,
aggregation + dashboard render, tests).
**Reuse (do NOT duplicate):** `/mochi:feedback` + `feedback.js` for Arm 3 / `gh`-issue path; the
`.env-provenance.json` writer; the run-history append+prune shape from `server/src/memory.js`; the
comms consent-gate + idempotent `.gitignore` appender (add `telemetry/` to gitignore).
**Gitignore:** `.continuum/telemetry/` is gitignored (local, per-user). `~/.mochi/install-id` is
outside the repo entirely.

---

## 9. Constraints (from STATE.md)

- **No native modules / no SQLite in the plugin.** Plugin telemetry = JSONL + JS. (The *server* is
  separate infra and may use a DB, but v1 uses JSONL for simplicity.)
- **Bundle-ability:** plugin code stays dependency-free ESM (hooks/lib run unbundled like the rest
  of continuum). `telemetry_emit.js` uses built-in `fetch` (no axios).
- **Hot-path cost:** `pre_tool_use.js` must remain ~1ms — append-only, no network/LLM in the hook.
- **`.continuum/` is per-project**, but the install-id is machine-scoped → lives in `~/.mochi/`.
- **stdio MCP cwd is client-controlled** — resolve project dir from the hook payload `cwd`.
- **Idempotent `.gitignore` appender** must gain the `telemetry/` entry (don't revert to create-only).

---

## 10. Testing

- **Unit (dependency-free, in `plugins/continuum/tests/`):** `install_id` (create-once, reset),
  `telemetry_config` (consent/kill-switch/sampling), `telemetry_log` (append+prune),
  **`telemetry_redact` (planted-secret stripping — security-gating)**, `telemetry_emit`
  (batch shape, fail-open, offline queue, opted-out = no-send), `telemetry_aggregate` (counts/
  sequences/backlog), the consent-gate branch in `session_start.js`, hot-path no-network assertion.
- **Server tests (`telemetry-server/`):** ingest auth + rate-limit + server-side schema validation
  (rejects content), JSONL append, aggregation correctness, dashboard auth, health.
- **Integration:** mock POST end-to-end (plugin emit → local stub server → aggregate).
- **Manual acceptance:** deploy to Dokploy; hit `/v1/health`; opt-in on a test repo; confirm a real
  event lands; open the dashboard (browser) and see counts; run `/mochi:review-session` and confirm
  a critique + distillation; confirm opted-out sends nothing.

---

## 11. Deploy / ops runbook (developer-facing)

1. Build & deploy `telemetry-server/` to Dokploy (CLI authenticated): create project/app, set
   Git source + build context, set env (`INGEST_WRITE_KEY`, `DASHBOARD_USER/PASS`), attach `/data`
   volume, set domain `mochi-insight.nexalance.cloud`, deploy, verify `/v1/health` (browser).
2. Bake the public ingest URL + `INGEST_WRITE_KEY` into the plugin build (config constant).
3. Ship the plugin feature on a branch → PR → merge to `Master` → CI rebuilds bundles.
4. Hand the owner the dashboard URL + basic-auth creds.

---

## 12. Deferred to v2

- Server-side SQLite/Postgres + a richer dashboard (charts/filters) if volume grows.
- Anomaly alerts ("error rate for tool X spiked").
- An in-plugin nudge that feeds Arm-2 suggestions back to *steer the model* toward fewer calls.
- Cohorting by plugin version / model to A/B improvements.

---

## Open items to verify during implementation

- Confirm the exact Claude Code hook payload fields + output mechanism against the hooks reference
  (PreToolUse `tool_name`/`tool_input`; PostToolUse `tool_response`; `hookSpecificOutput`).
- Confirm the Dokploy CLI flow for: create app from Git + build context, set domain, env, volume
  (`dokploy application`, `dokploy domain`, `dokploy project`, `dokploy mounts`).
- Confirm `*.nexalance.cloud` resolves to the Dokploy host (pick the exact subdomain).

---

## 13. Hardening revisions (AUTHORITATIVE — overrides earlier sections on any conflict)

A privacy/security/feasibility review (verified against the live code, Dokploy CLI, and DNS)
returned FIX-FIRST. These corrections are binding; where they conflict with §1–§12, this section wins.

### 13.1 Redactor is the privacy keystone — validate VALUES, not just keys
- **B1 — bucket non-first-party tool/MCP names.** `tool`/`mcp` values are content. Ship an
  **allowlist** of mochi/built-in tool + MCP names (`mcp__plugin_mochi_*`, core tools). In
  `telemetry_redact.js`, any `tool`/`mcp` NOT in the allowlist → emit the literal
  `"thirdparty_tool"` / `"thirdparty_mcp"` (never the real name — protects client codenames,
  private MCP server names, internal hostnames). Test: plant `mcp__client_secret_project__do` →
  assert the literal is absent from the emitted payload.
- **B2 + M2 — enum value-validation.** Every categorical field (`err`, `task_category`,
  `redundancy_pattern`, `suggestion_tag`) must assert `value ∈ shipped enum`, else coerce to
  `"other"` (or drop). The redactor is **fail-closed**: unknown key → dropped; known key, bad
  value → coerced. `suggestion_text` and `quality_issue` are **Zone-B always** — never in the
  emit whitelist. Test: plant `err="/Users/j/db.js ECONNREFUSED 10.0.0.5 token=sk-live-…"` →
  emitted `err` is exactly `network`/`other`, raw string fully absent; plant a Zone-B sentence in
  `quality_issue`/`suggestion_tag` → dropped/coerced.
- **N2 — `/mochi:telemetry show` MUST call the identical redact serializer** and print its output
  verbatim, so the audit is byte-for-byte what would POST. Test: `show-output === emit-payload`.

### 13.2 Arm-3 routing correction (B3)
Deliberate context reports (Zone-B) go to **GitHub issues ONLY via the existing `feedback.js`
(`gh issue create`)** — they are **NOT** sent to `/v1/ingest` (the ingest server validates Zone-A
and would strip them). Do **not** add a `/v1/report` endpoint. The §3 diagram's Arm-3 line routes
to `gh`, not to the ingest server.

### 13.3 Consent enforced at SEND time + split into two toggles
- **M1 — enforce at POST, not capture.** `telemetry_emit.js` re-reads `config.json` + the
  `MOCHI_TELEMETRY` env **on every flush**; sends only if `share===true && killSwitch!=="off"`.
  **Absence = no send** (missing/var-unset config never sends). Capture-to-local is independent;
  emission is the gated boundary. Test: config shared but `MOCHI_TELEMETRY=off` → zero POSTs.
- **M4 — two independent opt-ins.** (1) *Share anonymous telemetry* — free, the §7 prompt. (2)
  *Enable auto efficiency-review* — **spends the user's own Claude tokens**; separate prompt that
  DISCLOSES the cost ("~X tokens per sampled session, 1-in-N sampling"); default **off** until its
  own explicit yes; on-demand `/mochi:review-session` is always available regardless. `status`
  shows the estimated token cost.

### 13.4 Anonymous-id lifecycle, retention & erasure (M3, GDPR-pseudonymous)
- **Rotate** the install-id automatically (monthly, or on plugin-major bump) — not a forever id.
- **Server-side:** day-bucket stored timestamps; drop `iid` from stored events after a short dedup
  window (keep only aggregates long-term); auto-expire date-bucketed JSONL after a documented
  retention window (e.g. 180 days).
- **Erasure:** `DELETE /v1/data?iid=…` (owner-auth) wired to `/mochi:telemetry purge` so a user can
  request server-side deletion, not just local.
- **Consent copy** states plainly: a rotating random id links a user's sessions over a period;
  lawful basis = explicit consent; how to opt out + purge.

### 13.5 Server abuse / poisoning resistance (M5, N1)
- The baked-in write-key is a soft deterrent only. Add **per-IP** rate limits + a **global ingest
  cap** (not just per-iid; iids are forgeable). Flag/segregate iids seen from many IPs or with
  implausible volume. Dashboard rankings show **volume/confidence caveats**; treat all counts as
  untrusted lower-confidence signal.
- Dashboard auth: prefer a long random **bearer/cookie** over basic-auth; constant-time compare;
  failed-attempt rate-limit; never serve `/data` statically; no directory listing/debug route;
  `/v1/health` returns only `ok`; ensure access logs don't capture the auth header.

### 13.6 Drop the always-null `model` (M6)
`model` derives from `process.env.CLAUDE_MODEL`, which is live-**null** (confirmed in
`.env-provenance.json`), and the hook payloads do not carry it. **Remove `model` from the Zone-A
schema and remove model-cohorting from §12 for v1.** (v2 may parse it from the transcript.)

### 13.7 Hook wiring order (verified — violate this and telemetry silently no-ops)
- `pre_tool_use.js`: the telemetry append runs **first, unconditionally, at the top of `main()`,
  BEFORE** the `if (!fs.existsSync(sentinel)) process.exit(0)` fast-skip (~line 48). Append one
  Zone-A line; **no network/LLM in the hook**. Emission happens off the hot path (session end).
- `post_tool_use.js`: widen matcher to `*`; the telemetry-record block runs **BEFORE** the
  `FILE_EDIT_TOOLS` early-return; the existing frontend-verify path is unchanged after it. Add a
  regression test that frontend-verify still fires post-widening.
- `session_start.js` gitignore appender (`giWanted`, ~lines 351-358) must gain `telemetry/`
  (covers `events.jsonl` AND the Zone-B `reviews/`). `config.json` stays **gitignored** (per-user
  consent, not a repo artifact). Add a test asserting an EXISTING `.gitignore` gains the entry.

### 13.8 Plugin manifest + conventions (M7, N4, N5, N6)
- **Register** `telemetry.md`, `review-session.md`, `insights.md` in
  `.claude-plugin/plugin.json` `commands[]` (explicit manifest; `.md`-on-disk alone does not load).
- **Baked-in config consts:** `plugins/continuum/lib/telemetry_config.js` exports
  `INGEST_URL = "https://mochi-insight.nexalance.cloud/v1/ingest"` and `INGEST_WRITE_KEY` (set at
  build/release). Target version = the next minor after the current `plugin.json` value at build
  time (reconcile the 0.6.1/0.7.0/0.9.1 disagreement by reading `plugin.json` when implementing).
- **Tests convention:** plugin unit tests → `plugins/continuum/tests/run-*.sh|.mjs` runners;
  `telemetry-server/` tests are colocated `*.test.mjs` run via `node --test`, wired like the comms
  server tests. User-facing command prefix is `/mochi:` (existing docs saying `/continuum:` read as `/mochi:`).
- **N3 dashboard:** include an explicit **tools-per-task-category** table (directly answers "what
  tools are useful for what task"), alongside top-tools / top-MCP / error-rate / co-occurrence /
  calls-per-task / improvement-backlog.

### 13.9 VERIFIED DEPLOY RUNBOOK (ready to use unchanged)

**DNS:** `*.nexalance.cloud` is a true wildcard A-record → **`72.60.103.57`** (Hostinger VPS =
the Dokploy host; `dokploy server all` = `[]` so apps deploy on the panel host). Any new
`<sub>.nexalance.cloud` already resolves → Let's Encrypt HTTP-01 succeeds with no extra DNS step.
**Chosen subdomain: `mochi-insight.nexalance.cloud`.** Do NOT use `dokploy.nexalance.cloud`
(Cloudflare, different host).

**Dokploy CLI sequence** (authenticated; GitHub connection `githubId = 33Dq5wkCB6QS2Xo_yTnNm`;
omit `--serverId`; all write-cmds accept `--json` — capture returned ids):
```
# 1. project (auto-creates 'production' env)
dokploy project create --name mochi-insight --description "mochi telemetry ingest+dashboard" --json
# 2. environment id (pick name=='production')
dokploy environment by-project-id --projectId <projectId> --json
# 3. application (no --serverId → deploys on Dokploy host)
dokploy application create --name ingest --appName mochi-insight --environmentId <envId> --json
# 4. git source + repo-relative app root
dokploy application save-github-provider --applicationId <appId> --githubId 33Dq5wkCB6QS2Xo_yTnNm \
  --owner DevZonayed --repository Mochi --branch Master --buildPath telemetry-server --triggerType push
# 5. build type = Dockerfile
dokploy application save-build-type --applicationId <appId> --buildType dockerfile \
  --dockerfile telemetry-server/Dockerfile --dockerContextPath telemetry-server
# 6. env (write-key + dashboard creds; newline-separated)
dokploy application save-environment --applicationId <appId> --env $'INGEST_WRITE_KEY=<gen>\nDASHBOARD_USER=<u>\nDASHBOARD_PASS=<gen>\nDATA_DIR=/data\nRETENTION_DAYS=180'
# 7. persistent volume (BEFORE deploy)
dokploy mounts create --serviceType application --serviceId <appId> --type volume --volumeName mochi-insight-data --mountPath /data
# 8. domain + TLS
dokploy domain create --applicationId <appId> --domainType application \
  --host mochi-insight.nexalance.cloud --path / --port 3000 --https --certificateType letsencrypt
# 9. deploy + observe
dokploy application deploy --applicationId <appId> --title "initial" --json
dokploy application read-logs --applicationId <appId>
```
Notes: `--buildPath` (git app-root) ≠ `--dockerContextPath`/`--dockerfile` (Docker build) — keep
both. The server listens on the port given to `--port` (e.g. 3000). The repo must contain
`telemetry-server/Dockerfile` and push to `Master` before step 4's repo ref resolves (so: build +
PR + merge the plugin/server code first, OR use `application save-git-provider --customGitUrl`
against the public repo if deploying before merge).

**Hooks (confirmed, source code.claude.com/docs hooks):** PreToolUse → `tool_name`,`tool_input`
(+`session_id`,`transcript_path`,`cwd`,`permission_mode`); PostToolUse adds `tool_response`
(string); UserPromptSubmit → `prompt`; output via `hookSpecificOutput.additionalContext`
(+`decision`,`continue`). No `model` field in payloads → §13.6.

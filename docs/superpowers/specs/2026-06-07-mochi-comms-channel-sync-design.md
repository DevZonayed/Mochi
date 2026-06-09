# Mochi Comms — Per-Repo Communication-Channel Sync & Recall

**Status:** Design (awaiting user review) — revised after adversarial hardening pass
**Date:** 2026-06-07
**Author:** brainstorming session (DevZonayed/improve-mochi-plugin)
**Plugin:** `mochi` v0.6.0 → target v0.7.0

> **Revision note:** This is v2 of the spec. A 5-critic review (verified against the live tree)
> found 5 blockers + 10 majors in v1. All are resolved here. The biggest changes vs v1:
> **(1)** the comms MCP learns the project dir explicitly (env + per-tool arg), never from cwd;
> **(2)** `session_start.js` becomes an idempotent gitignore *appender* so secrets/PII can never be
> committed; **(3)** the always-on daemon, send tools, media-byte download, a `comms_gaps`
> detector, a standalone `comms_timeline` tool, and monthly sharding are **deferred to v2** to
> keep v1 correct and lean (see §13). None of the user's must-have requirements are dropped.

---

## 1. Goal

Give every repo a **plug-and-play, channel-strict communication memory**: it can link a
messaging channel (WhatsApp first), continuously capture that channel's messages into a
**per-repo, file-based store**, and let the agent **recall** the right slice of conversation
on demand — without ever flooding context with the whole history.

The feature is **mochi's own**, not a dependency on the external Docker `wa-mcp`. It ships
inside the plugin as a third bundled MCP server (`comms`), is **channel-agnostic** (a provider
interface), and obeys every existing plugin constraint (no native modules, single bundle-able
`.mjs`, zero-install, all persistence under `.continuum/`).

### Success criteria (v1)

1. On **every repo init**, the plugin checks for comms config. If undecided, it asks **once**
   whether this repo wants any channel. "No" is remembered and never nags again. "Yes" starts
   onboarding. (Reliable on the *first* session too, and not re-triggered by resume/compact.)
2. A user can link a WhatsApp account via QR or pairing code, entirely agent-driven, with
   session credentials persisted file-based under `.continuum/` and **never committed to git**.
3. One repo can scope **multiple** chats/groups (and, by design, multiple channels later). It
   only ever sees the chats on its allowlist — structurally (non-allowlisted messages are never
   written here), not just filtered on read.
4. Messages are captured **incrementally** (latest-first cursor), stored **compactly and in
   sequence**, **deduped across sources**, and **recallable** by search or by latest-N slice —
   never bulk-dumped into context.
5. Gaps can be **back-filled from a manual chat export** (`Export chat` `.txt` + media), parsed
   into the same normalized timeline and reconciled by content fingerprint, preserving order.

### Non-goals (v1) — designed-for, deferred to v2 (see §13)

- **Telegram / other channels** — provider interface exists; no Telegram impl in v1.
- **Always-on 24/7 capture daemon** — v1 is session-scoped capture only.
- **Sending messages** — `send*` stays in the provider interface but is unimplemented in v1.
- **Media byte download / thumbnails** — v1 captures media *metadata* only (no `jimp`).
- **Heuristic gap detector** — replaced by an honest static note + manual import.
- **Real embeddings** — recall stays stemmed-token (matches plugin policy).

---

## 2. Constraints (hard rules from STATE.md, verified against source)

- **No SQLite, no native modules.** The comms store is files only (JSONL + dirs). Baileys'
  dependency tree is pure-JS — confirmed bundle-able with one swap (drop `pino`, see §9). The
  exact version is **pinned** and the bundle smoke test (§12) is a gating acceptance criterion.
- **Bundle-able / zero-install.** The comms MCP is one self-contained `dist/comms.bundle.mjs`,
  built by the existing esbuild pipeline, committed by CI. No `npm install` at the user's site.
- **All persistence per-project under `.continuum/`.** The server learns the project directory
  **explicitly** (env `COMMS_PROJECT_DIR`, else a required `project_dir` tool arg) — **never**
  from `process.cwd()`, which for a stdio MCP is client-controlled, not the project dir (§3.1).
- **Do NOT add a project-level `.mcp.json` outside the plugin's own.** The `comms` server is
  registered in the plugin's own repo-root `.mcp.json` (alongside `browser` + `continuum`).
- **Naming:** brand is `mochi`. Commands `/mochi:comms-*`; tools `mcp__plugin_mochi_comms__*`;
  the MCP is named `comms` (channel-agnostic), never `whatsapp`.
- **Recall** stays stemmed-token. We **reuse continuum's scoring primitives** (a small refactor
  exports `stem`/`tokenize`/`tokenizeStemmed`/`termFrequency` from `recall.js`, or a new
  `lib/scoring.js` — see §3 and §10), not embeddings.

---

## 3. Architecture overview

A new **`comms` MCP server**, bundled to `server/dist/comms.bundle.mjs`, runs as a long-lived
stdio process for the duration of a Claude session (stdio MCP servers persist across tool calls
within a session). It owns:

```
comms MCP server (server/src/comms/index.js → dist/comms.bundle.mjs)
├── bootstrap            resolve projectDir (env→arg), then eager-reconnect known accounts
├── tool layer           JSON-RPC tools (mcp__plugin_mochi_comms__*)
├── provider registry    name → CommsProvider
│   └── WhatsAppProvider  Baileys impl (#1)
│   └── (TelegramProvider) interface only — v2
├── capture engine       provider events → normalize → allowlist-gate → 2-tier dedupe → append
├── store layer          file-based, one append-only file per chat; cursor; index; caps
├── importer             parse WhatsApp "Export chat" → normalized → reconcile by fingerprint
└── recall layer         stemmed-token search + latest-N slice (bounded), reuses scoring primitives
```

Plus integration in the existing `continuum` plugin:

- **Init/config gate** added to `plugins/continuum/hooks/session_start.js` (single-emit, §8).
- **Idempotent `.gitignore` appender** in the same hook (§9.5) — the day-one security fix.
- **Slash commands** `plugins/continuum/commands/comms-*.md` (agent-driven onboarding & ops).
- **Scoring refactor** in `plugins/continuum/lib/` so comms recall reuses the stemmer (§10).

### 3.1 Project-directory resolution (B1 fix — load-bearing)

Stdio MCP servers do **not** run with cwd = project dir (verified: `.mcp.json` wires no env for
`continuum`; its `mcp/server.js` takes `args.project_dir || CLAUDE_PROJECT_DIR || cwd()` and the
project dir is passed **per tool call**). `recall` tolerates this because it only *reads* per
call. `comms` **writes** (live capture happens inside the process, possibly before any tool
call), so it must bind the project dir reliably:

- **Eager path:** `.mcp.json` sets `"env": { "COMMS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }`.
  On boot the server reads it and, if a linked account exists, reconnects and begins capture
  immediately, writing to that project's `.continuum/comms`.
- **Guaranteed fallback:** **every** comms tool accepts an optional `project_dir` arg (mirroring
  `recall`). The first tool call binds the project dir if the env was absent/unexpanded, then
  reconnect + capture begin. Because a socket only exists after `comms_link_account` /
  `comms_sync_now` (both tool calls carrying `project_dir`), correctness does **not** depend on
  env interpolation working — the env is purely an optimization for immediate auto-reconnect.
- The server keeps an in-memory `Map<accountId → projectDir>` and refuses to write a message to
  any store whose project dir wasn't explicitly resolved.

> Implementation must verify whether `${CLAUDE_PROJECT_DIR}` is interpolated in `.mcp.json` `env`.
> If not, the tool-arg fallback is the sole mechanism — still correct, just not eager.

### 3.2 Component boundaries (each independently testable)

| Unit | Responsibility | Depends on | Interface |
|---|---|---|---|
| `CommsProvider` | abstract a channel | — | `link/status/unlink/listChats/listGroups/getMessages/onMessage/getSessionDir` (+ `sendText/sendMedia` declared, v2) |
| `WhatsAppProvider` | Baileys socket lifecycle, event→normalized | baileys, qrcode | implements `CommsProvider` |
| `normalize.js` | provider-native msg → normalized shape | — | `normalize(provider, raw) → Msg` |
| `store.js` | persist/read normalized msgs, cursor, index, **caps** | fs only | `append/getSlice/cursor/listChats` |
| `dedupe.js` | two-tier dedupe + fingerprint | — | `fingerprint(msg)`, `isDuplicate(...)` |
| `allowlist.js` | strict access decisions | config | `isAllowed(jid)`, `assertAllowed(jid)` |
| `importer.js` | parse export → Msg[] (ordinal-aware) | fs only | `parseWhatsAppExport(path) → Msg[]` |
| `recall.js` (comms) | search over store | continuum scoring primitives | `recall(query, opts) → hits[]` |
| `config.js` (comms) | read/merge `config.json` + `config.local.json` | fs only | `readConfig/writeConfig` |
| init gate | ask-on-init + freshness (fs-only) | config.js, state files | emits one `additionalContext` |

---

## 4. Data model & storage layout

All under the **project's** `.continuum/comms/` (resolved per §3.1):

```
.continuum/comms/
├── config.json                      # per-repo intent + allowlist (COMMITTED; no secrets)
├── config.local.json                # optional per-user override (gitignored)
├── state.json                       # runtime link status per provider/account (gitignored)
├── .last-session-seen.json          # per-chat newestTs watermark for freshness note (gitignored)
├── <provider>/<accountId>/auth/     # provider session secrets (gitignored) e.g. whatsapp/work/auth/
│   └── .lock                        # single-writer lock {pid, startedAt}
├── store/
│   └── <provider>/<accountId>/<chatId>/
│       ├── meta.json                # {name, chatKind: dm|group|channel, participants?, updatedAt}
│       ├── cursor.json              # {newestId, newestTs, oldestId, oldestTs, count}
│       └── messages.jsonl           # ONE append-only file; order reconstructed at read by ts
└── media/<provider>/<accountId>/    # media BYTES — v2 only (v1 keeps media metadata in the message record); gitignored
```

> **Single append-only file per chat** (not monthly shards). This mirrors continuum's proven
> `index.jsonl` model and keeps live + backfill + import as **pure appends** (v1's append-only
> contract is never violated by mid-file insertion). Read-time ordering sorts on `ts`. Rolling to
> size-bucketed files + an offset index is a v2 optimization; a scoped allowlist won't hit the
> volume that needs it in v1.

### 4.1 Normalized message shape (the contract every provider + the importer map to)

```json
{
  "provider": "whatsapp",
  "accountId": "work",
  "chatId": "123-456@g.us",
  "msgId": "3EB0...",               // real provider id (live/backfill) OR "import:<sha1>" (import)
  "fingerprint": "fp:<sha1>",       // cross-source identity (see §4.2)
  "fromMe": false,
  "senderId": "19999999999@s.whatsapp.net",  // LID-normalized
  "senderName": "Alice",
  "ts": 1717700000,                 // epoch seconds (authoritative for ordering)
  "tsIso": "2026-06-06T18:13:20Z",  // denormalized for convenience
  "kind": "text",                   // message kind: text|image|video|audio|document|location|poll|system
  "text": "the message body or caption",
  "media": null,                    // v1: metadata only or null, e.g. {mimetype, fileName, sizeBytes}; bytes deferred to v2
  "reply_to": null,                 // msgId this quotes, if any
  "source": "live"                  // live | backfill | import  (provenance; live wins on dedupe)
}
```

> `kind` is the **message** kind. The **chat** kind lives in `meta.json` as `chatKind`
> (`dm|group|channel`) to avoid the v1 name collision. Tools that return chats use `chatKind`.

### 4.2 Two-tier dedupe (B5 fix — correctness-critical)

Live, backfill, and import can all carry the same logical message. Dedupe in two tiers, checked
on **every** insert:

1. **Within-source identity:** `(provider, accountId, chatId, msgId)`. Re-delivery of the same
   provider `msgId` is a no-op (handles live re-emits + backfill overlap).
2. **Cross-source identity (fingerprint):** the canonical, **symmetric** fingerprint is
   `fp = sha1(chatId | floor(ts/60) | normalizedSenderId | sha1(text || mediaKey))` — **no
   ordinal**. Live/backfill records and import records compute `fp` identically, so a live record
   and an imported record of the same content+minute+sender can match. **Tie-break: prefer
   `source:"live"`** (real `msgId`, media-capable); keep the live record, discard the import dup.

**Intra-minute collision (silent-loss guard):** WhatsApp exports are minute-resolution, so N
identical same-minute lines (`ok`, `ok`) share one `fp`. Reconciliation is therefore a **greedy
1:1, time-ordered match** of the N import lines against the M existing live/backfill records in
the same `(chatId, minute, senderId, text)` bucket: each existing record is consumed at most once;
unmatched import lines (when N > M) become **new** records. To keep those new import records
unique *among themselves*, the importer folds the **ordinal-within-minute** (the line's position
among same-minute export lines) into the synthetic `msgId`
(`import:<sha1(chatId | ts | ordinal | senderId | text)>`) — the ordinal lives in the `msgId`
**only, never in `fp`**. Live/backfill records never compute an ordinal. Export line order is the
sequence tiebreaker. Minute-resolution of imports is a documented limitation; live messages keep
full second + real-`msgId` fidelity.

### 4.3 Efficiency invariants (M4 fix — "not every message into context")

Enforced **server-side, independent of caller input**:

- `comms_get_messages` / `comms_recall`: default `limit` 20 / 10; **hard max `limit` 200**;
  over-limit requests are **clamped, not honored**.
- Per-response **byte/token budget** (≈ 16 KB or an estimated token cap); responses exceeding it
  are truncated with a `continuation` cursor for the next page.
- `comms_get_messages` with `anchor=msgId` (the folded-in timeline view, C5) has a **bounded**
  `before`/`after` window.
- These caps make req-5 efficiency an **invariant**, not a default the agent can override.

---

## 5. Sync model (three sources, one timeline)

1. **Forward live capture (primary).** While the `comms` MCP is connected, the provider's live
   event (`messages.upsert`) → `normalize` → `allowlist` → 2-tier `dedupe` → `store.append`.
   Cursor advances. `source:"live"`. Begins at project-dir bind time (§3.1).
2. **Backfill on connect (best-effort).** WhatsApp ships a bounded recent history at login
   (`messaging-history.set`); ingested + deduped. `source:"backfill"`. **Honest limit:** depth
   is WhatsApp-server-decided, not full lifetime. `fetchMessageHistory` is attempted best-effort
   for older paging but is frequently dropped for companion sessions — a bonus, never a guarantee.
   `isLatest` is unreliable as a "backfill complete" signal — never gate on it alone.
3. **Manual import (gap-fill, authoritative for old history).** `comms_import_history(chatId,
   filePath)` parses a WhatsApp **`Export chat`** `.txt`, normalizes each line (ordinal-aware,
   §4.2), and reconciles by fingerprint. Stitched into the single append-only file; order is
   reconstructed at read by `ts`. `source:"import"`.

Running live + backfill + import in any order converges to one clean, ordered timeline.

### 5.1 Pre-allowlist window (M10 — honest scope of "ALL")

The allowlist gates capture, but the user picks chats **after** linking. Messages that arrived in
a chat *before* it was allowlisted are not live-captured. When a chat is **newly allowlisted**,
the system auto-attempts `fetchMessageHistory` backfill for it and prompts the user to manually
import to fill the pre-allowlist window. Documented plainly: "history before a chat is linked is
whatever WhatsApp ships at login, plus anything you import."

### 5.2 WhatsApp event-handling correctness (in WhatsAppProvider)

- Unwrap `ephemeralMessage` / `viewOnceMessage` / `deviceSentMessage` wrappers; null-guard
  `message` (undefined for control events).
- `messageTimestamp` `Long` → `Number`.
- Group sender is `key.participant`, not `remoteJid`.
- **v7 `syncFullHistory` trap:** always pass an explicit `shouldSyncHistoryMessage` callback;
  `syncFullHistory:false` alone silently kills *all* history sync **and** can break live routing.
  Implement `getMessage` (reads our store) for decryption/retries.
- **LID normalization:** map `@lid` ↔ phone-JID via `jidNormalizedUser` so one person isn't
  stored twice; allowlist + fingerprint normalize first.
- **Reconnect:** on `connection:"close"`, branch on `DisconnectReason`: `loggedOut` (401) → wipe
  auth + surface re-login (write `state.json: logged_out`); `restartRequired` (515) /
  `connectionClosed` (428) / others → recreate socket and reconnect (registered creds reconnect
  headlessly). A socket is single-use after close — always recreate.

---

## 6. Config, channel-strict access & state files

### 6.1 `config.json` (committed; no secrets) — multi-channel capable (M3 fix)

```json
{
  "version": 1,
  "decided": true,               // has the user answered the "want any comms channel?" ask?
  "declined": false,             // true => user wants NO channels here; never nag
  "providers": {
    "whatsapp": {
      "accounts": {
        "work": {
          "capture": "session",          // v1 accepts only "session"; "always-on" rejected
          "mode": "strict",
          "allowed_jids": ["123-456@g.us", "19999999999@s.whatsapp.net"]
        }
      }
    }
  }
}
```

- **`mode`** is `"strict"` in v1 — the only supported value (enforced per §6.4); reserved so a
  future relaxed/observe-only mode can be added without a schema change.
- **The ask is "any channel?"**, recorded at repo level (`decided`/`declined`). Channels are
  added on demand (`/mochi:comms-setup <provider>`), so "WhatsApp accepted, Telegram not yet" is
  representable (whatsapp present in `providers`, telegram simply absent) **without** nagging
  about every possible provider.
- **Decline shape (M5):** declining writes exactly `{"version":1,"decided":true,"declined":true}`.
  `config.js` defaults `version` on read so older/short configs still parse.

### 6.2 Per-user override `config.local.json` (gitignored; M2 fix)

`config.js` merges `config.local.json` **over** `config.json` (local wins). So a committed
repo-global `declined:true` (one teammate's "no") can be overridden locally by another teammate
who *does* want a channel, and vice-versa — without changing the committed intent. A fresh clone
with committed `declined:true` emits **no** ask (req-1 "never nag" holds across clones).

### 6.3 Runtime state files (fs-readable by the hook; B4 fix)

The init hook is `fs`-only (can't call MCP tools), so connection state lives in files the MCP
writes:

- `state.json` — `{ "<provider>": { "<accountId>": { "status": "connected|needs_login|logged_out", "updatedAt": ts } } }`.
- `.last-session-seen.json` — per-chat `newestTs` watermark, updated when the agent reads a chat.

The hook diffs each allowlisted chat's `cursor.json.newestTs` against the watermark to compute
the freshness note. If `state.json` is absent, it degrades to a generic
"run `/mochi:comms-status`" line rather than a live count.

### 6.4 Channel-strict access enforcement

- **Read side:** `comms_get_messages` / `comms_recall` / `comms_list_chats` only ever return
  allowlisted chats.
- **Capture side:** a message whose normalized `chatId` isn't allowlisted is **dropped before
  write** — different repo, different files (structural guarantee).
- **Group grant clarity (m5):** allowlisting a `@g.us` grants **only that group chat** (messages
  whose `chatId == group JID`). A member's 1:1 DM still requires that member's own JID in
  `allowed_jids`.
- **Send (v2):** when implemented, `comms_send_*` will normalize the target JID (LID→phone) and
  hard-refuse outside `allowed_jids`, plus an explicit confirm gate.

---

## 7. Capture model (v1: session-scoped)

- **Session-scoped capture only.** The `comms` MCP captures live whenever a Claude session is
  open; on the next connect it back-fills best-effort. Zero extra moving parts — true
  plug-and-play, and the session MCP is the **sole writer by construction**.
- A **single-writer lockfile** `.continuum/comms/<provider>/<accountId>/auth/.lock` (`{pid,
  startedAt}`) still guards against two concurrent sessions opening sockets on the same account;
  stale-lock recovery (dead pid) on startup.
- `config.capture` accepts only `"session"` in v1; `"always-on"` is **rejected** with a "v2"
  message. The field is kept forward-compatible.
- **Why no 24/7 daemon in v1:** an OS-detached daemon has no Claude-set project dir and no
  registry mapping account→repo stores, which created the worst unresolved correctness holes in
  v1 of this spec (write-targeting, cross-repo fan-out, handoff/liveness, OS packaging) and
  raises ToS/ban exposure. Req-4 ("ALL messages") is met within the session window + backfill +
  import. Gapless 24/7 capture is the **v2 flagship** (§13).

---

## 8. Init / onboarding gate (the STRICT requirement)

Added to `plugins/continuum/hooks/session_start.js`. **Single `emitContext` at the very end**
(B3 fix): the hook accumulates a `context` string and emits exactly once, so the comms directive
is never lost behind the bootstrap gate's early `process.exit` — it fires on the **first** session
too. The gate is **idempotent against config presence regardless of `source`**, and ASK is
**source-aware** (M6 fix).

```
on SessionStart(source):
  context = ""
  read config.json (+ config.local.json overlay)        # fs only
  read state.json, .last-session-seen.json (best-effort) # fs only

  # 0) bootstrap — APPEND to the accumulator (replaces the old early emitContext+process.exit)
  if !isBootstrapped(projectDir):
     context += bootstrapDirective(projectDir)
  else:
     context += loadChainContext(projectDir)   # existing STATE.md + chain + pending-checkpoint, etc.

  # 1) ASK gate — only when truly undecided AND a real init
  if !config.decided:
     if source in {startup, clear}:
        context += ASK_DIRECTIVE
     # on resume/compact: stay silent (avoid nagging after a verbal "yes" pre-write)
  # 2) declined → silent forever
  elif config.declined:
     (nothing)
  # 3) decided + enabled provider/account but not linked
  elif anyAccountNeedsLogin(config, state):
     context += ONBOARD_DIRECTIVE            # run /mochi:comms-setup
  # 4) decided + linked → freshness note (best-effort)
  else:
     note = freshness(config, cursors, watermark)   # "N new in <chat>…" or generic status line
     if note: context += note

  emitContext(context)   # the ONE and only emit
```

> **First-session reachability (B3).** On a fresh repo both `!isBootstrapped` **and**
> `!config.decided` are true: step 0 appends `bootstrapDirective`, step 1 appends `ASK_DIRECTIVE`,
> and the single terminal `emitContext(context)` emits **both, bootstrap first then comms ASK**.
> This requires refactoring `session_start.js main()` so the `!isBootstrapped` branch *appends to
> `context`* instead of the current early `emitContext(...) + process.exit(0)` at L249-252 — that
> early exit is exactly what made the comms gate unreachable on session 1.

**ASK_DIRECTIVE** (emitted verbatim into `additionalContext`):
> This repo hasn't decided about communication-channel sync. Ask the user, once: *"Do you want
> this repo to sync a communication channel (e.g. WhatsApp) so I can recall its messages?
> (yes/no)"* — On **no**, immediately write `.continuum/comms/config.json` =
> `{"version":1,"decided":true,"declined":true}` so I never ask again. On **yes**, immediately
> write `{"version":1,"decided":true,"declined":false}` (no provider yet) **before** anything
> else, then run `/mochi:comms-setup`. Writing `decided:true` on yes *before* onboarding completes
> is essential — otherwise a later startup/clear session (before `comms_set_allowlist` runs)
> would see `decided:false` and re-ask. Always write the answer to config the moment it's given.

### 8.1 Onboarding flow (`/mochi:comms-setup [provider]`, agent-driven)

1. **Warn + consent (ToS gate):** "This uses an unofficial WhatsApp connection. It violates
   WhatsApp's ToS and the number can be banned, sometimes within weeks. Use a non-primary number.
   Proceed?"
2. `comms_link_account({provider:"whatsapp", accountId, phone?})` → returns **QR (PNG data-URL +
   ASCII)** or, if `phone` given, an **8-char pairing code** (requested once — never looped: 429).
3. Poll `comms_account_status` until `connected` (handles the immediate 515 restart internally;
   writes `state.json`).
4. `comms_list_groups` + `comms_list_chats` → present; user picks chats/groups for **this repo**.
5. `comms_set_allowlist({provider, accountId, allowed_jids})` → **merges** into `allowed_jids`
   and flips `decided:true`, `declined:false` (M5). Newly-allowlisted chats trigger §5.1 backfill.
6. `comms_sync_now` → initial backfill pass; offer manual import for older history.

---

## 9. Build / packaging

Mirror the existing `browser` bundle pipeline (verified in `server/package.json` +
`.github/workflows/build.yml`):

1. **Source:** `server/src/comms/` (MCP server `index.js` + provider/store/dedupe/importer/recall
   modules). Add deps to `server/package.json`: `@whiskeysockets/baileys` **pinned to `6.7.23`**
   (stable `legacy`; avoids RC churn — re-evaluate v7 once stable), `qrcode`. **Do not add
   `pino`** — console-logger shim (`{level, child(), trace/debug/info/warn/error}`). **Do not add
   `jimp` or `sharp`** — v1 is media-metadata-only (C4), which also de-risks bundling.
2. **Second esbuild target — refactor `build` into two named targets (don't overwrite one
   outfile; m7):**
   ```
   "build": "npm run build:browser && npm run build:comms",
   "build:browser": "<existing browser esbuild command, verbatim>",
   "build:comms": "esbuild src/comms/index.js --bundle --platform=node --format=esm --target=node20 --outfile=dist/comms.bundle.mjs --legal-comments=external --log-override:indirect-require=silent --banner:js=\"<same createRequire banner as browser>\""
   ```
   No `--external:` — fully self-contained; only `node:*` external. **Verify** `--log-override`
   is valid for the installed esbuild (`^0.28`); if not, drop it (the protobufjs warning is
   cosmetic). The `--legal-comments=external` `LEGAL.txt` sidecar is expected and already covered
   by `git add server/dist/`.
3. **`.mcp.json`** (plugin's own, repo root) — add a third key:
   ```json
   "comms": {
     "type": "stdio",
     "command": "node",
     "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/comms.bundle.mjs"],
     "env": { "COMMS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }
   }
   ```
   (Env is the eager project-dir hint; the per-tool `project_dir` arg is the guaranteed path, §3.1.)
4. **CI** (`.github/workflows/build.yml`) — add `test -f server/dist/comms.bundle.mjs` to the
   "verify bundle produced" step. `npm run build` (now both targets) + `git add server/dist/`
   already generalize; `paths-ignore: server/dist/**` already covers the new file. (Note: CI
   runs node 22, bundle targets node20 — compatible; `.md`-only pushes won't rebuild.)
5. **`.gitignore` — make `session_start.js` an idempotent appender (B2 fix, security-critical):**
   The current writer creates `.continuum/.gitignore` **only if absent** (verified, L197), so
   existing repos would never gain comms ignores → would commit auth creds + private messages.
   Change it to: read existing `.continuum/.gitignore` lines, append any missing entries, rewrite.
   Add (paths **relative to `.continuum/`**):
   ```
   comms/*
   !comms/config.json
   ```
   This ignores everything under `comms/` (auth, store, media, `state.json`,
   `.last-session-seen.json`, `config.local.json`) **except** the committed `config.json` — and is
   provider-generic (m4). Add a test: after `session_start` on a repo that already had a
   `.continuum/.gitignore`, those two lines are present. Add a migration note for repos
   bootstrapped before this change (and fix the misleading "(idempotent)" comment at L192).

Expected committed `comms.bundle.mjs`: several MB (Baileys + protobuf), comparable to the
existing ~3.5M `server.bundle.mjs` — consistent with the zero-install model. **Bundling is
mandated by Baileys' dep tree** (unlike continuum's unbundled MCP) — do not "simplify" by
un-bundling (n2).

---

## 10. MCP tool surface (`mcp__plugin_mochi_comms__*`)

Every tool accepts an optional `project_dir` (§3.1).

| Tool | Input (besides project_dir) | Purpose |
|---|---|---|
| `comms_link_account` | `{provider, accountId, phone?}` | start login; returns QR / pairing code |
| `comms_account_status` | `{provider, accountId}` | `connected` / `needs_login` / `logged_out` |
| `comms_unlink_account` | `{provider, accountId}` | wipe session files for an account |
| `comms_list_chats` / `comms_list_groups` | `{provider, accountId}` | enumerate (pick-time & status) |
| `comms_set_allowlist` | `{provider, accountId, allowed_jids}` | **merge** allowlist; flip `decided:true/declined:false` |
| `comms_get_messages` | `{provider, accountId, chatId, limit?≤200, anchor?, before?, after?, continuation?}` | latest-N or windowed slice (reads the store); bounded (§4.3) |
| `comms_recall` | `{query, provider?, accountId?, chatId?, since?, until?, limit?≤200}` | stemmed-token search → scored snippets w/ `msgId` handle |
| `comms_import_history` | `{provider, accountId, chatId, filePath}` | parse + reconcile an exported chat file |
| `comms_sync_now` | `{provider, accountId}` | force a connect + backfill pass |

> **Deferred to v2 (declared, not shipped):** `comms_send_text` / `comms_send_media` (C6),
> `comms_capture_enable/disable` (daemon, C1), `comms_gaps` (C2), standalone `comms_timeline`
> (folded into `comms_get_messages` via `anchor`, C5).

### Slash commands (`/mochi:comms-*`)

`comms-setup` (onboard), `comms-sync`, `comms-recall`, `comms-import`, `comms-status`. Thin
wrappers driving the tools, matching existing command style.

### Recall efficiency contract

`comms_recall` and `comms_get_messages` **return slices, never the whole store**, with the §4.3
hard caps. `recall` returns top-scored snippets, each with `chatId`, `tsIso`, `senderName`, a
short excerpt, and a `msgId` handle to expand via `comms_get_messages(anchor=msgId)`. This is the
"not every message into context — get the part we need, mostly latest" requirement, enforced as
an invariant. Synthetic `import:` ids are accepted by read tools; media ops (v2) will reject them
(no `mediaKey`) (m6).

---

## 11. Risks & mitigations (surfaced to the user)

| Risk | Mitigation |
|---|---|
| **WhatsApp ToS / ban** (unofficial client) | Warning at link time; non-primary-number nudge; no v1 outbound; session-scoped (not 24/7) reduces exposure. |
| **History depth not under our control** | Honest messaging; manual-import gap-fill; pre-allowlist-window note (§5.1). |
| **Baileys version churn** | Pin `6.7.23`; bundle smoke test gates upgrades; LID + `shouldSyncHistoryMessage` handled explicitly. |
| **Secret/PII leak to git** | Idempotent `.gitignore` appender (§9.5) + `comms/*` ignore w/ `config.json` exception; test-asserted. |
| **Two live sockets on one account** | Single-writer lockfile + stale recovery (§7). |
| **Pairing-code rate limit (429)** | request once, never loop. |

---

## 12. Testing strategy

Mirror the dependency-free synthetic-test approach (`plugins/continuum/tests/`, mock I/O):

- **Unit:** `normalize` (each WhatsApp variant incl. wrapped/ephemeral/group), `store`
  (append/cursor/read-time-sort/caps clamp), `dedupe` (within-source, cross-source fingerprint,
  intra-minute ordinal, live-wins tie-break), `allowlist` (strict refuse + LID normalize + group
  grant), `importer` (parse a sample `Export chat` `.txt`, idempotent re-import, ordinal),
  `recall` (scoring + slice caps), `config` (merge local-over-committed, decline shape, version
  default), init-gate (every branch incl. first-session single-emit + source-awareness + fresh
  clone with committed decline = no ask).
- **Provider:** `WhatsAppProvider` against a **mock Baileys socket** emitting synthetic
  `messages.upsert` / `messaging-history.set` / `connection.update(qr)` / close-with-reason — no
  network.
- **Security (gating):** after `session_start` on a repo with a pre-existing `.continuum/.gitignore`,
  the `comms/*` + `!comms/config.json` lines are present.
- **Smoke (gating):** `comms.bundle.mjs` builds and boots under bare `node`; lists tools over
  stdio; `npm ls` + a scan for `*.node`/install-scripts confirms pure-JS for the pinned version.
- **Manual acceptance:** real QR link on a disposable number; verify capture, recall, import
  reconciliation, allowlist refusal, latest-N caps.

---

## 13. Deferred to v2 (designed-for, intentionally out of v1 scope)

1. **Always-on 24/7 capture daemon** — gapless capture independent of Claude sessions. Needs: an
   out-of-`.continuum` per-account registry (`~/.continuum/comms/accounts/<id>/repos.json`) of
   absolute store paths + per-repo allowlists; daemon↔session handoff (heartbeat/cursor file,
   liveness, stale recovery); cross-repo write authorization; OS service packaging (launchd /
   systemd / Windows). This is the v2 flagship.
2. **Sending** — `comms_send_text/media` with confirm + honesty gate + LID-normalize-on-send.
3. **Media bytes** — `downloadMediaMessage` + `jimp` thumbnails, lazy-cached under `media/`.
4. **Telegram provider** — gramjs (`telegram`, pure-JS, bundle-able) with a `StringSession` user
   login (`api_id`/`api_hash` + phone + code + 2FA), reading own history via `messages.getHistory`.
   **Not** the Bot API (telegraf) — it can't read a user's own history.
5. **Tuned gap detector** — `comms_gaps` once there's live data to calibrate against.
6. **Storage scaling** — size-bucketed message files + an offset index when chats get large.
7. **Baileys v7** — adopt once stable for the inlined-WASM bundle benefit + protocol updates.

---

## Appendix A — provider interface (for Telegram & beyond)

```js
// Every provider implements this; tools dispatch on `provider`.
interface CommsProvider {
  name                                   // "whatsapp"
  link(accountId, opts)                  // opts:{phone?} → {method:'qr'|'pairing', payload}
  status(accountId)                      // → 'connected'|'needs_login'|'logged_out'
  unlink(accountId)                      // wipe session files
  listChats(accountId)                   // → [{id, name, chatKind}]
  listGroups(accountId)                  // → [{id, name, chatKind:'group'}]
  getMessages(accountId, chatId, {limit, before, after})  // best-effort from provider (backfill)
  onMessage(cb)                          // live stream → normalized Msg for capture
  getSessionDir(accountId)               // .continuum/comms/<provider>/<accountId>/auth
  // declared for v2, unimplemented in v1:
  sendText(accountId, chatId, text)
  sendMedia(accountId, chatId, media)
}
```

The normalized message shape (§4.1), two-tier dedupe (§4.2), allowlist (§6.4), efficiency caps
(§4.3), and the file store (§4) all operate on the normalized shape, so they're written once and
reused by every provider.

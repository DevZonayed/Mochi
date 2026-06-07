# Mochi Comms — Final-Review Fixups

Driven by the final whole-feature review. Each task is a real merge-blocking defect with a precise
fix. Implement TDD where practical; every task must end green and committed. Working dir:
`/Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney`. The engines referenced already
exist and are unit-tested — most of this is **wiring + one missing parser + security guards**.

Shared facts: normalized **Msg** shape = `{provider, accountId, chatId, msgId, fingerprint, fromMe,
senderId, senderName, ts (epoch s), tsIso, kind, text, media, reply_to, source}`. The MCP server is
`server/src/comms/index.js`; data-layer libs are `plugins/continuum/lib/comms_*.js`. Tests: run the
individual `node server/_comms_*.test.mjs` files and `bash plugins/continuum/tests/run-synthetic.sh`;
do NOT run the full `cd server && npm test` (browser/Chrome tests hang here).

---

### Task 1: Wire `comms_recall` into the MCP server

**Files:** Modify `server/src/comms/index.js`; Test `server/_comms_server.test.mjs`.

The `comms_recall` tool returns `err("comms_recall not wired in this phase")`, but the engine
`commsRecall(projectDir, opts)` is fully implemented in `plugins/continuum/lib/comms_recall.js`.

- [ ] Add at the top of index.js: `import { commsRecall } from "../../../plugins/continuum/lib/comms_recall.js";`
- [ ] Replace the `comms_recall` case body with:
  `return ok(commsRecall(projectDir, { query: args.query, provider: args.provider, accountId: args.accountId, chatId: args.chatId, since: args.since, until: args.until, limit: args.limit }));`
- [ ] Add a server test that drives the tool through the server's tool-call handler against a tmp
  `projectDir` seeded with an allowlisted chat + a few messages, asserting a **non-error scored
  result** (objects with `chatId`, `tsIso`, `excerpt`/`text`, `msgId`), not the stub error.
- [ ] Verify: `node server/_comms_server.test.mjs` passes. Commit: `fix(comms): wire comms_recall into the MCP server`.

---

### Task 2: Write the WhatsApp export parser + wire `comms_import_history` (Req 7)

**Files:** Create `plugins/continuum/lib/comms_import.js`; Modify `server/src/comms/index.js`;
Tests in `plugins/continuum/tests/run-synthetic.sh` + `server/_comms_server.test.mjs`.

`reconcileImport` exists (`comms_dedupe.js`) but the `Export chat` `.txt` → `Msg[]` parser does not
exist anywhere. `/mochi:comms-import` calls `comms_import_history` which is stubbed. This is the
single largest gap — Req 7 (history gap-fill) is currently undelivered.

- [ ] Read `comms_dedupe.js` first to learn the exact `reconcileImport(existing, importMsgs)` input
  contract (what fields it keys on, how ordinal/synthetic ids work).
- [ ] Create `comms_import.js` exporting `parseWhatsAppExport(filePath, { provider, accountId, chatId })
  → Msg[]`. Handle: bracketed `[m/d/yy, h:mm:ss AM] Sender: body` AND the dash variant
  `m/d/yy, h:mm - Sender: body`; multi-line continuation (a line with no leading timestamp appends to
  the previous message's `text`); system/notice lines (timestamp but no `Sender:`) → `kind:"system"`,
  `senderId`/`senderName` null; `<Media omitted>` / attachment markers → appropriate `kind`, caption
  text. Timestamps are minute-resolution (seconds = 0). Emit the §4.1 Msg shape with `source:"import"`,
  `fromMe:false`, `media:null`, `reply_to:null`, and `msgId`/`fingerprint` set however `reconcileImport`
  expects (synthetic `import:<sha1(chatId|ts|ordinal|senderId|text)>` consistent with the dedupe layer).
- [ ] Wire the `comms_import_history` case in index.js: read existing messages
  (`readAllMessages` from comms_store.js), `const parsed = parseWhatsAppExport(args.filePath, {provider,
  accountId, chatId})`, `const { merged, added } = reconcileImport(existing, parsed)`, `appendMessage`
  each of `added`, return `ok({ added: added.length, total: merged.length })`.
- [ ] Tests: unit-test `parseWhatsAppExport` (fold into run-synthetic.sh) on a small fixture string
  covering basic message, multi-line continuation, a system line, `<Media omitted>`, two same-minute
  lines (ordinal), and **idempotent re-import** (parsing+reconciling twice adds nothing new). Plus a
  server test invoking `comms_import_history` end-to-end on a tmp fixture file, asserting `added > 0`
  first run and `added === 0` on the second.
- [ ] Verify both suites green. Commit: `feat(comms): WhatsApp export parser + wire comms_import_history (Req 7 gap-fill)`.

---

### Task 3: Implement the missing `WhatsAppProvider` methods (onboarding throws today)

**Files:** Modify `server/src/comms/whatsapp.js`; Tests `server/_comms_wa_lifecycle.test.mjs`.

`WhatsAppProvider` has no `listGroups`/`listChats`/`getMessages`/`unlink`, so they fall through to the
base `CommsProvider` which throws `NotImplemented`. `comms-setup.md` step 4 calls `comms_list_groups`
→ `p.listGroups()` → throws → a first-time user can't enumerate chats to build the allowlist.

- [ ] Read whatsapp.js fully first (reuse its accountId→socket map, lock, and auth-wipe internals).
- [ ] `listGroups(accountId)`: get the connected socket; if not connected throw a clear
  `"account not connected"` error; `const g = await sock.groupFetchAllParticipating()`; map values to
  `[{ id, name: meta.subject, chatKind: "group" }]`.
- [ ] `listChats(accountId)`: return chats known from the local store for this provider/account (reuse
  `listChats` from comms_store.js over `.continuum/comms/store/whatsapp/<accountId>/`); no network.
- [ ] `getMessages(accountId, chatId, { limit, before, after })`: best-effort from the local store via
  `getSlice` — return normalized Msgs (provider-side read for display/backfill).
- [ ] `unlink(accountId)`: close/disconnect any live socket, `releaseLock`, and wipe the auth dir
  (reuse the existing wipe helper). Then clear the in-memory entry.
- [ ] Tests (inject a fake socket exposing `groupFetchAllParticipating`; no real baileys/network):
  `listGroups` maps subjects correctly; `unlink` removes the auth dir and releases the lock.
- [ ] Verify: `node server/_comms_wa_lifecycle.test.mjs` passes. Commit: `feat(comms): implement WhatsAppProvider listGroups/listChats/getMessages/unlink`.

---

### Task 4: `getSlice` — honor `anchor`/`before`/`after` (anchored window)

**Files:** Modify `plugins/continuum/lib/comms_store.js`; Tests `run-synthetic.sh`.

`getSlice` ignores `opts.anchor/before/after` and always returns latest-N, but `comms-recall.md`
tells the agent to call `comms_get_messages({anchor: <msgId>})` to expand around a hit — currently a
silent no-op returning the wrong messages.

- [ ] Read getSlice fully; preserve the existing no-anchor latest-N contract exactly.
- [ ] When `opts.anchor` (a msgId) is set: after the ts-desc sort, locate the anchor and return up to
  `opts.before` (default 10) OLDER + the anchor + up to `opts.after` (default 10) NEWER messages in ts
  order; clamp counts to `HARD_MAX` (200). Anchor-not-found → empty result (no throw).
- [ ] When no anchor but `before`/`after` are provided as epoch-second bounds, filter by
  `ts <= before` / `ts >= after`. Keep HARD_MAX clamp + byte budget + continuation in all paths.
- [ ] Tests: anchored window returns the N-before + anchor + N-after in order; counts clamp; ts-bound
  filtering works; no-anchor latest-N unchanged.
- [ ] Verify run-synthetic.sh green. Commit: `fix(comms): getSlice honors anchor/before/after window`.

---

### Task 5: SECURITY — allowlist-gate + path-harden `comms_get_messages`

**Files:** Modify `server/src/comms/index.js` and `plugins/continuum/lib/paths.js`; Tests
`server/_comms_server.test.mjs` + `run-synthetic.sh`.

`comms_get_messages` calls `getSlice` with `args.chatId` and **no `isAllowed` check** (a read-side
allowlist bypass), and `chatId` flows unsanitized into `commsChatDir` → `path.join` (a `../` chatId
escapes the store root).

- [ ] Read the `comms_recall` guard + `isAllowed` signature (`comms_allowlist.js`) to mirror exactly.
- [ ] In `comms_get_messages`: `const cfg = readConfig(projectDir)`; `if (!isAllowed(cfg, provider,
  accountId, chatId)) return err("chat not allowlisted");` before reading.
- [ ] Defense-in-depth in `commsChatDir(projectDir, provider, accountId, chatId)`: reject any `chatId`
  whose value contains `/`, a backslash, or `..` (throw a clear error), OR assert
  `path.resolve(result).startsWith(path.resolve(storeRootFor(provider, accountId)))`.
- [ ] Tests: (a) server test — `comms_get_messages` on a non-allowlisted chat returns an error; (b)
  unit test — `commsChatDir` with a traversal chatId throws / is rejected.
- [ ] Verify both green. Commit: `fix(comms): allowlist-gate + path-harden comms_get_messages (security)`.

---

### Task 6: Wire the state writers (`setAccountStatus`/`setSeen`) + write `meta.json`

**Files:** Modify `server/src/comms/whatsapp.js`, `server/src/comms/index.js`,
`plugins/continuum/lib/comms_store.js`; Tests `server/_comms_*.test.mjs` + `run-synthetic.sh`.

`state.json` and `.last-session-seen.json` are never written, so the init-gate `statusOf()` defaults
every account to `needs_login` forever (freshness branch unreachable). And `_capture` never writes
`meta.json`, so `listChats` returns `name:null`/`chatKind:null`.

- [ ] In whatsapp.js connection handling, import `setAccountStatus` from `comms_state.js` and call it
  on transitions using the account's bound projectDir: `"connected"` on socket open, `"logged_out"` on
  `DisconnectReason.loggedOut` (401), `"needs_login"` while QR/pairing is pending.
- [ ] In index.js, also persist status via `setAccountStatus` after a successful link/connect and in
  `comms_account_status` (belt-and-suspenders).
- [ ] Call `setSeen(projectDir, provider, accountId, normalizedChatId, newestTs)` when a chat is read
  in `comms_get_messages` and `comms_recall` so the freshness watermark advances.
- [ ] In `comms_store.js` `appendMessage`, create/update the chat's `meta.json` on first append (and
  refresh `name`/`chatKind` when known) so `listChats` returns real values.
- [ ] Tests: a mock connect writes `state.json` with `"connected"`; `appendMessage` writes `meta.json`.
- [ ] Verify green. Commit: `fix(comms): persist account status + last-seen + chat meta.json`.

---

### Task 7: Freshness jid-normalization + small correctness nits

**Files:** Modify `plugins/continuum/hooks/session_start.js`, `server/src/comms/index.js`,
`plugins/continuum/commands/comms-setup.md`, `plugins/continuum/lib/comms_store.js`; Test `run-synthetic.sh`.

- [ ] **M4:** In session_start.js freshness gate, import `normalizeJid` from `../lib/comms_allowlist.js`
  and apply it to `chatId` when building `commsCursorPath(...)` and the per-chat `seen` map key, so the
  hook matches the normalized jid the store/`setSeen` use (device-suffix jids like `12345:6@s...` map to
  `12345@s...`).
- [ ] **sync double-wire:** In `comms_sync_now`, if the account is already connected, do not call
  `connect()` again (it re-wires `sock.ev` and double-captures) — reuse the live socket / make connect
  idempotent.
- [ ] **copy:** In comms-setup.md, soften step 5's "auto-attempt history backfill" to match reality
  (best-effort / via `/mochi:comms-import`), and add a one-line note that allowlisted phone/group JIDs
  are written to the committed `config.json` (git history) — advise `config.local.json` (gitignored,
  wins on merge) for private allowlists.
- [ ] **dead import:** Drop the unused `commsChatDir` import/re-export in comms_store.js if genuinely
  unused internally (verify first).
- [ ] Test: a hook test where a device-suffix jid is allowlisted, the store (under the normalized jid)
  has a cursor newer than the watermark → the hook emits the freshness note.
- [ ] Verify run-synthetic.sh green. Commit: `fix(comms): normalize jid in freshness gate + sync/copy/dead-import nits`.

---

## Done when

- [ ] `/mochi:comms-recall` and `/mochi:comms-import` return real results (not stub errors); the import
  parser round-trips a sample export idempotently.
- [ ] `/mochi:comms-setup` step 4 (`comms_list_groups`) works against a connected socket; `unlink` wipes auth.
- [ ] `comms_get_messages` refuses non-allowlisted chats and rejects traversal chatIds; anchored window works.
- [ ] `state.json` is written on connect (init-gate reflects real status); `meta.json` gives `listChats` real names.
- [ ] Full suites green: `run-synthetic.sh`, `run-scoring.sh`, `run-comms-recall.sh`, all `server/_comms_*` tests; bundle still boots bare.

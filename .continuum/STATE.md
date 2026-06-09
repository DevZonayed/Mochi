# Super-Tester (mochi plugin) — baseline

**Status:** `mochi` Claude Code plugin (v0.6.x). Source repo + plugin distribution.
Active development. **NEW: "mochi comms" feature complete on branch
`DevZonayed/improve-mochi-plugin` (merge-ready; pending real-WhatsApp QR acceptance).**

**Stack:** Node 22+, ESM. esbuild bundles each MCP server into one self-contained
`.mjs` (no native deps, zero-install). Plugin distributed via GitHub marketplace install.

**What the plugin bundles:**
- `browser` MCP — Chrome automation (server/, Mochi extension)
- `continuum` MCP — `recall` tool + slash commands + hooks for chain memory
- `comms` MCP — per-repo WhatsApp sync & recall (Baileys), tools
  `mcp__plugin_mochi_comms__*`; bundled to `server/dist/comms.bundle.mjs`
- In-page send-hint modal (⌘⇧M) with DOM element picker + screenshot context

**Active decisions:**
- Plugin name: `mochi` (in `mochi` marketplace; repo dir stays `Super-Tester`).
- Browser MCP tools surface as `mcp__plugin_mochi_browser__*` (underscores, not colons).
- All persistence in `.continuum/` (per-project). No SQLite anywhere.
- Servers bundled with esbuild; `dist/*.bundle.mjs` committed; CI rebuilds on push to Master.
- **comms:** channel-agnostic provider interface; WhatsApp first (Baileys @6.7.23). It is
  mochi's OWN bundled MCP — NOT the external Docker wa-mcp. v1 = WhatsApp only, session-scoped
  capture, sync+recall+manual-import, media metadata-only. Deferred to v2 (spec §13): always-on
  daemon, sending, media bytes, Telegram (gramjs).
- **comms storage:** file-based under `.continuum/comms/` — `config.json` committed (per-repo
  intent + JID allowlist); `auth/`, `store/`, `media/`, `state.json`, `config.local.json`
  gitignored. Per-repo allowlist enforced AT the MCP boundary (capture-drop + read-filter +
  send-refuse + path-traversal guard).
- **comms onboarding:** `session_start.js` single-emit init gate asks once per repo
  ("any channel?"), remembers "no" forever, fires on the first session; `/mochi:comms-setup`
  drives QR/pairing login + allowlist pick.

**Do NOT:**
- Re-introduce `better-sqlite3` or any native module — bundle-ability and zero-install
  were the explicit goals (resolved 2026-05-18).
- **Bundle `sharp`/`jimp` into comms** — Baileys pulls `sharp` as an optional NATIVE peer dep;
  keep `--external:sharp --external:jimp` in `build:comms` so the bundle stays native-free.
- **Resolve the comms project dir from `process.cwd()`** — stdio MCP cwd is client-controlled;
  use `COMMS_PROJECT_DIR` env / per-tool `project_dir` arg.
- **Revert the `session_start.js` gitignore writer to create-only** — it must idempotently
  APPEND comms ignores, else existing repos commit WhatsApp creds + private messages.
- Add a project-level `.mcp.json` outside the plugin's own — duplicates `browser`, causes
  Chrome debugger conflicts. (The plugin's own repo-root `.mcp.json` registers all three servers.)
- Edit `~/.claude.json` MCP entries manually for this plugin.
- Refer to the plugin as "super-tester" in user-facing strings (brand is `mochi`); internal
  `SUPER_TESTER_*` env vars and the repo dir name stay for backward-compat.

**Open threads:**
- **comms manual acceptance NOT done:** real WhatsApp QR link on a throwaway number to prove
  live capture end-to-end (only mock/automated-tested so far). ToS/ban risk is real.
- **comms v2 backlog (spec §13):** always-on capture daemon, sending, media bytes, Telegram.
- Stale-memory cleanup in other projects still flagging the old "Mochi extension conflicts
  with browser MCP" — false since the unification.
- Chrome extension Web Store publication — deferred.
- Real embedding-based `recall` — deferred; stemmed-token recall is "good enough" (comms recall
  reuses the same scoring primitives, now in `plugins/continuum/lib/scoring.js`).
- Per-archive byte-offset retrieval — deferred.

**Refs (comms):** design `docs/superpowers/specs/2026-06-07-mochi-comms-channel-sync-design.md`;
plans `docs/superpowers/plans/2026-06-07-mochi-comms-channel-sync.md` +
`2026-06-08-comms-fixups.md`. Implementation `ff186bb..a57fcce` (~73 commits). Suites green:
run-synthetic 141/0, scoring 6/0, comms-recall 17/0, server comms 12/12 incl. native-free bundle smoke.

**Latest chain link:** `0002` (comms feature). Bootstrap was `31a233d`.

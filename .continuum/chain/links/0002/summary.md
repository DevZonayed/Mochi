## Decisions
- New feature "mochi comms": per-repo communication-channel sync & recall. Channel-agnostic provider interface; WhatsApp first via Baileys, shipped as a THIRD bundled plugin MCP server `comms` (tools `mcp__plugin_mochi_comms__*`). Explicitly NOT the external Docker wa-mcp — it is mochi's own, plug-and-play.
- v1 scope: WhatsApp only; session-scoped capture (no 24/7 daemon); sync + recall + manual import; media metadata-only. Deferred to v2 (spec §13): always-on capture daemon, sending, media bytes, Telegram (gramjs MTProto), heuristic gap detector.
- Baileys pinned 6.7.23; pino dropped for a console-logger shim; sharp/jimp `--external`-ized so the bundle stays native-free (Baileys pulls sharp as an optional NATIVE peer dep — must never inline).
- All comms state file-based under `.continuum/comms/` (config.json committed; auth/store/media/state gitignored). Per-repo JID allowlist enforced AT the MCP boundary: capture-drop + read-filter + send-refuse + path-traversal guard.

## Changes since last link
- Full implementation: 31 plan tasks (5 phases) + 7 final-review fixups, ~73 commits ff186bb..a57fcce. Data layer (comms_config/allowlist/dedupe/store/recall/state/import + scoring extraction); MCP server server/src/comms/{index,normalize,provider,whatsapp}.js; session_start.js single-emit init gate (B3) + idempotent .gitignore appender (B2, security); five /mochi:comms-* commands; build:comms esbuild target + .mcp.json `comms` entry + CI verify.
- All suites green: run-synthetic 141/0, scoring 6/0, comms-recall 17/0, server comms 12/12 incl. native-free bundle smoke. Independently verified MERGE-READY.

## Open threads
- Manual acceptance NOT done: real WhatsApp QR link on a throwaway number to prove live capture end-to-end (only mock/automated-tested so far). ToS/ban risk is real — use a non-primary number.
- Merging branch DevZonayed/improve-mochi-plugin -> master this session.
- v2 backlog (spec §13): daemon, send, media bytes, Telegram.

## Constraints / Do not
- Do NOT bundle sharp/jimp (native via Baileys optional dep) — keep `--external:sharp --external:jimp` in build:comms; bundle MUST stay native-free.
- Do NOT resolve the comms project dir from process.cwd() — use COMMS_PROJECT_DIR env / per-tool project_dir arg (stdio MCP cwd is client-controlled).
- Do NOT revert the session_start.js gitignore writer to create-only — it must idempotently APPEND comms ignores (prevents committing WhatsApp creds + private messages).

## Refs
- design → docs/superpowers/specs/2026-06-07-mochi-comms-channel-sync-design.md ; plans → docs/superpowers/plans/2026-06-07-mochi-comms-channel-sync.md + 2026-06-08-comms-fixups.md
- import parser → plugins/continuum/lib/comms_import.js (parseWhatsAppExport) ; dedupe → comms_dedupe.js (symmetric fingerprint + reconcileImport)
- security → server/src/comms/index.js (isAllowed on comms_get_messages) + plugins/continuum/lib/paths.js commsChatDir (traversal guard)
- bundle → server/dist/comms.bundle.mjs (native-free) ; build:comms in server/package.json

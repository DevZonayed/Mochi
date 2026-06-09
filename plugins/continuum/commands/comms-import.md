---
description: Back-fill old history from a WhatsApp "Export chat" .txt file — parsed, normalized, and reconciled into this repo's timeline by content fingerprint
allowed-tools: mcp__plugin_mochi_comms__comms_import_history, mcp__plugin_mochi_comms__comms_list_chats
argument-hint: <chatId> <path-to-export.txt> [provider] [accountId]
---

Import an exported chat to fill history gaps. The user exports a chat from WhatsApp (`Export chat` -> without media or with media) and gives the `.txt` path.

1. Confirm the target `chatId` (run `comms_list_chats` to resolve a name -> JID if the user gave a name). The chat must already be on this repo's allowlist.
2. Call `comms_import_history({provider, accountId, chatId, filePath})`.
   - The importer parses each line, normalizes it to the shared message shape, and reconciles by fingerprint — re-importing the same file is idempotent (no duplicates), and live/backfill records win over imported ones for the same content.
   - WhatsApp exports are **minute-resolution**, so imported timestamps are less precise than live capture; that's a documented limitation.

Report counts (`added` vs `merged`). Do not print message bodies. Order is reconstructed at read time, so imported old messages slot correctly into the timeline.

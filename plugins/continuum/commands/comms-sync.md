---
description: Force a connect + backfill pass for a linked communication channel (catches up live + best-effort history)
allowed-tools: mcp__plugin_mochi_comms__comms_account_status, mcp__plugin_mochi_comms__comms_sync_now
argument-hint: [provider] [accountId]
---

Force a sync for a linked channel. Provider defaults to `whatsapp`; if `accountId` is omitted and only one account is linked, use it — otherwise ask which.

1. Call `comms_account_status({provider, accountId})`. If not `connected`, tell the user to run `/mochi:comms-setup` and stop.
2. Call `comms_sync_now({provider, accountId})` to trigger a connect + best-effort backfill pass.

Report what changed at a high level (e.g. "synced; N chats updated"). Backfill depth is decided by WhatsApp's servers, not us — say so honestly if little history arrives, and point to `/mochi:comms-import` for older messages. Do not print message bodies.

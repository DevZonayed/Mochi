---
description: Show this repo's communication-channel link status, allowlisted chats, and message counts
allowed-tools: mcp__plugin_mochi_comms__comms_account_status, mcp__plugin_mochi_comms__comms_list_chats
argument-hint: [provider] [accountId]
---

Report the comms sync health for this repo. Provider defaults to `whatsapp`.

1. For each linked account in `.continuum/comms/config.json`, call `comms_account_status({provider, accountId})` and report `connected` / `needs_login` / `logged_out`.
2. Call `comms_list_chats({provider, accountId})` to show the allowlisted chats and their latest activity.

Present a compact status table: account, link status, chats synced, newest message time per chat. If an account shows `needs_login` or `logged_out`, tell the user to run `/mochi:comms-setup`. Do not print message bodies — this is a health summary only.

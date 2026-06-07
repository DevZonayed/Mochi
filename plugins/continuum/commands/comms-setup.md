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

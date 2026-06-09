---
description: Search this repo's synced channel messages by keyword and return scored snippets (never the whole history)
allowed-tools: mcp__plugin_mochi_comms__comms_recall, mcp__plugin_mochi_comms__comms_get_messages
argument-hint: <query words> [--chat <chatId>] [--since <iso>] [--until <iso>]
---

Search the per-repo communication store and show the user the matched snippets verbatim. The query is `$ARGUMENTS`.

1. Call `comms_recall({query, provider?, accountId?, chatId?, since?, until?, limit?})`. Pass any `--chat` / `--since` / `--until` the user supplied. Leave `limit` unset to use the server default (<=200, server-clamped — never request more to "see everything").
2. Each hit returns `chatId`, `tsIso`, `senderName`, a short excerpt, and a `msgId` handle.

Show the hits as a compact list. If the user wants more context around a hit, call `comms_get_messages({provider, accountId, chatId, anchor: <msgId>})` for a bounded window. Do **not** bulk-dump the store — recall returns slices on purpose. Do not re-summarize unless asked.

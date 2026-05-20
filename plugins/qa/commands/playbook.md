---
description: Manage Mochi playbooks (list, show, run, delete). Plays through the browser MCP tools.
argument-hint: "<verb> [args]"
allowed-tools: [Bash]
---

Parse `$ARGUMENTS` as a verb plus arguments:

- `list [--origin=…] [--tag=…] [--verifiable]` → call `browser_playbook_list` with the parsed filters; render as a markdown table.
- `show <id>` → call `browser_playbook_get`; render the meta + summary + steps to the user.
- `run <id> [--input.<name>=<value>] …` → call `browser_playbook_run` with parsed inputs; surface the verdict.
- `delete <id>` → call `browser_playbook_delete`; confirm.
- `match <task description>` → call `browser_playbook_match`; render top hits.

If no verb given, render help with these verbs and an example.

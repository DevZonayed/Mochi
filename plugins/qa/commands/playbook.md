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
- `seed [--domain=<url>] [--dry-run]` → call `browser_playbook_seed_from_codebase` with the parsed args; render the drafts as a markdown table.
- `secret-check <id>` → call `browser_playbook_secret_check`; render a table of secret names + availability + hints (never values).
- `diff accept <id> --run=<runId> [--step=N --step=M]` → call `browser_playbook_diff_accept`; report which steps were blessed and the new playbook_version.
- `export [--ids=<id1,id2>] [--origin=<host>] [--tag=<tag>] [--out=<path>]` → call `browser_playbook_export`; report bundle path + size.
- `import <path-or-url> [--overwrite] [--rewrite-origin=<host>]` → call `browser_playbook_import`; render the imported/skipped lists.
- `ui` → call `browser_playbook_dashboard` (default `open: true`); the dashboard opens in the user's active browser session.

If no verb given, render help with these verbs and an example.

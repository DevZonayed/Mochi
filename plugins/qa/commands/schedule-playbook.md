---
description: Schedule a playbook to run on a recurring cron schedule. Uses the host environment's schedule skill.
argument-hint: "<playbook-id>"
allowed-tools: [Bash, Skill]
---

The user wants to schedule playbook `$ARGUMENTS` for recurring execution.

1. Call `browser_playbook_get` for the id. If `meta.cron` is absent or empty, report: "playbook `$ARGUMENTS` has no `cron:` field. Edit the playbook frontmatter to set one (e.g., `cron: '0 7 * * 1-5'` for weekdays at 7am)."
2. Otherwise, invoke the `schedule` skill (if available in this environment) to register a routine that runs `browser_playbook_run { id: "$ARGUMENTS", inputs: <playbook.schedule_inputs> }` on the given cron schedule. The routine output should be appended to `.continuum/playbooks/inbox/<schedule_inbox or default>/<runId>.md`.
3. If the `schedule` skill is not available in this environment, report: "scheduling unavailable in this env; please run the playbook manually via `/mochi:playbook run $ARGUMENTS`."

---
description: Inspect, opt in/out of, and audit mochi's anonymous usage telemetry
allowed-tools: Bash, Read
argument-hint: status|show|on|off|review-auto on|off|flush|reset-id|purge
---

mochi can learn how its tools are used (anonymously, content-free) to improve. Local capture is always on unless the kill-switch is off; nothing leaves your machine unless you opt in. This command is your audit + control surface.

## Subcommands

- `status` — show consent state, kill-switch, install-id, local event count, and the **token cost** of auto-review.
- `show` — print **exactly** what is stored locally and what would be POSTed (the literal redacted Zone-A payload — never prompts/code/messages). Use this before opting in.
- `on` / `off` — opt in / out of sharing anonymous telemetry.
- `review-auto on|off` — enable/disable auto efficiency-review. **This spends your own Claude tokens.** `/mochi:review-session` is always available on demand regardless.
- `flush` — send queued events now (only if opted in).
- `reset-id` — rotate your anonymous install-id.
- `purge` — delete all local telemetry. (For server-side erasure, the owner runs `DELETE /v1/data?iid=<id>`.)

Run the requested subcommand:

```bash
node "$(cat .continuum/.plugin-root)/lib/telemetry_cli.js" $ARGUMENTS --project-dir "$(pwd)"
```

Show the output to the user verbatim. For `show`, emphasize that this is byte-for-byte what would be sent — there is no hidden payload.

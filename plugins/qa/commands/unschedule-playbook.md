---
description: Cancel a scheduled playbook routine.
argument-hint: "<playbook-id>"
allowed-tools: [Bash, Skill]
---

Cancel the scheduled routine for playbook `$ARGUMENTS`.

1. Use the `schedule` skill (if available) to find the routine that runs this playbook (typically named `mochi-playbook:$ARGUMENTS`) and delete it.
2. If no such routine exists, report: "no scheduled routine found for `$ARGUMENTS`."

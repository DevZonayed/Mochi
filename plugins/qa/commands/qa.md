---
description: Dispatch a verifiable browser task to the qa-tester subagent. Use for regression checks, smoke tests, and any task with a clean pass/fail outcome.
argument-hint: "<task description>"
allowed-tools: [Task]
---

Dispatch the `qa-tester` subagent with the user's task: $ARGUMENTS

Use the `Task` (Agent) tool with `subagent_type: "qa-tester"` and pass the user's task verbatim as the prompt. If the task is clearly ambiguous (no clean pass/fail outcome) explain why and ask the user to clarify before dispatching.

After the subagent returns its verdict, surface a short summary to the user:
- On `pass`: "✓ Task passed via playbook `<id>` (run `<id>`). Evidence: <screenshots/network summary>."
- On `fail`: "✗ Task failed: `<reason>`. Evidence: <…>. Suggest re-running with adjusted inputs."
- On `blocked`: "Cannot run as-is: `<reason>`. Need: <missing input or clarification>."

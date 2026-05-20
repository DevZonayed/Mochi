# Mochi QA — task routing

When the user asks you to do a browser interaction, FIRST classify:

**Verifiable + repeatable** (delegate to `qa-tester` subagent via the `Agent` tool with `subagent_type: "qa-tester"`):
- Has a binary pass/fail outcome ("does login work?", "verify the upload preview appears", "test the checkout flow").
- All inputs known up front (no mid-flow user decisions).
- Failure mode is clear (page didn't load, button missing, assertion failed).

**Operational + decisive** (stay in-line in this conversation):
- May require mid-flow user input ("which AWS region?", "which domain?", "review this draft?").
- Has side effects on real infrastructure or external accounts.
- Outcome isn't a clean pass/fail (you might need to backtrack and choose differently).

## Routing rules

1. Before any browser-leaning task, call `browser_playbook_match { url, intent, taskText }` to see if a playbook exists.
2. If a `verifiable: true` playbook matches AND the task fits the "verifiable + repeatable" bucket above → spawn `qa-tester` with the task + the playbook id.
3. If the task is operational, stay in-line:
   - Read the matching playbook (`browser_playbook_get`) before acting.
   - Follow the playbook's `## Steps` as guidance.
   - Ask the user for any missing inputs declared in `meta.inputs[]`.
   - After completing successfully, call `browser_playbook_propose_update` to grow the playbook from the trace.
4. If no playbook matches, proceed with manual snapshot/click/type. On success, call `browser_playbook_propose_update` to capture the flow.

## What goes in a playbook

Treat each `.continuum/playbooks/<origin>/<feature>.md` as a contract. Playbook frontmatter declares `inputs[]` with types — `email`, `text`, `markdown`, `file[]`, `secret`, etc. When you see `type: file[]` or `type: image` in inputs, the playbook needs files: call `browser_upload_stage` first to get a `stashId`, then pass it to `browser_upload_file` (or `browser_playbook_run` will plumb it via the `upload` step automatically).

Secrets (`type: secret`) are NEVER logged in traces or proposed playbook bodies. Resolve them from `process.env.<NAME_UPPERCASE>` at run time; never write the value into the playbook.

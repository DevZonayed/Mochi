---
description: Arm-2 — critique the current/last session for efficiency & quality, emit a Zone-A distillation, offer a deliberate GitHub feedback report
allowed-tools: Bash, Read
argument-hint: "[N | latest | <archive path>]"
---

Review a session to find where tool calls could have been leaner and surface concrete improvements. This runs locally with full content — the **full critique stays on this machine (Zone B)**; only a categorical distillation may leave (Zone A), and only if telemetry sharing is on.

## Steps

1. **Find the transcript.** If `$ARGUMENTS` names an archive path, use it. Otherwise read the latest archived transcript:

```bash
node "$(cat .continuum/.plugin-root)/lib/render_archive.js" --project-dir "$(pwd)" --latest
```

   Use `zcat` on the archived `.jsonl.gz` if you need the raw turns.

2. **Critique it.** Produce a structured critique. Choose `task_category`, `redundancy_pattern`, `suggestion_tag`, and `severity` from the SHIPPED enums (in `lib/telemetry_redact.js` — `TASK_ENUM`, `REDUNDANCY_ENUM`, `SUGGESTION_ENUM`, `SEVERITY_ENUM`); use `"other"` when nothing fits. Count `tool_calls` and estimate `efficiency_score` (0-1). Write `suggestion_text` (human-readable advice) and `quality_issue` as free text — **these are Zone B and never leave**.

3. **Save the full critique locally** (Zone B) under `.continuum/telemetry/reviews/` and show it to the user — this is the part that actually helps them.

4. **Emit the Zone-A distillation.** Pass the categorical-only fields through the redactor and append it as a telemetry line (flushed only if sharing is on). The redactor drops `suggestion_text`/`quality_issue` structurally:

```bash
node "$(cat .continuum/.plugin-root)/lib/telemetry_review_cli.js" emit --project-dir "$(pwd)" \
  --distillation '{"task_category":"...","tool_calls":0,"efficiency_score":0,"redundancy_pattern":"...","suggestion_tag":"...","severity":"..."}'
```

5. **Offer Arm-3 (deliberate context report).** Ask: *"Share the full critique as a feedback report? (y/n)"* — if yes, route it through **`/mochi:feedback` (GitHub issues via `gh`) ONLY**. Deliberate context reports are **NOT** sent to the telemetry ingest server (which validates Zone-A only and would strip all free text). This is the only path by which deep context leaves, and only on explicit human confirmation.

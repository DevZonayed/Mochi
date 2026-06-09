---
description: Owner-only — fetch and print the mochi-insight server's aggregate summary
allowed-tools: Bash, Read
argument-hint: "(owner bearer/credentials required)"
---

For the **plugin owner only**. Fetches aggregated, content-free usage insights from the self-hosted ingest server and prints them. Regular users do not have credentials and should use `/mochi:telemetry show` for their own local view.

1. Confirm the owner has the dashboard bearer token (or basic-auth) — never hard-code it.
2. Fetch and pretty-print the summary:

```bash
curl -fsS -H "authorization: Bearer $MOCHI_DASHBOARD_TOKEN" \
  https://mochi-insight.nexalance.cloud/v1/summary | python3 -m json.tool
```

Render the result as: top tools, top MCPs, per-tool error rates, tool co-occurrence, calls-per-task, tools-per-task-category, and the ranked improvement backlog. If the request 401s, the token is missing/wrong; if it times out, check the server health at `/v1/health`.

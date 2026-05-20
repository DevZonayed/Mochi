# Mochi 0.4.0 — Real-World Test Plan

This is what you (the human) need to run to validate v0.4.0 against real sites.
None of it can be driven from inside the Claude session where it was built,
because that session's tool list is pinned to whatever was loaded at start.

## Prerequisites

1. The push landed on GitHub. Verify: <https://github.com/DevZonayed/Mochi/commits/Master>.
2. CI rebuilt `server/dist/server.bundle.mjs` (check the latest Actions run).

## Step 1 — Update the plugin

In a **new** Claude Code session (not this one — its tools are stale):

```
/plugin update mochi
```

If that doesn't pull the new version, force-reinstall:

```
/plugin uninstall mochi
/plugin marketplace remove DevZonayed/Mochi
/plugin marketplace add DevZonayed/Mochi
/plugin install mochi@mochi
```

Restart Claude Code.

## Step 2 — Reload the Chrome extension

The extension code didn't change in 0.4.0, but the install path did (cache
key includes the version).

```
chrome://extensions → Developer mode → Remove any old Mochi → Load unpacked → select
  ~/.claude/plugins/cache/mochi/mochi/0.4.0/extension
```

## Step 3 — Smoke check from inside Claude

```
Ask Claude: "list mochi tools"
```

Expected: 54 tools, including `browser_upload_stage`, `browser_upload_file`,
`browser_playbook_*` (7 v1 tools), `browser_playbook_secret_check`,
`browser_playbook_seed_from_codebase`, `browser_playbook_diff_accept`,
`browser_playbook_export`, `browser_playbook_import`,
`browser_playbook_dashboard`.

If the count is 39 or 41 or 48, the plugin cache didn't update — recheck Step 1.

## Step 4 — Server-side e2e tests (against fixture pages, no real site)

```
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server
npm run test:e2e:upload    # 5 upload-strategy fixtures
npm run test:e2e:playbook  # playbook system fixtures
```

Both should report PASS if Chrome+extension are connected. They SKIP cleanly
if not. This is the highest-confidence local validation.

## Step 5 — Real-world upload test

Pick a target. Easiest: <https://imgur.com/upload> (single page, file input, no
auth required).

```
Ask Claude (in the updated session):
"Use mochi to navigate to https://imgur.com/upload and upload an image"

Then provide an image — Claude should:
1. Call browser_upload_stage with the image source.
2. Call browser_navigate to imgur.com/upload.
3. Call browser_upload_file with the stashId and an auto: {near: "input[type=file]"} target.
4. Smart-wait fires when the preview thumbnail appears.
```

If anything fails, the result envelope reports which strategy attempted what:

```
{
  ok: false,
  error: { code: "all-strategies-failed", details: { attempts: [...] } }
}
```

That tells you whether the failure was in `direct`, `intercept`, `drop`, or `paste`.

## Step 6 — Real-world QA subagent test

Pick a small auth flow. **Use a throwaway account.** Set up a 1Password ref
or env var first:

```bash
export DEMO_PASSWORD="your-test-account-password"
```

Then in Claude:

```
/qa test the login flow on https://demo.example.com using username demo@example.com
```

The qa-tester subagent should:
1. Spawn (look for the new "Task" tool call in the transcript).
2. Navigate, find the form via snapshot, type credentials, click submit.
3. Return one of `{verdict: "pass"|"fail"|"blocked"}` with evidence.

If the playbook didn't exist yet, it should call `browser_playbook_propose_update`
to save the trace as `<domain>/login.md`. Next run reads from that and is faster.

## Step 7 — Codebase-derived seeding

If you have a Next.js / Vite / Vue / SvelteKit project handy:

```
Ask Claude: "seed playbooks from /path/to/my/nextjs-project, domain app.localhost:3000"
```

Should call `browser_playbook_seed_from_codebase` and create draft playbooks
under `.continuum/playbooks/app.localhost:3000/<feature>.md` (one per route
with a form). Verify by:

```
cat .continuum/playbooks/index.json | jq '.playbooks[] | .id'
```

Each draft has `playbook_version: 0` until you run + bless it.

## Step 8 — HTML dashboard

```
Ask Claude: "/mochi:playbook ui"
```

Should generate `.continuum/playbooks/ui/index.html` and open it in your active
browser session. You should see all playbooks with search + tag filters.

## Step 9 — Cross-project bundle export/import

Export your library:

```
Ask Claude: "export all playbooks to ~/playbooks-backup.json"
```

Then in a different project (or the same one with `.continuum/playbooks/`
deleted), import:

```
Ask Claude: "import ~/playbooks-backup.json"
```

All playbooks should restore, including screenshots and selector caches.

## Known unvalidated areas (where bugs are most likely)

These were tested at the unit / fixture level but never against a real site:

- **`drop` strategy** in `browser_upload_file`. The JS-injected `DataTransfer`
  approach works in our fixture but real sites may have framework-specific
  drop handlers (React synthetic events, Vue refs) that block synthesized
  drag events.
- **`paste` strategy.** Same concern, especially against contenteditable
  composers in React (Slack, Notion).
- **File-chooser intercept** on sites that re-trigger the input multiple times
  or use shadow-DOM containers.
- **1Password resolution** when multiple accounts are signed in (`op signin
  --account=<acct>` may be required).
- **Smart-router** classification. Main Claude reads `plugins/qa/CLAUDE.md`
  on plugin install — first real test will reveal whether the rule actually
  fires on ambiguous tasks.
- **Visual diff** against real pages with antialiasing, animations, dynamic
  ads. The 5%/20% thresholds were chosen for fixture screenshots; real sites
  may need tuning per playbook.

When you hit a bug, file via `/mochi:feedback` (the plugin's built-in capability
gap collector) — your note lands in `.continuum/feedback/queue.jsonl` and you
can flush to GitHub issues later via `/mochi:feedback flush`.

## If something is broken

The plugin's source is at `~/.claude/plugins/cache/mochi/mochi/0.4.0/`. To
rebuild from source after a code fix:

```bash
cd /Users/jonayedahamed/Desktop/Projects/Personal/Super-Tester/server
npm install
npm run build  # rewrites dist/server.bundle.mjs
git add server/dist/ && git commit -m "ci: bundle" && git push
# Then in Claude: /plugin update mochi
```

For pure command / hook / agent / skill changes (no MCP server changes):

```bash
# Just edit the file under plugins/qa/ or plugins/continuum/, push, then:
/reload-plugins
```

That avoids the full plugin uninstall/install cycle.

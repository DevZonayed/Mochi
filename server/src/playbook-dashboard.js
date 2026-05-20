// server/src/playbook-dashboard.js
// Generates a self-contained HTML dashboard from the playbook library.
import fs from "node:fs/promises";
import path from "node:path";
import { playbooksDir, listPlaybooks, getPlaybook } from "./playbooks.js";

export async function generateDashboard({ outputPath } = {}) {
  const finalPath = outputPath || path.join(playbooksDir(), "ui", "index.html");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const entries = await listPlaybooks({});
  const enriched = [];
  for (const e of entries) {
    const pb = await getPlaybook(e.id);
    if (!pb) continue;
    enriched.push({
      id: e.id, origin: e.origin, feature: e.feature, title: e.title,
      verifiable: !!e.verifiable,
      draft: (pb.meta.playbook_version || 0) === 0,
      success_count: e.success_count || 0,
      last_verified: e.last_verified,
      tags: e.tags || [],
      inputs: e.inputs || [],
      summary: extractSection(pb.body || "", "Summary"),
      stepsBody: extractSection(pb.body || "", "Steps"),
      recentRuns: extractSection(pb.body || "", "Recent runs"),
    });
  }
  const html = renderHtml(enriched);
  await fs.writeFile(finalPath, html);
  const stat = await fs.stat(finalPath);
  return { ok: true, path: finalPath, playbookCount: enriched.length, totalSizeBytes: stat.size };
}

function extractSection(body, name) {
  const heading = `## ${name}`;
  const idx = body.indexOf(heading);
  if (idx < 0) return "";
  const after = idx + heading.length;
  const next = body.indexOf("##", after);
  return body.slice(after, next > 0 ? next : body.length).trim();
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderHtml(entries) {
  const verifiableCount = entries.filter((e) => e.verifiable).length;
  const draftCount      = entries.filter((e) => e.draft).length;
  const totalRuns       = entries.reduce((s, e) => s + (e.success_count || 0), 0);
  const tagSet = new Set();
  for (const e of entries) for (const t of e.tags || []) tagSet.add(t);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mochi Playbooks</title>
<style>
  *{box-sizing:border-box}
  body{font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;background:#0d1117;color:#c9d1d9}
  header{padding:24px 32px;border-bottom:1px solid #21262d}
  header h1{margin:0;font-size:20px;font-weight:600}
  header .meta{color:#8b949e;font-size:13px;margin-top:4px}
  .container{max-width:1100px;margin:0 auto;padding:24px 32px}
  .search{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .search input{flex:1;min-width:200px;background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:8px 12px;border-radius:6px;font:inherit}
  .tag{display:inline-block;padding:2px 8px;background:#21262d;border-radius:10px;font-size:11px;color:#8b949e;cursor:pointer;border:1px solid transparent}
  .tag.active{background:#1f6feb;color:#fff;border-color:#1f6feb}
  .row{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:8px;cursor:pointer}
  .row:hover{border-color:#58a6ff}
  .row .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#58a6ff}
  .row .title{font-size:14px;margin-top:4px}
  .row .meta{color:#8b949e;font-size:12px;margin-top:6px;display:flex;gap:12px;flex-wrap:wrap}
  .row .badges{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
  .badge{font-size:11px;padding:2px 8px;border-radius:10px}
  .badge.verifiable{background:#238636;color:#fff}
  .badge.draft{background:#9e6a03;color:#fff}
  .badge.tag{background:#30363d;color:#c9d1d9}
  .expand{display:none;margin-top:16px;padding-top:16px;border-top:1px solid #30363d}
  .row.open .expand{display:block}
  .expand h4{margin:12px 0 4px;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px}
  .expand pre{background:#0d1117;padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;white-space:pre-wrap}
  footer{padding:16px 32px;color:#8b949e;font-size:12px;border-top:1px solid #21262d;margin-top:24px}
</style>
</head>
<body>
<header>
  <h1>Mochi Playbooks</h1>
  <div class="meta">${entries.length} playbooks · ${verifiableCount} verifiable · ${draftCount} drafts · ${totalRuns} total runs</div>
</header>
<div class="container">
  <div class="search">
    <input id="q" placeholder="Search by id, title, or input…">
    <div id="tags">${[...tagSet].map((t) => `<span class="tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join("")}</div>
  </div>
  <div id="rows">
${entries.map(renderRow).join("\n")}
  </div>
</div>
<footer>generated ${escHtml(new Date().toISOString())} · mochi playbook dashboard</footer>
<script>
const rows = document.querySelectorAll(".row");
const q = document.getElementById("q");
const tags = document.querySelectorAll(".tag");
const activeTags = new Set();
function apply() {
  const term = q.value.toLowerCase();
  rows.forEach((r) => {
    const text = r.dataset.search;
    const rowTags = (r.dataset.tags || "").split(",");
    const matchTerm = !term || text.includes(term);
    const matchTags = !activeTags.size || [...activeTags].every((t) => rowTags.includes(t));
    r.style.display = (matchTerm && matchTags) ? "" : "none";
  });
}
q.addEventListener("input", apply);
tags.forEach((t) => t.addEventListener("click", () => {
  const v = t.dataset.tag;
  if (activeTags.has(v)) { activeTags.delete(v); t.classList.remove("active"); }
  else { activeTags.add(v); t.classList.add("active"); }
  apply();
}));
rows.forEach((r) => r.addEventListener("click", () => r.classList.toggle("open")));
</script>
</body>
</html>`;
}

function renderRow(e) {
  const search = [e.id, e.title, ...(e.inputs || [])].join(" ").toLowerCase();
  const lastRun = e.last_verified ? new Date(e.last_verified).toLocaleString() : "never";
  return `<div class="row" data-search="${escHtml(search)}" data-tags="${escHtml((e.tags || []).join(","))}">
  <div class="id">${escHtml(e.id)}</div>
  <div class="title">${escHtml(e.title)}</div>
  <div class="meta">
    <span>★ ${e.success_count} runs</span>
    <span>last: ${escHtml(lastRun)}</span>
    <span>inputs: ${escHtml((e.inputs || []).join(", ") || "(none)")}</span>
  </div>
  <div class="badges">
    ${e.verifiable ? '<span class="badge verifiable">verifiable</span>' : ""}
    ${e.draft ? '<span class="badge draft">draft</span>' : ""}
    ${(e.tags || []).map((t) => `<span class="badge tag">${escHtml(t)}</span>`).join("")}
  </div>
  <div class="expand">
    <h4>Summary</h4>
    <pre>${escHtml(e.summary)}</pre>
    <h4>Steps</h4>
    <pre>${escHtml(e.stepsBody)}</pre>
    <h4>Recent runs</h4>
    <pre>${escHtml(e.recentRuns)}</pre>
  </div>
</div>`;
}

// telemetry-server/dashboard.mjs
// Server-rendered owner dashboard: plain HTML + inline SVG, no JS, no external
// assets, no static /data serving (§13.5). All stored values are escaped — they
// originate from untrusted POSTs even after redaction.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function barRows(rows, label, valueOf) {
  if (!rows.length) return `<p class="empty">no data</p>`;
  const max = Math.max(1, ...rows.map(valueOf));
  return rows.map((r) => {
    const v = valueOf(r);
    const w = Math.round((v / max) * 240);
    return `<div class="row"><span class="lbl">${esc(label(r))}</span>` +
      `<svg width="260" height="16" role="img"><rect x="0" y="2" width="${w}" height="12" fill="#3b82f6"></rect></svg>` +
      `<span class="val">${esc(v)}</span></div>`;
  }).join("");
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderDashboard(a) {
  const sections = [];
  sections.push(`<h2>Top Tools</h2>${barRows(a.topTools, (r) => r.name, (r) => r.count)}`);
  sections.push(`<h2>Top MCPs</h2>${barRows(a.topMcps, (r) => r.name, (r) => r.count)}`);
  sections.push(`<h2>Error Rates</h2>` + table(
    ["tool", "fail", "total", "rate"],
    a.errorRates.map((e) => [e.tool, e.fail, e.total, (e.rate * 100).toFixed(0) + "%"]),
  ));
  sections.push(`<h2>Tool Co-occurrence</h2>` + table(
    ["from", "to", "count"], a.sequences.map((s) => [s.from, s.to, s.count]),
  ));
  sections.push(`<h2>Calls per Task</h2>` + table(
    ["task_category", "sessions", "avg calls"],
    a.callsPerTask.map((c) => [c.task_category, c.count, c.avgCalls.toFixed(1)]),
  ));
  sections.push(`<h2>Tools per Task Category</h2>` + table(
    ["task_category", "tools (count)"],
    a.toolsPerTaskCategory.map((t) => [t.task_category, t.tools.map((x) => `${x.name}:${x.count}`).join(", ")]),
  ));
  sections.push(`<h2>Improvement Backlog</h2>` + table(
    ["suggestion_tag", "count", "top redundancy", "confidence"],
    a.backlog.map((b) => [b.suggestion_tag, b.count, b.topRedundancy ?? "-", b.lowConfidence ? "low-confidence" : "ok"]),
  ));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Mochi Insight</title><meta name="robots" content="noindex">` +
    `<style>body{font:14px system-ui;margin:2rem;max-width:900px}` +
    `h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.6rem;border-bottom:1px solid #eee}` +
    `.row{display:flex;align-items:center;gap:.5rem;margin:.15rem 0}.lbl{width:180px}.val{width:40px;text-align:right}` +
    `.empty{color:#888}table{border-collapse:collapse;width:100%}th,td{border:1px solid #eee;padding:.3rem .5rem;text-align:left}` +
    `</style></head><body><h1>Mochi Insight — Zone-A telemetry</h1>` +
    `<p class="empty">All counts are untrusted, content-free lower-confidence signal.</p>` +
    sections.join("") + `</body></html>`;
}

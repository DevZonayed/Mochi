// Pure-JS aggregation over Zone-A telemetry events (and Arm-2 distillations).
// No I/O, no network — the caller passes an array of already-redacted Zone-A
// objects (from telemetry_log.readEvents). Powers /mochi:telemetry show and,
// server-side, the dashboard + /v1/summary. Mirrors the run-history reduce
// shape from server/src/memory.js (cheap, allocation-light, no deps).
//
// aggregate(events) -> { topTools, topMcps, errorRates, sequences,
//                        callsPerTask, backlog, toolsPerTaskCategory }
// Distillations (Arm-2 Zone-A) are events carrying a `task_category` field;
// usage events carry `tool`/`mcp`. Both may appear in one array.

function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function rankDesc(map, label) {
  return [...map.entries()]
    .map(([k, count]) => ({ [label]: k, count }))
    .sort((a, b) => b.count - a.count || String(a[label]).localeCompare(String(b[label])));
}

// Group usage events by session, sort each by ts, then count adjacent
// tool→tool transitions. Transitions never span a session boundary.
function buildSequences(usage) {
  const bySid = new Map();
  for (const e of usage) {
    if (!e.sid) continue;
    if (!bySid.has(e.sid)) bySid.set(e.sid, []);
    bySid.get(e.sid).push(e);
  }
  const pairs = new Map(); // "from→to" -> count
  for (const evs of bySid.values()) {
    evs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (let i = 1; i < evs.length; i++) {
      const key = evs[i - 1].tool + "→" + evs[i].tool;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  return [...pairs.entries()]
    .map(([k, count]) => { const [from, to] = k.split("→"); return { from, to, count }; })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

// callsPerTask: avg/min/max/n of distillation tool_calls per task_category.
function buildCallsPerTask(distill) {
  const m = new Map();
  for (const d of distill) {
    const n = Number(d.tool_calls);
    if (!Number.isFinite(n)) continue;
    const c = m.get(d.task_category) || { task_category: d.task_category, n: 0, sum: 0, min: Infinity, max: -Infinity };
    c.n++; c.sum += n; c.min = Math.min(c.min, n); c.max = Math.max(c.max, n);
    m.set(d.task_category, c);
  }
  return [...m.values()]
    .map((c) => ({ task_category: c.task_category, n: c.n, avg: Number((c.sum / c.n).toFixed(2)), min: c.min, max: c.max }))
    .sort((a, b) => b.n - a.n || a.task_category.localeCompare(b.task_category));
}

// toolsPerTaskCategory: for each task_category, count the tools used in the
// sessions (sid) carrying a distillation of that category — the "what tools
// for what task" table. A sid maps to its distillation's category.
function buildToolsPerTaskCategory(usage, distill) {
  const sidToCat = new Map();
  for (const d of distill) if (d.sid) sidToCat.set(d.sid, d.task_category);
  const byCat = new Map(); // category -> Map(tool -> count)
  for (const e of usage) {
    const cat = sidToCat.get(e.sid);
    if (!cat) continue;
    const tools = byCat.get(cat) || new Map();
    tools.set(e.tool, (tools.get(e.tool) || 0) + 1);
    byCat.set(cat, tools);
  }
  return [...byCat.entries()]
    .map(([task_category, tools]) => ({
      task_category,
      tools: [...tools.entries()].map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    }))
    .sort((a, b) => a.task_category.localeCompare(b.task_category));
}

function modal(values) {
  const m = new Map();
  for (const v of values) if (v != null) m.set(v, (m.get(v) || 0) + 1);
  let best = null, bestN = -1;
  for (const [v, n] of m) if (n > bestN || (n === bestN && best != null && String(v) < String(best))) { best = v; bestN = n; }
  return best;
}
function buildBacklog(distill) {
  const m = new Map(); // suggestion_tag -> rows
  for (const d of distill) {
    const tag = d.suggestion_tag;
    if (tag == null) continue;
    if (!m.has(tag)) m.set(tag, []);
    m.get(tag).push(d);
  }
  return [...m.entries()].map(([suggestion_tag, rows]) => {
    const effs = rows.map((r) => Number(r.efficiency_score)).filter(Number.isFinite);
    return {
      suggestion_tag,
      count: rows.length,
      topRedundancy: modal(rows.map((r) => r.redundancy_pattern)),
      severity: modal(rows.map((r) => r.severity)),
      avgEfficiency: effs.length ? Number((effs.reduce((a, b) => a + b, 0) / effs.length).toFixed(4)) : null,
    };
  }).sort((a, b) => b.count - a.count || a.suggestion_tag.localeCompare(b.suggestion_tag));
}

export function aggregate(events = []) {
  const usage = events.filter((e) => e && typeof e.tool === "string");
  const distill = events.filter((e) => e && typeof e.task_category === "string");

  // topTools / topMcps
  const topTools = rankDesc(countBy(usage, (e) => e.tool), "tool");
  const topMcps  = rankDesc(countBy(usage.filter((e) => e.mcp), (e) => e.mcp), "mcp");

  // errorRates: per tool calls/errors/rate (error = ok === false)
  const byTool = new Map();
  for (const e of usage) {
    const t = byTool.get(e.tool) || { tool: e.tool, calls: 0, errors: 0 };
    t.calls++;
    if (e.ok === false) t.errors++;
    byTool.set(e.tool, t);
  }
  const errorRates = [...byTool.values()]
    .map((t) => ({ ...t, rate: t.calls ? Number((t.errors / t.calls).toFixed(4)) : 0 }))
    .sort((a, b) => b.rate - a.rate || b.calls - a.calls);

  const sequences = buildSequences(usage);
  const callsPerTask = buildCallsPerTask(distill);
  const toolsPerTaskCategory = buildToolsPerTaskCategory(usage, distill);
  const backlog = buildBacklog(distill);

  return { topTools, topMcps, errorRates, sequences, callsPerTask, backlog, toolsPerTaskCategory };
}

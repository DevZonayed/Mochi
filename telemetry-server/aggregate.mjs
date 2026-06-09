// telemetry-server/aggregate.mjs
// Pure JS aggregation over Zone-A events. Powers /v1/summary and /dashboard.
// All counts are UNTRUSTED lower-confidence signal (§13.5) — surfaced with a
// lowConfidence flag where volume is thin.
const LOW_CONFIDENCE_THRESHOLD = 5;
function isDistill(e) { return e && e.kind === "distill"; }
function rank(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function aggregate(events) {
  const evs = Array.isArray(events) ? events : [];
  const usage = evs.filter((e) => e && !isDistill(e) && typeof e.tool === "string");
  const distills = evs.filter(isDistill);

  const toolCounts = new Map();
  const mcpCounts = new Map();
  const errBuckets = new Map();
  const seqCounts = new Map();
  const toolsByTask = new Map();
  const bySession = new Map();

  for (const e of usage) {
    toolCounts.set(e.tool, (toolCounts.get(e.tool) || 0) + 1);
    if (e.mcp) mcpCounts.set(e.mcp, (mcpCounts.get(e.mcp) || 0) + 1);
    const b = errBuckets.get(e.tool) || { total: 0, fail: 0 };
    b.total++; if (e.ok === false) b.fail++;
    errBuckets.set(e.tool, b);
    if (typeof e.task_category === "string") {
      if (!toolsByTask.has(e.task_category)) toolsByTask.set(e.task_category, new Map());
      const tm = toolsByTask.get(e.task_category);
      tm.set(e.tool, (tm.get(e.tool) || 0) + 1);
    }
    const sid = e.sid ?? "_";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ tool: e.tool, ts: e.ts || 0 });
  }

  for (const stream of bySession.values()) {
    stream.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < stream.length; i++) {
      const key = stream[i - 1].tool + " " + stream[i].tool;
      seqCounts.set(key, (seqCounts.get(key) || 0) + 1);
    }
  }

  const taskAgg = new Map();
  const sugAgg = new Map();
  for (const d of distills) {
    const tc = d.task_category ?? "other";
    const ta = taskAgg.get(tc) || { count: 0, sumCalls: 0 };
    ta.count++; ta.sumCalls += Number(d.tool_calls) || 0;
    taskAgg.set(tc, ta);
    const tag = d.suggestion_tag ?? "other";
    const sa = sugAgg.get(tag) || { count: 0, redundancy: new Map() };
    sa.count++;
    if (d.redundancy_pattern) sa.redundancy.set(d.redundancy_pattern, (sa.redundancy.get(d.redundancy_pattern) || 0) + 1);
    sugAgg.set(tag, sa);
  }

  return {
    topTools: rank(toolCounts),
    topMcps: rank(mcpCounts),
    errorRates: [...errBuckets.entries()]
      .map(([tool, b]) => ({ tool, total: b.total, fail: b.fail, rate: b.total ? b.fail / b.total : 0 }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total),
    sequences: [...seqCounts.entries()]
      .map(([k, count]) => { const [from, to] = k.split(" "); return { from, to, count }; })
      .sort((a, b) => b.count - a.count),
    callsPerTask: [...taskAgg.entries()]
      .map(([task_category, t]) => ({ task_category, count: t.count, avgCalls: t.count ? t.sumCalls / t.count : 0 }))
      .sort((a, b) => b.count - a.count),
    toolsPerTaskCategory: [...toolsByTask.entries()]
      .map(([task_category, tm]) => ({ task_category, tools: rank(tm) }))
      .sort((a, b) => b.tools.reduce((s, x) => s + x.count, 0) - a.tools.reduce((s, x) => s + x.count, 0)),
    backlog: [...sugAgg.entries()]
      .map(([suggestion_tag, s]) => ({
        suggestion_tag, count: s.count,
        topRedundancy: rank(s.redundancy)[0]?.name ?? null,
        lowConfidence: s.count < LOW_CONFIDENCE_THRESHOLD,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

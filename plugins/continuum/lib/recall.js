// Backward-traversal retrieval over the continuum chain.
//
// Strategy (Phase 2):
//   1. Cheap pass over chain/index.jsonl (one JSON-per-line, append-only).
//      Score = tag hit * 3 + keyword-in-summary hit * 1 + recency tiebreak.
//   2. For each top-N candidate, load chain/links/NNNN/summary.md.
//   3. Also surface refs.json keys (semantic anchors) so the agent can fetch
//      detail from the archived transcript or commit on its own.
//   4. Archived (rolled-up) links live under chain/links/_archived/ and have
//      tombstone entries in index.jsonl with {tombstone:true}. We still scan
//      them and return matches — recall is supposed to survive rollups.
//
// Output is a structured JSON object so this same helper backs both the
// /continuum:recall slash command and the mcp__continuum__recall MCP tool.

import fs from "node:fs";
import path from "node:path";
import { loadIndex, linkPath, readLinkSummary } from "./paths.js";

// Lightweight stemming. Real Porter would conflate more aggressively but adds
// ~150 lines; this handles the most common English plural/tense suffixes well
// enough for "decisions / decision / decided / deciding" to share a root.
// Embedding-based semantic recall is deferred — see README Phase-3 notes.
function stem(t) {
  if (!t) return t;
  t = t.toLowerCase();
  if (t.length < 4) return t;
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ied") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
  if (t.endsWith("ed")  && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("es")  && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s")   && t.length > 4 && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

function tokenize(s) {
  if (!s) return [];
  return s.toLowerCase().split(/[^a-z0-9_+-]+/).filter((t) => t.length >= 2);
}

function tokenizeStemmed(s) {
  return tokenize(s).map(stem);
}

// Count occurrences of each query stem in the document stems (term frequency).
function termFrequency(docStems, queryStems) {
  const counts = new Map();
  for (const q of queryStems) counts.set(q, 0);
  for (const d of docStems) {
    if (counts.has(d)) counts.set(d, counts.get(d) + 1);
  }
  return counts;
}

function readRefs(projectDir, id, archived) {
  const f = path.join(linkPath(projectDir, id, archived), "refs.json");
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; }
}

function readMeta(projectDir, id, archived) {
  const f = path.join(linkPath(projectDir, id, archived), "meta.json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

// Staleness signal: memory is point-in-time. A recalled claim that is >45 days
// old should be re-verified against current code/live state before it's stated
// as fact. ageDays is whole days since the link's ts (null ts -> 0, not stale).
const STALE_AFTER_DAYS = 45;
function ageInfo(ts) {
  if (!ts) return { ageDays: 0, stale: false };
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return { ageDays: 0, stale: false };
  const ageDays = Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
  return { ageDays, stale: ageDays > STALE_AFTER_DAYS };
}

export function recall({
  projectDir,
  query,
  limit = 5,
  tags = null,           // array — if provided, restrict to entries whose tags overlap
  includeArchived = true,
}) {
  if (!projectDir) throw new Error("recall: projectDir required");
  if (!query || !query.trim()) throw new Error("recall: query required");

  const queryTokens = tokenize(query);
  const queryStems = queryTokens.map(stem);
  const queryStemSet = new Set(queryStems);

  const index = loadIndex(projectDir);
  const scored = [];

  for (const entry of index) {
    if (!includeArchived && entry.archived) continue;

    const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
    const tagsLower = entryTags.map((t) => String(t).toLowerCase());
    const tagsStemmed = tagsLower.map(stem);

    if (tags && Array.isArray(tags) && tags.length > 0) {
      const want = new Set(tags.map((t) => stem(String(t).toLowerCase())));
      const overlap = tagsStemmed.some((t) => want.has(t));
      if (!overlap) continue;
    }

    // Tag hits: stemmed compare, +3 per hit (high signal — tags are curated).
    let score = 0;
    let matchedTags = [];
    for (let i = 0; i < tagsStemmed.length; i++) {
      if (queryStemSet.has(tagsStemmed[i])) { score += 3; matchedTags.push(tagsLower[i]); }
    }

    // Summary keyword hits: TF-scaled by log(1 + freq) so "really about this"
    // links rank above one-off mentions, but not by enough to drown out tag hits.
    const summary = readLinkSummary(projectDir, entry.id, !!entry.archived);
    const summaryStems = tokenizeStemmed(summary || "");
    const tf = termFrequency(summaryStems, queryStems);
    let matchedKeywords = [];
    for (const qt of queryStems) {
      const count = tf.get(qt) || 0;
      if (count > 0) { score += Math.log(1 + count); matchedKeywords.push(qt); }
    }

    if (score === 0) continue;

    const { ageDays, stale } = ageInfo(entry.ts);

    scored.push({
      id: entry.id,
      ts: entry.ts || null,
      commit: entry.commit || null,
      tags: entryTags,
      archived: !!entry.archived,
      supersededBy: entry.supersededBy ?? null,
      score,
      ageDays,
      stale,
      matchedTags,
      matchedKeywords,
      summary: summary || "(summary file missing)",
      refs: readRefs(projectDir, entry.id, !!entry.archived),
      meta: readMeta(projectDir, entry.id, !!entry.archived),
    });
  }

  // Sort: score desc, recency desc (ts string compare works for ISO-8601)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.ts).localeCompare(String(a.ts));
  });

  return {
    query,
    queryTokens,
    totalScanned: index.length,
    hitCount: scored.length,
    hits: scored.slice(0, limit),
  };
}

export function formatRecallForHuman(result) {
  const lines = [];
  lines.push(`# Recall: "${result.query}"`);
  lines.push("");
  lines.push(`_Memory is point-in-time. Any recalled claim that affects a decision must be re-verified against current code/live state before you state it as fact._`);
  lines.push("");
  lines.push(`Scanned ${result.totalScanned} link${result.totalScanned === 1 ? "" : "s"} · ${result.hitCount} match${result.hitCount === 1 ? "" : "es"} · showing ${result.hits.length}`);
  lines.push("");
  if (result.hits.length === 0) {
    lines.push("_(no matches — try broader terms or check tags via `/continuum:status`)_");
    return lines.join("\n");
  }
  for (const h of result.hits) {
    const idStr = String(h.id).padStart(4, "0");
    const archived = h.archived ? " _(archived)_" : "";
    const tagStr = h.tags.length ? ` [${h.tags.join(", ")}]` : "";
    lines.push(`## Link ${idStr}${archived} — score ${h.score} · ${h.ts ?? "?"}${tagStr}`);
    if (h.matchedTags.length) lines.push(`_matched tags:_ ${h.matchedTags.join(", ")}`);
    if (h.matchedKeywords.length) lines.push(`_matched keywords:_ ${h.matchedKeywords.join(", ")}`);
    if (h.commit) lines.push(`_commit:_ \`${String(h.commit).slice(0, 12)}\``);
    if (h.stale) lines.push(`_⚠ ${h.ageDays}d old — re-verify against current code/live state before asserting as fact._`);
    lines.push("");
    lines.push(h.summary.trim());
    const refKeys = Object.keys(h.refs);
    if (refKeys.length) {
      lines.push("");
      lines.push(`_anchors:_ ${refKeys.map((k) => `\`${k}\` → ${JSON.stringify(h.refs[k])}`).join(" · ")}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

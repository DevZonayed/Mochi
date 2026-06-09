// Mochi Comment Mode — store merge (shared by the content script and tests).
//
// `mochiComments` is written by TWO independent writers: the Comment-Mode
// content script (human) and the background bridge (agent QA). Whole-document
// last-write-wins silently drops one writer's comments whenever their writes
// overlap. These helpers replace that with a deterministic id-based UNION so
// neither side can clobber the other.
//
// Strategy:
//   - Sessions are unioned by id. A session present in both is field-merged.
//   - Comments within a session are unioned by id; a comment present in both is
//     resolved by `updatedAt` (every mutation bumps it), so edits/resolves win
//     deterministically without losing additions.
//   - canonStore() serializes a store in a stable order so two equal unions
//     produce identical JSON — lets the caller detect "did I contribute extra?"
//     without ping-ponging writes between tabs.
//
// Note: deletions are NOT tombstoned (YAGNI). A delete that races a concurrent
// write to the SAME comment id can resurrect it; the human can just delete
// again. Lost ADDITIONS — the real data-loss the union prevents — never happen.
(function (g) {
  function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : d; }

  function mergeComment(a, b) {
    const at = num(a && a.updatedAt, 0) || num(a && a.createdAt, 0);
    const bt = num(b && b.updatedAt, 0) || num(b && b.createdAt, 0);
    return bt >= at ? b : a;   // whole-comment last-write at comment granularity
  }

  function mergeSession(a, b) {
    a = a || {}; b = b || {};
    const newer = num(b.updatedAt, 0) >= num(a.updatedAt, 0) ? b : a;
    const older = newer === b ? a : b;
    const byId = new Map();
    for (const c of (a.comments || [])) if (c && c.id != null) byId.set(c.id, c);
    for (const c of (b.comments || [])) {
      if (!c || c.id == null) continue;
      const prev = byId.get(c.id);
      byId.set(c.id, prev ? mergeComment(prev, c) : c);
    }
    const createdAt = Math.min(
      num(a.createdAt, Infinity), num(b.createdAt, Infinity)
    );
    return {
      id: newer.id || older.id,
      name: newer.name || older.name,
      origin: newer.origin || older.origin,
      createdAt: Number.isFinite(createdAt) ? createdAt : num(newer.createdAt, 0),
      updatedAt: Math.max(num(a.updatedAt, 0), num(b.updatedAt, 0)),
      comments: [...byId.values()],
    };
  }

  // Deterministic union of two store documents. Neither input is mutated.
  function mergeStores(a, b) {
    a = a || {}; b = b || {};
    const out = {
      v: 2,
      taughtScroll: !!(a.taughtScroll || b.taughtScroll),
      activeByOrigin: {},
      pending: b.pending || a.pending || null,
      sessions: {},
    };
    const abo = { ...(a.activeByOrigin || {}), ...(b.activeByOrigin || {}) };
    for (const k of Object.keys(abo).sort()) out.activeByOrigin[k] = abo[k];
    const sa = a.sessions || {}, sb = b.sessions || {};
    const ids = new Set([...Object.keys(sa), ...Object.keys(sb)]);
    for (const id of [...ids].sort()) {
      if (sa[id] && sb[id]) out.sessions[id] = mergeSession(sa[id], sb[id]);
      else out.sessions[id] = sa[id] || sb[id];
    }
    return out;
  }

  // Stable serialization: sorted session ids, sorted activeByOrigin keys, and
  // comments ordered by (n, id). Used to compare two stores for semantic
  // equality independent of insertion order.
  function canonStore(s) {
    s = s || {};
    const abo = {};
    for (const k of Object.keys(s.activeByOrigin || {}).sort()) abo[k] = s.activeByOrigin[k];
    const sessions = {};
    for (const id of Object.keys(s.sessions || {}).sort()) {
      const ss = s.sessions[id] || {};
      const comments = [...(ss.comments || [])].sort(
        (x, y) => (num(x.n, 0) - num(y.n, 0)) || String(x.id).localeCompare(String(y.id))
      );
      sessions[id] = {
        id: ss.id, name: ss.name, origin: ss.origin,
        createdAt: num(ss.createdAt, 0), updatedAt: num(ss.updatedAt, 0), comments,
      };
    }
    return JSON.stringify({
      v: 2, taughtScroll: !!s.taughtScroll, activeByOrigin: abo,
      pending: s.pending || null, sessions,
    });
  }

  const api = { mergeStores, mergeSession, mergeComment, canonStore };
  g.MochiCommentMerge = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

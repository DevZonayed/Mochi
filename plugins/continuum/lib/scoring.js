// Shared stemmed-token scoring primitives.
//
// Extracted verbatim from recall.js so both continuum recall and comms recall
// score with the SAME stemmer/tokenizer. Changing logic here changes recall's
// behavior — keep it identical to the original recall.js definitions.
//
// Lightweight stemming. Real Porter would conflate more aggressively but adds
// ~150 lines; this handles the most common English plural/tense suffixes well
// enough for "decisions / decision / decided / deciding" to share a root.

export function stem(t) {
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

export function tokenize(s) {
  if (!s) return [];
  return s.toLowerCase().split(/[^a-z0-9_+-]+/).filter((t) => t.length >= 2);
}

export function tokenizeStemmed(s) {
  return tokenize(s).map(stem);
}

// Count occurrences of each query stem in the document stems (term frequency).
export function termFrequency(docStems, queryStems) {
  const counts = new Map();
  for (const q of queryStems) counts.set(q, 0);
  for (const d of docStems) {
    if (counts.has(d)) counts.set(d, counts.get(d) + 1);
  }
  return counts;
}

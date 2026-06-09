// Unit test for the Comment-Mode store merge (extension/comment-merge.js).
//
// This is the heart of the background↔content data-loss fix: the background
// bridge (agent QA) and the content script (human) are independent writers of
// the same `mochiComments` document. Whole-document last-write-wins silently
// dropped one side's comments; the id-based union must never lose an addition in
// either direction, must converge (no cross-tab ping-pong), and must let a
// resolve/edit win by updatedAt.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
// Load comment-merge.js exactly as the extension does — as a browser-global
// script — so the test exercises the real `globalThis.MochiCommentMerge` path.
const code = fs.readFileSync(new URL("../extension/comment-merge.js", import.meta.url), "utf8");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { mergeStores, canonStore, mergeComment } = sandbox.MochiCommentMerge;
assert.equal(typeof mergeStores, "function", "comment-merge.js must expose mergeStores on globalThis");

const O = "https://app.test";
function comment(id, n, extra = {}) {
  return { id, sessionId: "s1", n, text: "c" + n, route: "/", origin: O, selector: "#x" + n, createdAt: 1000, updatedAt: 1000, ...extra };
}
function store(comments, extra = {}) {
  return {
    v: 2, taughtScroll: false, activeByOrigin: { [O]: "s1" }, pending: null,
    sessions: { s1: { id: "s1", name: "QA", origin: O, createdAt: 1000, updatedAt: 1000, comments } },
    ...extra,
  };
}
function ids(s) {
  return new Set(Object.values(s.sessions).flatMap((x) => x.comments.map((c) => c.id)));
}

// 1) Union keeps both sides' comments (no loss either direction).
{
  const human = store([comment("c-human", 1)]);
  const agent = store([comment("c-agent", 1)]);   // bridge snapshot that predated the human's add
  const merged = mergeStores(human, agent);
  assert.deepEqual([...ids(merged)].sort(), ["c-agent", "c-human"], "union must contain both comments");
}

// 2) Scenario A — background clobbered the human, content recovers it.
// storage now holds only the agent's comment (nv); the human's in-memory store
// still has theirs. Merging local∪nv restores both, and because the union has
// data nv lacks, canonStore differs → caller re-saves.
{
  const localHuman = store([comment("c-human", 1)]);
  const nvAgentOnly = store([comment("c-agent", 1)]);
  const merged = mergeStores(localHuman, nvAgentOnly);
  assert.equal(Object.values(merged.sessions)[0].comments.length, 2, "both comments survive");
  assert.notEqual(canonStore(merged), canonStore(nvAgentOnly), "local contributed → must re-save");
}

// 3) Scenario B — content has a pending local edit, background write arrives.
{
  const localPending = store([comment("c-human", 1), comment("c-human2", 2)]);
  const nvAgent = store([comment("c-agent", 1)]);
  const merged = mergeStores(localPending, nvAgent);
  assert.deepEqual([...ids(merged)].sort(), ["c-agent", "c-human", "c-human2"]);
}

// 4) Convergence: once both sides hold the union, a re-merge is a no-op
// (canonStore equal) so there is no ping-pong of writes between tabs.
{
  const union = mergeStores(store([comment("a", 1)]), store([comment("b", 2)]));
  const remergedA = mergeStores(union, store([comment("a", 1)]));
  const remergedB = mergeStores(store([comment("b", 2)]), union);
  assert.equal(canonStore(remergedA), canonStore(union), "re-merge converges (A)");
  assert.equal(canonStore(remergedB), canonStore(union), "re-merge converges (B)");
  assert.equal(canonStore(remergedA), canonStore(remergedB), "both tabs reach identical canon");
}

// 5) A comment present in both is resolved by updatedAt (resolve/edit wins).
{
  const older = comment("c1", 1, { resolved: false, updatedAt: 1000 });
  const newer = comment("c1", 1, { resolved: true, text: "fixed", updatedAt: 2000 });
  assert.equal(mergeComment(older, newer).resolved, true, "newer (resolved) wins");
  assert.equal(mergeComment(newer, older).resolved, true, "order-independent: newer still wins");
  const merged = mergeStores(store([older]), store([newer]));
  const c = Object.values(merged.sessions)[0].comments.find((x) => x.id === "c1");
  assert.equal(c.resolved, true, "resolved state propagates through the union");
  assert.equal(Object.values(merged.sessions)[0].comments.length, 1, "no duplicate for same id");
}

// 6) canonStore is order-independent (same semantic store → identical string).
{
  const a = store([comment("a", 1), comment("b", 2)]);
  const b = store([comment("b", 2), comment("a", 1)]);
  b.activeByOrigin = { [O]: "s1" };
  assert.equal(canonStore(a), canonStore(b), "comment order must not change canon");
}

// 7) activeByOrigin: the incoming write wins per-origin, others preserved.
{
  const local = { ...store([]), activeByOrigin: { [O]: "s1", "https://other.test": "s9" } };
  const incoming = { ...store([]), activeByOrigin: { [O]: "s2" } };
  const merged = mergeStores(local, incoming);
  assert.equal(merged.activeByOrigin[O], "s2", "incoming origin selection wins");
  assert.equal(merged.activeByOrigin["https://other.test"], "s9", "other origins preserved");
}

// 8) Two different sessions on the same origin both survive (no clobber).
{
  const a = store([comment("ca", 1)], { sessions: { sa: { id: "sa", name: "Human", origin: O, createdAt: 1, updatedAt: 1, comments: [comment("ca", 1)] } } });
  const b = store([comment("cb", 1)], { sessions: { sb: { id: "sb", name: "QA", origin: O, createdAt: 1, updatedAt: 2, comments: [comment("cb", 1)] } } });
  const merged = mergeStores(a, b);
  assert.deepEqual(Object.keys(merged.sessions).sort(), ["sa", "sb"], "both sessions kept");
}

console.log("comment-merge: all assertions passed");

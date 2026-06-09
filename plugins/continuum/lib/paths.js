import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export const DIR_NAME = ".continuum";

export function continuumRoot(projectDir) {
  return path.join(projectDir, DIR_NAME);
}

export function paths(projectDir) {
  const root = continuumRoot(projectDir);
  return {
    root,
    stateMd: path.join(root, "STATE.md"),
    chainDir: path.join(root, "chain"),
    indexJsonl: path.join(root, "chain", "index.jsonl"),
    linksDir: path.join(root, "chain", "links"),
    archiveDir: path.join(root, "archive", "transcripts"),
    feedbackDir: path.join(root, "feedback", "pending"),
    screenshotsDir: path.join(root, "screenshots"),
    configJson: path.join(root, "config.json"),
    sessionIdFile: path.join(root, ".session-id"),
  };
}

export function isBootstrapped(projectDir) {
  const p = paths(projectDir);
  if (!fs.existsSync(p.indexJsonl)) return false;
  try {
    const stat = fs.statSync(p.indexJsonl);
    return stat.size > 0;
  } catch {
    return false;
  }
}

// loadIndex: returns ALL non-tombstone entries with an `archived` field
// annotated based on whether a later tombstone entry supersedes them.
//
// Tombstone entries look like: {tombstone: true, id: <N>, supersededBy: <digestId>, ts}
// They are APPENDED by /continuum:dream — never mutate originals (PRD §4: links immutable).
export function loadIndex(projectDir) {
  const p = paths(projectDir);
  if (!fs.existsSync(p.indexJsonl)) return [];
  const lines = fs.readFileSync(p.indexJsonl, "utf8").split("\n").filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tombstoned = new Map(); // id -> supersededBy
  for (const e of entries) {
    if (e.tombstone === true && e.id != null) {
      tombstoned.set(e.id, e.supersededBy ?? null);
    }
  }
  return entries
    .filter((e) => e.tombstone !== true)
    .map((e) => ({
      ...e,
      archived: tombstoned.has(e.id),
      supersededBy: tombstoned.get(e.id) ?? null,
    }));
}

// Active (non-archived) entries only.
export function loadActiveIndex(projectDir) {
  return loadIndex(projectDir).filter((e) => !e.archived);
}

export function readIndexTail(projectDir, n) {
  return loadActiveIndex(projectDir).slice(-n);
}

export function linkPath(projectDir, linkId, archived = false) {
  const p = paths(projectDir);
  const idStr = String(linkId).padStart(4, "0");
  return archived ? path.join(p.linksDir, "_archived", idStr) : path.join(p.linksDir, idStr);
}

export function readLinkSummary(projectDir, linkId, archived = false) {
  const file = path.join(linkPath(projectDir, linkId, archived), "summary.md");
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

export function readStateMd(projectDir) {
  const p = paths(projectDir);
  if (!fs.existsSync(p.stateMd)) return null;
  return fs.readFileSync(p.stateMd, "utf8");
}

export function readConfig(projectDir) {
  const p = paths(projectDir);
  const defaults = {
    dir_name: DIR_NAME,
    inject_token_cap: 4000,
    state_md_line_cap: 150,
    link_summary_token_cap: 800,
    newest_links_to_load: 2,
    soft_context_threshold_pct: 60,
    rollup_every_n_links: 25,
    frontend_verify: false,
    frontend_globs: ["src/**/*.{tsx,jsx,vue,svelte,css}"],
    frontend_breakpoints_px: [375, 768, 1280],
    feedback_to_git_issues: false,
  };
  if (!fs.existsSync(p.configJson)) return defaults;
  try {
    const user = JSON.parse(fs.readFileSync(p.configJson, "utf8"));
    return { ...defaults, ...user };
  } catch {
    return defaults;
  }
}

// Cheap heuristic, not a real tokenizer. Good enough for budget enforcement.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Comms (per-repo communication-channel sync) path helpers. All persistence
// lives under .continuum/comms/ (resolved per spec §3.1 from an explicit
// projectDir — never process.cwd()). config.json is COMMITTED; everything
// else under comms/ is gitignored (auth, store, state, watermark, local cfg).
// ---------------------------------------------------------------------------
export function commsDir(projectDir) {
  return path.join(continuumRoot(projectDir), "comms");
}
export function commsConfigPath(projectDir) {
  return path.join(commsDir(projectDir), "config.json");
}
export function commsLocalConfigPath(projectDir) {
  return path.join(commsDir(projectDir), "config.local.json");
}
export function commsStatePath(projectDir) {
  return path.join(commsDir(projectDir), "state.json");
}
export function commsSeenPath(projectDir) {
  return path.join(commsDir(projectDir), ".last-session-seen.json");
}
export function commsIndexPath(projectDir) {
  return path.join(commsDir(projectDir), "index.jsonl");
}
export function commsAuthDir(projectDir, provider, accountId) {
  return path.join(commsDir(projectDir), provider, accountId, "auth");
}
// commsChatDir resolves the per-chat store directory. SECURITY: `chatId` is the
// only segment that can come from untrusted/remote input (a JID off the wire),
// so it is sanitized here as defense-in-depth — a chatId is always a single path
// segment, never a sub-path. Any value containing a path separator ('/' or '\')
// or a parent-dir token ('..') is rejected so a crafted chatId can never escape
// the store root via path.join. Legitimate JIDs ("c@g.us",
// "12345@s.whatsapp.net") have none of these and are unaffected.
function assertSafeChatSegment(chatId) {
  if (typeof chatId !== "string" || chatId.length === 0) {
    throw new Error(`commsChatDir: invalid chatId: ${JSON.stringify(chatId)}`);
  }
  if (chatId.includes("/") || chatId.includes("\\") || chatId.includes("..")) {
    throw new Error(`commsChatDir: unsafe chatId (path traversal): ${JSON.stringify(chatId)}`);
  }
}
export function commsChatDir(projectDir, provider, accountId, chatId) {
  assertSafeChatSegment(chatId);
  const storeRoot = path.join(commsDir(projectDir), "store", provider, accountId);
  const result = path.join(storeRoot, chatId);
  // Belt-and-suspenders: the resolved dir MUST stay under the per-account store
  // root. (The segment check above already guarantees this; this assert makes the
  // invariant explicit and future-proofs it against any new sanitizer gaps.)
  if (path.resolve(result) !== path.join(path.resolve(storeRoot), chatId)) {
    throw new Error(`commsChatDir: resolved path escapes store root: ${result}`);
  }
  return result;
}
export function commsMessagesPath(projectDir, provider, accountId, chatId) {
  return path.join(commsChatDir(projectDir, provider, accountId, chatId), "messages.jsonl");
}
export function commsCursorPath(projectDir, provider, accountId, chatId) {
  return path.join(commsChatDir(projectDir, provider, accountId, chatId), "cursor.json");
}
export function commsMetaPath(projectDir, provider, accountId, chatId) {
  return path.join(commsChatDir(projectDir, provider, accountId, chatId), "meta.json");
}

// ---------------------------------------------------------------------------
// Telemetry (Mochi Insight) path helpers. Everything Zone-A/Zone-B lives under
// .continuum/telemetry/ and is GITIGNORED (per-user/per-machine, not a repo
// artifact). The anonymous install-id is machine-scoped, so it lives OUTSIDE
// the repo at ~/.mochi/install-id (NO PII, rotates — see install_id.js).
// ---------------------------------------------------------------------------
export function telemetryDir(projectDir) {
  return path.join(continuumRoot(projectDir), "telemetry");
}
export function telemetryEventsPath(projectDir) {
  return path.join(telemetryDir(projectDir), "events.jsonl");
}
// config.json holds the per-user consent decision — GITIGNORED (not committed).
export function telemetryConfigPath(projectDir) {
  return path.join(telemetryDir(projectDir), "config.json");
}
// queue.jsonl holds unsent batches awaiting the next flush (capped).
export function telemetryQueuePath(projectDir) {
  return path.join(telemetryDir(projectDir), "queue.jsonl");
}
// flush-watermark.json persists the last-successfully-flushed line offset so
// that consecutive flush() calls only POST genuinely new events (no duplicates).
export function telemetryWatermarkPath(projectDir) {
  return path.join(telemetryDir(projectDir), "flush-watermark.json");
}
// reviews/ holds Zone-B critiques (full suggestion_text) — NEVER auto-sent.
export function telemetryReviewsDir(projectDir) {
  return path.join(telemetryDir(projectDir), "reviews");
}
// installIdPath is home-scoped, NOT project-scoped: one anonymous id per
// machine/user. `homeDir` is injectable for tests; defaults to os.homedir().
export function installIdPath(homeDir) {
  return path.join(homeDir || os.homedir(), ".mochi", "install-id");
}

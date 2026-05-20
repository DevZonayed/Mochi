// server/src/playbooks.js
// Per-feature markdown playbooks under .continuum/playbooks/.
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

const PLAYBOOK_SCHEMA_VERSION = 1;

function projectDir() {
  return process.env.MOCHI_PROJECT_DIR || process.cwd();
}

export function playbooksDir() {
  return path.join(projectDir(), ".continuum", "playbooks");
}

function indexPath() { return path.join(playbooksDir(), "index.json"); }
function inboxDir()  { return path.join(playbooksDir(), "inbox"); }

export async function initPlaybooks() {
  await fs.mkdir(playbooksDir(), { recursive: true });
  await fs.mkdir(path.join(playbooksDir(), "_generic"), { recursive: true });
  await fs.mkdir(inboxDir(), { recursive: true });
  try { await fs.access(indexPath()); }
  catch { await fs.writeFile(indexPath(), JSON.stringify({ version: 1, playbooks: [] }, null, 2)); }
}

const SECTION_HEADINGS = [
  ["summary",         "## Summary"],
  ["preconditions",   "## Preconditions"],
  ["steps",           "## Steps"],
  ["verification",    "## Verification"],
  ["selectors_used",  "## Selectors used"],
  ["recent_runs",     "## Recent runs"],
  ["screenshots",     "## Screenshots"],
];

export function parsePlaybook(md) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) throw new Error("playbook-validation-failed: missing frontmatter");
  const rawFront = m[1];
  const meta = yaml.load(rawFront);
  const body = m[2];
  const sections = {};
  const indexes = SECTION_HEADINGS.map(([key, heading]) => ({ key, heading, pos: body.indexOf(heading) }));
  indexes.sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < indexes.length; i++) {
    const cur = indexes[i];
    if (cur.pos < 0) { sections[cur.key] = parseSection(cur.key, ""); continue; }
    const next = indexes.slice(i + 1).find((x) => x.pos > cur.pos);
    const startsAt = cur.pos + cur.heading.length;
    const endsAt = next ? next.pos : body.length;
    const raw = body.slice(startsAt, endsAt).trim();
    sections[cur.key] = parseSection(cur.key, raw);
  }
  // _rawFront caches the original frontmatter text so round-trips that don't
  // mutate `meta` stay byte-identical with the source.
  return { meta, body, sections, _rawFront: rawFront };
}

function parseSection(key, raw) {
  if (key === "selectors_used") {
    const out = [];
    for (const line of raw.split("\n")) {
      const m = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
      if (m && m[1] && m[1] !== "intent" && !m[1].startsWith("-")) {
        out.push({ intent: m[1].trim(), selector: m[2].trim() });
      }
    }
    return out;
  }
  return raw;
}

export function serializePlaybook({ meta, body, _rawFront }) {
  // If the caller has a cached raw frontmatter and the deep-equal'd meta still
  // matches what that raw text decodes to, prefer the raw text so round-trips
  // stay byte-identical (preserves comments, flow style, key order).
  if (_rawFront) {
    try {
      const parsedFromRaw = yaml.load(_rawFront);
      if (deepEqual(parsedFromRaw, meta)) return `---\n${_rawFront}\n---\n${body}`;
    } catch { /* fall through */ }
  }
  const front = yaml.dump(meta, { lineWidth: 200, sortKeys: false }).trim();
  return `---\n${front}\n---\n${body}`;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === "string") return a.toISOString() === new Date(b).toISOString();
  if (b instanceof Date && typeof a === "string") return b.toISOString() === new Date(a).toISOString();
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

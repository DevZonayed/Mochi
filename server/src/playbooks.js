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

const VALID_INPUT_TYPES = new Set([
  "text", "email", "url", "markdown", "password",
  "file", "file[]", "image", "image[]",
  "secret", "enum", "int", "bool",
]);

const REQUIRED_SECTIONS = ["summary", "preconditions", "steps", "verification", "selectors_used", "recent_runs", "screenshots"];

export function playbookErr(code, message, details) {
  const e = new Error(`${code}: ${message}`);
  e.playbookError = { code, message, details };
  return e;
}

export function validatePlaybook({ meta, body }) {
  const issues = [];
  if (!meta || typeof meta !== "object") {
    issues.push("frontmatter missing or origin missing");
    return { code: "playbook-validation-failed", details: { issues } };
  }
  if (!meta.origin || typeof meta.origin !== "string")  issues.push("origin: missing or not a string");
  else if (!/^[a-z0-9.-]+$/.test(meta.origin) && meta.origin !== "_generic") issues.push(`origin: invalid format "${meta.origin}"`);
  if (!meta.feature || typeof meta.feature !== "string") issues.push("feature: missing or not a string");
  else if (!/^[a-z0-9-]+$/.test(meta.feature))           issues.push(`feature: must be kebab-case [a-z0-9-]+, got "${meta.feature}"`);
  else if (meta.feature.length > 40)                     issues.push("feature: max 40 chars");

  for (const input of meta.inputs ?? []) {
    if (!input.name || !/^[a-zA-Z_$][\w$]*$/.test(input.name)) issues.push(`inputs[].name: invalid identifier "${input.name}"`);
    if (!input.type || !VALID_INPUT_TYPES.has(input.type))     issues.push(`inputs[].type: must be one of ${[...VALID_INPUT_TYPES].join(",")}, got "${input.type}"`);
  }
  if (meta.cron && typeof meta.cron === "string" && !isValidCron(meta.cron)) {
    issues.push(`cron: invalid cron expression "${meta.cron}"`);
  }

  // body section presence
  if (typeof body === "string") {
    for (const sec of REQUIRED_SECTIONS) {
      const heading = "## " + sec.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Selectors Used/, "Selectors used").replace(/Recent Runs/, "Recent runs");
      if (!body.includes(heading)) issues.push(`section missing: ${heading}`);
    }
  }
  return issues.length ? { code: "playbook-validation-failed", details: { issues } } : null;
}

function isValidCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*,/-]+$/.test(p));
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

// ---------------- CRUD ----------------

function pathFor(id, ext = ".md") {
  const [origin, feature] = id.split("/");
  return path.join(playbooksDir(), origin, feature + ext);
}

let writeMutex = Promise.resolve();
async function withMutex(fn) {
  const prev = writeMutex;
  let release;
  writeMutex = new Promise((r) => { release = r; });
  try { await prev; return await fn(); }
  finally { release(); }
}

async function atomicWrite(p, content) {
  const tmp = p + ".tmp." + process.pid + "." + Date.now();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, p);
}

export async function savePlaybook({ id, meta, body, workflow }) {
  await initPlaybooks();
  if (!id || !id.includes("/")) throw playbookErr("playbook-id-invalid", "id must be <origin>/<feature>", { id });
  // Validate the playbook itself first — if the feature/origin slug is malformed,
  // emit playbook-validation-failed (clearer than an id-mismatch).
  const err = validatePlaybook({ meta, body });
  if (err) throw playbookErr(err.code, "playbook failed validation", err.details);
  if (meta.origin + "/" + meta.feature !== id) {
    throw playbookErr("playbook-id-mismatch", "id does not match meta.origin/meta.feature", { id, expected: meta.origin + "/" + meta.feature });
  }

  const md = serializePlaybook({ meta, body });
  await withMutex(async () => {
    await atomicWrite(pathFor(id, ".md"), md);
    if (workflow) await atomicWrite(pathFor(id, ".workflow.json"), JSON.stringify(workflow, null, 2));
    await rebuildIndex();
  });
  return { ok: true, path: pathFor(id, ".md") };
}

export async function getPlaybook(id) {
  try {
    const md = await fs.readFile(pathFor(id, ".md"), "utf8");
    const parsed = parsePlaybook(md);
    let workflow = null;
    try { workflow = JSON.parse(await fs.readFile(pathFor(id, ".workflow.json"), "utf8")); }
    catch {}
    return { id, ...parsed, workflow };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function listPlaybooks({ origin, feature, tag, verifiable } = {}) {
  await initPlaybooks();
  const raw = JSON.parse(await fs.readFile(indexPath(), "utf8"));
  return raw.playbooks.filter((p) => {
    if (origin && p.origin !== origin) return false;
    if (feature && p.feature !== feature) return false;
    if (tag && !(p.tags || []).includes(tag)) return false;
    if (verifiable !== undefined && p.verifiable !== verifiable) return false;
    return true;
  });
}

export async function deletePlaybook(id) {
  await withMutex(async () => {
    try { await fs.unlink(pathFor(id, ".md")); } catch {}
    try { await fs.unlink(pathFor(id, ".workflow.json")); } catch {}
    try { await fs.rm(pathFor(id, ".screenshots"), { recursive: true, force: true }); } catch {}
    await rebuildIndex();
  });
  return { ok: true };
}

export async function rebuildIndex() {
  await initPlaybooks();
  const entries = [];
  const origins = await fs.readdir(playbooksDir());
  for (const origin of origins) {
    if (origin === "inbox" || origin === "index.json" || origin.startsWith(".")) continue;
    const originPath = path.join(playbooksDir(), origin);
    let st; try { st = await fs.stat(originPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const files = await fs.readdir(originPath);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const md = await fs.readFile(path.join(originPath, f), "utf8").catch(() => null);
      if (!md) continue;
      let parsed; try { parsed = parsePlaybook(md); } catch { continue; }
      const m = parsed.meta;
      entries.push({
        id: `${m.origin}/${m.feature}`,
        origin: m.origin,
        feature: m.feature,
        title: m.title || m.feature,
        verifiable: !!m.verifiable,
        inputs: (m.inputs || []).map((x) => x.name),
        success_count: m.success_count || 0,
        last_verified: m.last_verified || null,
        tags: m.tags || [],
      });
    }
  }
  await atomicWrite(indexPath(), JSON.stringify({ version: 1, playbooks: entries }, null, 2));
  return { entries: entries.length };
}

// ---------------- matchPlaybook ----------------

const MATCH_THRESHOLD = 30;

export async function matchPlaybook({ url, intent, taskText } = {}) {
  const entries = await listPlaybooks({});
  const u = url ? safeUrl(url) : null;
  const text = (taskText || "").toLowerCase();
  const stems = tokenize(text);
  const results = [];
  for (const e of entries) {
    let score = 0;
    const reasons = [];
    if (u && e.origin === u.hostname) { score += 50; reasons.push("origin-match"); }
    if (taskText) {
      const featStems = tokenize(e.feature.replace(/-/g, " "));
      const overlap = featStems.filter((t) => stems.includes(t)).length;
      if (overlap) { score += overlap * 10; reasons.push(`feature-token-overlap:${overlap}`); }
      const titleStems = tokenize(e.title || "");
      const tOverlap = titleStems.filter((t) => stems.includes(t)).length;
      if (tOverlap) { score += tOverlap * 5; reasons.push(`title-token-overlap:${tOverlap}`); }
      // Origin hostname token match (e.g. "twitter" in "twitter.com" vs "post on twitter").
      const origStems = tokenize(e.origin.replace(/[.-]/g, " "));
      const oOverlap = origStems.filter((t) => stems.includes(t)).length;
      if (oOverlap) { score += oOverlap * 10; reasons.push(`origin-token-overlap:${oOverlap}`); }
      for (const tag of e.tags || []) {
        if (stems.includes(tag.toLowerCase())) { score += 10; reasons.push(`tag-match:${tag}`); }
      }
    }
    if (intent && e.feature.includes(intent)) { score += 15; reasons.push("intent-match"); }
    if (score >= MATCH_THRESHOLD) results.push({ playbookId: e.id, score, reason: reasons.join(", ") });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

function safeUrl(s) { try { return new URL(s); } catch { return null; } }
function tokenize(s) {
  return (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}
const STOPWORDS = new Set(["the","and","for","with","from","that","this","into","onto","when","then","than","but","not","you"]);

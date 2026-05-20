// server/src/playbooks.js
// Per-feature markdown playbooks under .continuum/playbooks/.
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import * as secrets from "./secrets.js";
import { diffStep } from "./visual-diff.js";

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
  else if (!/^[a-z0-9.:-]+$/.test(meta.origin) && meta.origin !== "_generic") issues.push(`origin: invalid format "${meta.origin}"`);
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

// ---------------- promoteFromTrace ----------------

const TOOL_TO_ACTION = {
  browser_navigate:   "navigate",
  browser_click:      "click",
  browser_click_at:   "click",
  browser_type:       "type",
  browser_press_key:  "press_key",
  browser_scroll:     "scroll",
  browser_wait:       "wait",
  browser_assert:     "assert",
  browser_upload_file:"upload",
};

export async function promoteFromTrace({ label, title, verifiable = false, trace, screenshots = [], explicitInputs, explicitOutputs, inputs, outputs }) {
  if (!Array.isArray(trace) || !trace.length) throw playbookErr("playbook-validation-failed", "trace empty");
  const firstNav = trace.find((t) => t.tool === "browser_navigate" && t.args?.url);
  if (!firstNav) throw playbookErr("playbook-validation-failed", "trace has no navigate step — cannot infer origin");
  const origin = new URL(firstNav.args.url).hostname;
  const feature = (label || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!feature) throw playbookErr("playbook-validation-failed", "label required to derive feature slug");
  const id = `${origin}/${feature}`;

  const steps = [];
  for (const call of trace) {
    const action = TOOL_TO_ACTION[call.tool];
    if (!action) continue;
    const step = { action };
    if (action === "navigate") step.url = call.args.url;
    if (action === "click" || action === "type" || action === "upload") {
      if (call.args.intent) step.intent = call.args.intent;
      else if (call.args.selector) step.selector = call.args.selector;
    }
    if (action === "type" && call.args.value !== undefined) step.valueRef = inferValueRef(call.args.intent, call.args.value);
    if (action === "upload" && call.args.files) step.filesRef = "input.attachments";
    if (action === "press_key") step.key = call.args.key;
    if (action === "scroll")    step.params = call.args;
    if (action === "wait")      step.ms = call.args.ms ?? 500;
    if (action === "assert") { step.kind = call.args.kind; step.value = call.args.value; step.timeoutMs = call.args.timeoutMs; }
    steps.push(step);
  }

  // v1.5: scrub any literal step value that matches a known env-var secret.
  const env = process.env;
  const knownSecrets = {};
  for (const k of Object.keys(env)) {
    if (/PASSWORD|TOKEN|SECRET|KEY|API/i.test(k) && env[k]) knownSecrets[k] = env[k];
  }
  const secretLiteralSet = new Set(Object.values(knownSecrets));
  for (const step of steps) {
    if (step.valueRef && step.valueRef.startsWith("input.")) continue;
    if (typeof step.value === "string" && secretLiteralSet.has(step.value)) {
      step.value = "[REDACTED]";
    }
  }

  const finalInputs = explicitInputs || inputs || inferInputs(steps);
  const finalOutputs = explicitOutputs || outputs || [];

  const meta = {
    origin, feature,
    title: title || `${feature.replace(/-/g, " ")} on ${origin}`,
    verifiable,
    preconditions: [],
    inputs: finalInputs,
    outputs: finalOutputs,
    composes: [],
    next: null,
    cron: null,
    last_verified: new Date().toISOString(),
    success_count: 1,
    playbook_version: 1,
    schema_version: 1,
    tags: [],
  };

  const existing = await getPlaybook(id);
  let body;
  if (existing) {
    meta.success_count = (existing.meta.success_count || 0) + 1;
    meta.last_verified = new Date().toISOString();
    body = updateBodyForRerun(existing.body, steps);
  } else {
    body = freshBody(steps);
  }

  const workflow = { playbookId: id, schemaVersion: 1, steps };
  await savePlaybook({ id, meta, body, workflow });
  return {
    ok: true,
    playbookId: id,
    created: !existing,
    diffSummary: existing ? summarizeDiff(existing.workflow?.steps || [], steps) : "created",
    path: pathFor(id, ".md"),
  };
}

function inferValueRef(intent, value) {
  if (!intent) return "input.value";
  // Map common authentication slugs to canonical input names.
  if (intent.includes("password") || intent.includes("secret")) return "input.password";
  if (intent.includes("username") || intent.includes("user"))   return "input.username";
  if (intent.includes("email"))    return "input.email";
  const base = intent.replace(/-field$|-input$|-button$/g, "").replace(/[^a-z0-9]+/gi, "_");
  return `input.${base || "value"}`;
}

function inferInputs(steps) {
  const seen = new Map();
  for (const s of steps) {
    if (s.valueRef && s.valueRef.startsWith("input.")) {
      const name = s.valueRef.slice("input.".length);
      if (!seen.has(name)) {
        const isSecret = /password|token|secret|key/i.test(name);
        seen.set(name, { name, type: isSecret ? "secret" : "text", required: true });
      }
    }
    if (s.filesRef === "input.attachments" && !seen.has("attachments")) {
      seen.set("attachments", { name: "attachments", type: "file[]", required: false });
    }
  }
  return [...seen.values()];
}

function freshBody(steps) {
  return [
    "## Summary",
    "Auto-generated playbook from successful trace.",
    "",
    "## Preconditions",
    "(none recorded)",
    "",
    "## Steps",
    ...steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
    "",
    "## Verification",
    "Steps completed without throwing.",
    "",
    "## Selectors used",
    "",
    "| intent | selector |",
    "|---|---|",
    "",
    "## Recent runs",
    "",
    `- promoted-${new Date().toISOString()} — first capture, ${steps.length} steps`,
    "",
    "## Screenshots",
    "",
    "- (none yet)",
    "",
  ].join("\n");
}

function updateBodyForRerun(prevBody, newSteps) {
  // append a new "Recent runs" entry; keep last 20
  const lines = prevBody.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("## Recent runs"));
  if (startIdx < 0) return freshBody(newSteps);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith("## "));
  const before = lines.slice(0, startIdx + 1);
  const after = endIdx > 0 ? lines.slice(endIdx) : [""];
  const prevRuns = lines.slice(startIdx + 1, endIdx > 0 ? endIdx : lines.length).filter((l) => l.trim().startsWith("-"));
  const newRun = `- promoted-${new Date().toISOString()} — ${newSteps.length} steps`;
  const trimmed = [newRun, ...prevRuns].slice(0, 20);
  return [...before, "", ...trimmed, "", ...after].join("\n");
}

function describeStep(s) {
  switch (s.action) {
    case "navigate":  return `Navigate to \`${s.url}\``;
    case "click":     return `Click intent \`${s.intent || s.selector}\``;
    case "type":      return `Type \`${s.valueRef}\` into intent \`${s.intent || s.selector}\``;
    case "press_key": return `Press \`${s.key}\``;
    case "scroll":    return `Scroll \`${JSON.stringify(s.params)}\``;
    case "wait":      return `Wait ${s.ms} ms`;
    case "upload":    return `Upload \`${s.filesRef}\` via intent \`${s.intent || s.selector}\``;
    case "assert":    return `Assert ${s.kind} = \`${s.value}\``;
    default:          return JSON.stringify(s);
  }
}

function summarizeDiff(prevSteps, newSteps) {
  const added = newSteps.length - prevSteps.length;
  if (added > 0) return `added ${added} step(s)`;
  if (added < 0) return `removed ${Math.abs(added)} step(s)`;
  return "updated existing steps";
}

// ---------------- composeResolve ----------------

export async function composeResolve(playbookId, inputs, _stack = new Set()) {
  if (_stack.has(playbookId)) {
    throw playbookErr("playbook-compose-cycle", "cycle detected", { path: [..._stack, playbookId] });
  }
  const pb = await getPlaybook(playbookId);
  if (!pb) throw playbookErr("playbook-not-found", `no playbook ${playbookId}`);
  for (const inSpec of pb.meta.inputs || []) {
    if (inSpec.required && (inputs[inSpec.name] === undefined || inputs[inSpec.name] === null)) {
      throw playbookErr("playbook-input-missing", `${playbookId} requires input "${inSpec.name}"`, { playbookId, missing: inSpec.name });
    }
  }
  const legs = [{ playbookId, inputs, meta: pb.meta, workflow: pb.workflow }];
  const newStack = new Set([..._stack, playbookId]);
  for (const c of pb.meta.composes || []) {
    const mappedInputs = mapInputs(c.inputs || {}, inputs);
    const sub = await composeResolve(c.id, mappedInputs, newStack);
    legs.push(...sub.legs);
  }
  return { legs };
}

function mapInputs(spec, parentInputs) {
  const out = {};
  for (const [k, v] of Object.entries(spec || {})) {
    if (typeof v === "string") {
      out[k] = v.replace(/\$\{input\.([\w$]+)\}/g, (_, name) => parentInputs[name] ?? "");
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------- v1.5: secrets + visual diff helpers ----------------

export async function resolveRunInputs(playbookId, callerInputs) {
  const pb = await getPlaybook(playbookId);
  if (!pb) throw playbookErr("playbook-not-found", `no playbook ${playbookId}`);
  await secrets.initSecrets();
  const { resolved, missing } = secrets.resolveInputs(pb, callerInputs);
  if (missing.length) {
    throw playbookErr("playbook-input-missing", `required secrets unavailable: ${missing.map((m) => m.name).join(", ")}`, { missing });
  }
  return { resolved, secretValues: extractSecretValues(pb, resolved) };
}

function extractSecretValues(pb, resolved) {
  const out = {};
  for (const spec of pb.meta?.inputs || []) {
    if (spec.type === "secret" && typeof resolved[spec.name] === "string") out[spec.name] = resolved[spec.name];
  }
  return out;
}

export function scrubInputsForLog(inputs, secretValues) {
  const out = {};
  const valueToName = {};
  for (const [k, v] of Object.entries(secretValues || {})) {
    if (typeof v === "string" && v.length) valueToName[v] = k;
  }
  for (const [k, v] of Object.entries(inputs || {})) {
    if (typeof v === "string" && valueToName[v]) out[k] = `[REDACTED:${valueToName[v]}]`;
    else out[k] = v;
  }
  return out;
}

export async function compareStepScreenshot({ playbookId, stepIndex, actualPath, warnThreshold, failThreshold }) {
  const pb = await getPlaybook(playbookId);
  if (!pb) return { verdict: "match", reason: "no-playbook" };
  const refs = pb.meta.visual_refs || [];
  const entry = refs.find((r) => r.step === stepIndex);
  if (!entry) return { verdict: "match", reason: "no-reference" };
  const originDir = path.join(playbooksDir(), pb.meta.origin);
  const refPath = path.join(originDir, entry.path);
  return diffStep({
    actualPath, refPath,
    warnThreshold: warnThreshold ?? pb.meta.visual_diff?.warn_threshold ?? 0.05,
    failThreshold: failThreshold ?? pb.meta.visual_diff?.fail_threshold ?? 0.20,
  });
}

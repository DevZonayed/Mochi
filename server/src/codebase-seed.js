// server/src/codebase-seed.js
// Static analyzer over project frontends → draft playbooks.
import fs from "node:fs/promises";
import path from "node:path";
import { parse as babelParse } from "@babel/parser";
import _traverse from "@babel/traverse";
import { savePlaybook, getPlaybook } from "./playbooks.js";

const traverse = _traverse.default || _traverse;

export async function detectFramework(root) {
  const has = async (p) => { try { await fs.access(path.join(root, p)); return true; } catch { return false; } };
  // Nuxt: check before Next.js (some projects have both? unlikely, but be specific).
  const hasNuxtConfig = (await has("nuxt.config.js")) || (await has("nuxt.config.mjs")) || (await has("nuxt.config.ts"));
  if (hasNuxtConfig) return { kind: "nuxt", pagesDir: "pages" };
  // SvelteKit
  const hasSvelteConfig = (await has("svelte.config.js")) || (await has("svelte.config.mjs")) || (await has("svelte.config.ts"));
  if (hasSvelteConfig) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (pkg.devDependencies?.["@sveltejs/kit"] || pkg.dependencies?.["@sveltejs/kit"]) return { kind: "sveltekit", routesDir: "src/routes" };
    } catch {}
  }
  // Next.js
  const hasNextConfig = (await has("next.config.js")) || (await has("next.config.mjs")) || (await has("next.config.ts"));
  if (hasNextConfig) {
    if (await has("app")) return { kind: "next-app-router", appDir: "app" };
    if (await has("pages")) return { kind: "next-pages-router", pagesDir: "pages" };
  }
  if ((await has("vite.config.js")) || (await has("vite.config.ts"))) return { kind: "vite-react", srcDir: "src" };
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.dependencies?.["react-scripts"]) return { kind: "cra", srcDir: "src" };
  } catch {}
  return { kind: "none" };
}

export async function seedFromCodebase({ projectRoot, domain, dryRun = false } = {}) {
  const root = projectRoot || process.env.MOCHI_PROJECT_DIR || process.cwd();
  if (!domain) throw new Error("seed-domain-missing: pass a `domain` (e.g. 'app.localhost:3000')");
  const fw = await detectFramework(root);
  if (fw.kind === "none") return { ok: true, framework: "none", drafts: [], written: 0, skipped: 0, warnings: ["no frontend framework detected"] };

  const drafts = [];
  if (fw.kind === "next-app-router")    drafts.push(...await scanNextAppRouter(root, fw.appDir, domain));
  if (fw.kind === "next-pages-router")  drafts.push(...await scanNextPagesRouter(root, fw.pagesDir, domain));
  if (fw.kind === "vite-react" || fw.kind === "cra") drafts.push(...await scanReactSrc(root, fw.srcDir, domain));
  if (fw.kind === "nuxt")               drafts.push(...await scanNuxtPages(root, fw.pagesDir, domain));
  if (fw.kind === "sveltekit")          drafts.push(...await scanSvelteKit(root, fw.routesDir, domain));

  if (dryRun) return { ok: true, framework: fw.kind, drafts: draftsMeta(drafts), written: 0, skipped: 0, warnings: [] };

  let written = 0, skipped = 0;
  const warnings = [];
  for (const d of drafts) {
    const existing = await getPlaybook(d.id);
    if (existing && (existing.meta?.playbook_version || 0) > 0) {
      skipped++;
      warnings.push(`skipped ${d.id}: non-draft playbook already exists (playbook_version=${existing.meta.playbook_version})`);
      continue;
    }
    await savePlaybook({ id: d.id, meta: d.meta, body: d.body, workflow: d.workflow });
    written++;
  }
  return { ok: true, framework: fw.kind, drafts: draftsMeta(drafts), written, skipped, warnings };
}

function draftsMeta(drafts) {
  return drafts.map((d) => ({ id: d.id, source: d.source, inputs: d.meta.inputs.length, steps: d.workflow.steps.length }));
}

async function scanNextAppRouter(root, appDir, domain) {
  const out = [];
  const base = path.join(root, appDir);
  async function walk(dir, route = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith("(") || e.name.startsWith("_")) { await walk(p, route); continue; } // route groups
        const seg = e.name.startsWith("[") ? "" : e.name; // dynamic segments stripped
        await walk(p, route + (seg ? "/" + seg : ""));
        continue;
      }
      if (e.isFile() && /^page\.(tsx|jsx|ts|js)$/.test(e.name)) {
        const draft = await buildDraftFromFile(p, route || "/", domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}

async function scanNextPagesRouter(root, pagesDir, domain) {
  const out = [];
  const base = path.join(root, pagesDir);
  async function walk(dir, route = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p, route + "/" + e.name); continue; }
      if (e.isFile() && /\.(tsx|jsx|ts|js)$/.test(e.name) && !e.name.startsWith("_")) {
        const seg = e.name.replace(/\.(tsx|jsx|ts|js)$/, "");
        const sub = seg === "index" ? "" : "/" + seg;
        const draft = await buildDraftFromFile(p, (route || "") + sub || "/", domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}

async function scanReactSrc(root, srcDir, domain) {
  const out = [];
  const base = path.join(root, srcDir);
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /\.(tsx|jsx)$/.test(e.name)) {
        const fakeRoute = "/" + e.name.replace(/\.(tsx|jsx)$/, "").replace(/Page$/, "").toLowerCase();
        const draft = await buildDraftFromFile(p, fakeRoute, domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}

async function buildDraftFromFile(filePath, route, domain) {
  let source;
  try { source = await fs.readFile(filePath, "utf8"); }
  catch { return null; }
  let ast;
  try { ast = babelParse(source, { sourceType: "module", plugins: ["jsx", "typescript"] }); }
  catch (e) { return null; }
  const fields = [];
  let hasForm = false;
  let submitButton = null;
  traverse(ast, {
    JSXOpeningElement(p) {
      const name = nodeName(p.node.name);
      if (name === "form" || /Form$/.test(name)) hasForm = true;
      if (name === "input" || name === "textarea" || name === "select") {
        fields.push(extractField(p.node, name));
      }
      if (name === "button") {
        const type = attrValue(p.node, "type");
        if (type === "submit" || !submitButton) submitButton = { ...extractField(p.node, "button") };
      }
    },
  });
  if (!hasForm && !fields.length) return null;

  const feature = slugFromRoute(route);
  const id = `${domain}/${feature}`;
  const inputs = uniqueInputs(fields.map(fieldToInput));
  const steps = stepsFromFields(route, fields, submitButton);
  const meta = {
    origin: domain,
    feature,
    title: `${humanize(feature)} (draft)`,
    verifiable: false,
    preconditions: [],
    inputs,
    outputs: [],
    composes: [],
    next: null,
    cron: null,
    last_verified: null,
    success_count: 0,
    playbook_version: 0,
    schema_version: 1,
    tags: ["draft", "seeded"],
  };
  const body = freshBody({ route, source: filePath, fields, submitButton, steps });
  return {
    id,
    source: path.relative(process.env.MOCHI_PROJECT_DIR || process.cwd(), filePath),
    meta,
    body,
    workflow: { playbookId: id, schemaVersion: 1, steps },
  };
}

function nodeName(n) {
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return nodeName(n.property);
  return "";
}
function attrValue(opening, attr) {
  for (const a of opening.attributes || []) {
    if (a.type === "JSXAttribute" && a.name?.name === attr) {
      if (a.value?.type === "StringLiteral")   return a.value.value;
      if (a.value?.type === "Literal")         return a.value.value;
      if (a.value?.type === "JSXExpressionContainer") {
        const e = a.value.expression;
        if (e?.type === "StringLiteral") return e.value;
      }
    }
  }
  return null;
}
function extractField(opening, tag) {
  return {
    tag,
    type: attrValue(opening, "type"),
    name: attrValue(opening, "name"),
    id:   attrValue(opening, "id"),
    aria: attrValue(opening, "aria-label"),
    testid: attrValue(opening, "data-testid"),
    placeholder: attrValue(opening, "placeholder"),
    accept: attrValue(opening, "accept"),
  };
}
function slugFromRoute(route) {
  return route.replace(/^\//, "").replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "index";
}
function humanize(s) { return s.split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" "); }
function fieldToInput(f) {
  const name = camelOrSnake(f.name || f.testid || f.aria || f.id || f.placeholder || f.tag);
  let type = "text";
  if (f.type === "email")    type = "email";
  if (f.type === "password") type = "secret";
  if (f.type === "url")      type = "url";
  if (f.type === "file") {
    const accept = (f.accept || "").toLowerCase();
    if (accept.includes("image")) type = "image";
    else type = "file";
  }
  return { name, type, required: true };
}
function camelOrSnake(s) {
  if (!s) return "value";
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
function uniqueInputs(arr) {
  const seen = new Map();
  for (const i of arr) if (!seen.has(i.name)) seen.set(i.name, i);
  return [...seen.values()];
}
function stepsFromFields(route, fields, submitButton) {
  const steps = [{ action: "navigate", url: `\${baseUrl}${route}` }];
  for (const f of fields) {
    const input = fieldToInput(f);
    const intent = (f.testid || f.aria || input.name) + "-field";
    steps.push({ action: "type", intent, valueRef: `input.${input.name}` });
  }
  if (submitButton) {
    const intent = (submitButton.testid || submitButton.aria || "submit") + "-button";
    steps.push({ action: "click", intent });
  }
  return steps;
}
function freshBody({ route, source, fields, submitButton, steps }) {
  return [
    "## Summary",
    `Draft playbook generated from \`${path.basename(source)}\` for route \`${route}\`. Run it once to verify selectors + outcome, then bump \`playbook_version\` from 0 to 1.`,
    "",
    "## Preconditions",
    "(none recorded; add manually)",
    "",
    "## Steps",
    ...steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
    "",
    "## Verification",
    "Add explicit success criterion (e.g., 'Redirects to /dashboard' or 'Success toast appears').",
    "",
    "## Selectors used",
    "",
    "| intent | selector |",
    "|---|---|",
    ...fields.map((f) => {
      const intent = (f.testid || f.aria || f.name || "field") + "-field";
      const sel = f.testid ? `[data-testid=\"${f.testid}\"]` : f.id ? `#${f.id}` : `[name=\"${f.name}\"]`;
      return `| ${intent} | \`${sel}\` |`;
    }),
    submitButton ? `| ${(submitButton.testid || submitButton.aria || "submit") + "-button"} | \`${submitButton.testid ? `[data-testid="${submitButton.testid}"]` : "button[type=submit]"}\` |` : "",
    "",
    "## Recent runs",
    "",
    `- seeded-${new Date().toISOString()} — auto-generated draft, untested`,
    "",
    "## Screenshots",
    "",
    "- (none yet)",
    "",
  ].filter((l) => l !== "").join("\n");
}
function describeStep(s) {
  switch (s.action) {
    case "navigate":  return `Navigate to \`${s.url}\``;
    case "click":     return `Click intent \`${s.intent}\``;
    case "type":      return `Type \`${s.valueRef}\` into intent \`${s.intent}\``;
    default:          return JSON.stringify(s);
  }
}

async function scanNuxtPages(root, pagesDir, domain) {
  const out = [];
  const base = path.join(root, pagesDir);
  async function walk(dir, route = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const seg = e.name.startsWith("[") ? "" : e.name;
        await walk(p, route + (seg ? "/" + seg : ""));
        continue;
      }
      if (e.isFile() && e.name.endsWith(".vue")) {
        const seg = e.name.slice(0, -4);
        const sub = seg === "index" ? "" : "/" + seg;
        const draft = await buildDraftFromVueOrSvelte(p, (route || "") + sub || "/", domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}

async function scanSvelteKit(root, routesDir, domain) {
  const out = [];
  const base = path.join(root, routesDir);
  async function walk(dir, route = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith("(") || e.name.startsWith("_")) { await walk(p, route); continue; } // route groups
        const seg = e.name.startsWith("[") ? "" : e.name;
        await walk(p, route + (seg ? "/" + seg : ""));
        continue;
      }
      if (e.isFile() && e.name === "+page.svelte") {
        const draft = await buildDraftFromVueOrSvelte(p, route || "/", domain);
        if (draft) out.push(draft);
      }
    }
  }
  await walk(base);
  return out;
}

async function buildDraftFromVueOrSvelte(filePath, route, domain) {
  let source;
  try { source = await fs.readFile(filePath, "utf8"); }
  catch { return null; }

  // Extract template block: Vue (<template>) or Svelte (whole top-level HTML)
  let templateHtml;
  const m = /<template[^>]*>([\s\S]*?)<\/template>/.exec(source);
  if (m) templateHtml = m[1];
  else {
    // Svelte: strip out <script> and <style> blocks; the rest is the template
    templateHtml = source.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  }
  if (!templateHtml) return null;

  const tokens = tokenizeHtml(templateHtml);
  const fields = [];
  let hasForm = false;
  let submitButton = null;
  for (const tok of tokens) {
    if (tok.tag === "form") hasForm = true;
    if (tok.tag === "input" || tok.tag === "textarea" || tok.tag === "select") {
      fields.push(htmlAttrsToField(tok));
    }
    if (tok.tag === "button") {
      const type = tok.attrs.type;
      if (type === "submit" || !submitButton) submitButton = htmlAttrsToField(tok);
    }
  }
  if (!hasForm && !fields.length) return null;

  const feature = slugFromRoute(route);
  const id = `${domain}/${feature}`;
  const inputs = uniqueInputs(fields.map(fieldToInput));
  const steps = stepsFromFields(route, fields, submitButton);

  const meta = {
    origin: domain, feature, title: `${humanize(feature)} (draft)`, verifiable: false,
    preconditions: [], inputs, outputs: [], composes: [], next: null, cron: null,
    last_verified: null, success_count: 0, playbook_version: 0, schema_version: 1, tags: ["draft", "seeded"],
  };
  const body = freshBody({ route, source: filePath, fields, submitButton, steps });
  return {
    id, source: path.relative(process.env.MOCHI_PROJECT_DIR || process.cwd(), filePath),
    meta, body, workflow: { playbookId: id, schemaVersion: 1, steps },
  };
}

// Minimal HTML tokenizer — extracts opening tags + attributes only.
function tokenizeHtml(src) {
  const tokens = [];
  const re = /<(\w+)([^>]*)>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const attrsRaw = m[2];
    const attrs = {};
    const attrRe = /([\w@:.-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\{[^}]*\})|([^\s>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrsRaw))) {
      const name = am[1];
      const value = am[2] ?? am[3] ?? am[4] ?? am[5] ?? "";
      attrs[name.toLowerCase()] = value;
    }
    tokens.push({ tag, attrs });
  }
  return tokens;
}

function htmlAttrsToField(tok) {
  // Map Vue/Svelte bindings to React-equivalent shape.
  const a = tok.attrs;
  const fieldName =
    a.name ||
    (a["v-model"]?.replace(/[{}]/g, "")) ||
    (a["bind:value"]?.replace(/[{}]/g, "")) ||
    a.id ||
    null;
  return {
    tag: tok.tag,
    type: a.type ?? null,
    name: fieldName,
    id:   a.id ?? null,
    aria: a["aria-label"] ?? null,
    testid: a["data-testid"] ?? null,
    placeholder: a.placeholder ?? null,
    accept: a.accept ?? null,
  };
}

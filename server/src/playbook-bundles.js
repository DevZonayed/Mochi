// server/src/playbook-bundles.js
// Export/import per-feature playbooks as single-file JSON bundles.
import fs from "node:fs/promises";
import path from "node:path";
import { request as undiciRequest } from "undici";
import { playbooksDir, listPlaybooks, getPlaybook, savePlaybook, parsePlaybook } from "./playbooks.js";

const BUNDLE_SCHEMA = "mochi-playbook-bundle@1";
const VERSION = "0.4.0";

export async function exportBundle({ ids, origin, tag, outputPath, stripSecrets = true } = {}) {
  const entries = await listPlaybooks({ origin, tag });
  const subset = ids?.length ? entries.filter((e) => ids.includes(e.id)) : entries;
  const playbooks = [];
  for (const e of subset) {
    const pb = await getPlaybook(e.id);
    if (!pb) continue;
    let markdown = await fs.readFile(path.join(playbooksDir(), e.origin, `${e.feature}.md`), "utf8");
    if (stripSecrets) markdown = stripRefFromFrontmatter(markdown);
    const screenshots = await collectScreenshots(e.origin, e.feature);
    playbooks.push({
      id: e.id,
      markdown,
      workflow: pb.workflow || null,
      screenshots,
    });
  }
  const bundle = {
    schema: BUNDLE_SCHEMA,
    exportedAt: new Date().toISOString(),
    exportedBy: `mochi ${VERSION}`,
    manifest: playbooks.map((p) => ({
      id: p.id,
      version: parsePlaybook(p.markdown).meta.playbook_version,
      verifiable: !!parsePlaybook(p.markdown).meta.verifiable,
      tags: parsePlaybook(p.markdown).meta.tags || [],
    })),
    playbooks,
  };
  const finalPath = outputPath || path.join(playbooksDir(), "exports", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const json = JSON.stringify(bundle, null, 2);
  await fs.writeFile(finalPath, json);
  return { ok: true, bundlePath: finalPath, playbookCount: playbooks.length, sizeBytes: Buffer.byteLength(json) };
}

function stripRefFromFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return md;
  const frontmatter = m[1];
  const cleaned = frontmatter.split("\n").map((line) => line.replace(/^(\s+ref:).+$/, "$1 null")).join("\n");
  return md.replace(m[0], `---\n${cleaned}\n---\n`);
}

async function collectScreenshots(origin, feature) {
  const dir = path.join(playbooksDir(), origin, `${feature}.screenshots`);
  try {
    const files = await fs.readdir(dir);
    const out = {};
    for (const f of files) {
      if (!f.endsWith(".png")) continue;
      const buf = await fs.readFile(path.join(dir, f));
      out[f] = buf.toString("base64");
    }
    return out;
  } catch {
    return {};
  }
}

export async function importBundle({ bundlePath, bundleJson, url, overwrite = false, rewriteOrigin } = {}) {
  let raw;
  if (bundleJson) raw = bundleJson;
  else if (url) raw = await fetchUrl(url);
  else if (bundlePath) raw = await fs.readFile(bundlePath, "utf8");
  else throw new Error("bundle-validation-failed: provide bundlePath, bundleJson, or url");

  let bundle;
  try { bundle = JSON.parse(raw); }
  catch (e) { throw new Error("bundle-validation-failed: invalid JSON"); }
  if (bundle.schema !== BUNDLE_SCHEMA) throw new Error(`bundle-schema-mismatch: expected ${BUNDLE_SCHEMA}, got ${bundle.schema}`);
  if (!Array.isArray(bundle.playbooks)) throw new Error("bundle-validation-failed: playbooks missing");

  const imported = [];
  const skipped = [];
  let rewrittenFrom = null;
  for (const entry of bundle.playbooks) {
    let id = entry.id;
    let markdown = entry.markdown;
    if (rewriteOrigin) {
      const [oldOrigin, feature] = id.split("/");
      if (!rewrittenFrom) rewrittenFrom = oldOrigin;
      id = `${rewriteOrigin}/${feature}`;
      markdown = markdown.replace(new RegExp(`^origin:\\s*${oldOrigin}$`, "m"), `origin: ${rewriteOrigin}`);
    }
    const existing = await getPlaybook(id);
    if (existing && !overwrite) {
      skipped.push({ id, reason: "already-exists" });
      continue;
    }
    let parsed;
    try { parsed = parsePlaybook(markdown); }
    catch (e) { skipped.push({ id, reason: "bundle-playbook-validation-failed", details: String(e.message) }); continue; }
    await savePlaybook({ id, meta: parsed.meta, body: parsed.body, workflow: entry.workflow });
    if (entry.screenshots) {
      const [origin, feature] = id.split("/");
      const dir = path.join(playbooksDir(), origin, `${feature}.screenshots`);
      await fs.mkdir(dir, { recursive: true });
      for (const [name, b64] of Object.entries(entry.screenshots)) {
        await fs.writeFile(path.join(dir, name), Buffer.from(b64, "base64"));
      }
    }
    imported.push(id);
  }
  return { ok: true, imported, skipped, rewrittenFrom, rewrittenTo: rewriteOrigin || null };
}

async function fetchUrl(url) {
  if (!/^https?:\/\//.test(url)) throw new Error("bundle-fetch-failed: only http(s) URLs allowed");
  const { statusCode, body } = await undiciRequest(url, { method: "GET", bodyTimeout: 30_000 });
  if (statusCode < 200 || statusCode >= 300) throw new Error(`bundle-fetch-failed: HTTP ${statusCode}`);
  const chunks = []; for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

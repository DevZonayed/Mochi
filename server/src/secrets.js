// server/src/secrets.js
// Resolve typed-secret refs at run time. Never log values into traces or playbook bodies.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

function projectDir() { return process.env.MOCHI_PROJECT_DIR || process.cwd(); }
export function secretsDir() { return path.join(projectDir(), ".continuum", "secrets"); }

const REF_PATTERN = /^\$\{([^}]+)\}$/;

export class SecretError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.secretError = { code, message, details };
  }
}

export async function initSecrets() {
  await fs.mkdir(secretsDir(), { recursive: true });
  try {
    await fs.chmod(secretsDir(), 0o700);
  } catch (e) {
    if (process.platform !== "win32") console.warn("[secrets] could not chmod 0700:", e?.message);
  }
  const gi = path.join(secretsDir(), ".gitignore");
  try { await fs.access(gi); }
  catch { await fs.writeFile(gi, "*\n!.gitignore\n"); }
}

export function resolveRef(ref) {
  if (ref === null || ref === undefined) return null;
  if (typeof ref !== "string") throw new SecretError("secret-ref-syntax", "ref must be a string");
  const trimmed = ref.trim();
  const m = REF_PATTERN.exec(trimmed);
  if (!m) throw new SecretError("secret-ref-syntax", `not a single \${…} ref: "${ref}"`);
  const inner = m[1].trim();
  if (!inner) throw new SecretError("secret-ref-syntax", "empty ref");

  // ${env:NAME} or ${secret:NAME} or ${BARE_UPPERCASE}
  const colonIdx = inner.indexOf(":");
  if (colonIdx < 0) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(inner)) {
      return process.env[inner] ?? null;
    }
    // bare reserved-kind without a name is malformed (e.g. "${env}" / "${secret}")
    if (inner === "env" || inner === "secret") {
      throw new SecretError("secret-ref-syntax", `missing name in "${ref}"`);
    }
    // other bare lowercase strings aren't UPPER_SNAKE env shorthand → treat as unknown ref
    return null;
  }
  const kind = inner.slice(0, colonIdx).trim();
  const name = inner.slice(colonIdx + 1).trim();
  if (!name) throw new SecretError("secret-ref-syntax", `empty name in "${ref}"`);
  if (kind === "env") {
    return process.env[name] ?? null;
  }
  if (kind === "secret") {
    const p = path.join(secretsDir(), name + ".txt");
    try {
      const raw = fsSync.readFileSync(p, "utf8");
      return raw.replace(/\r?\n$/, "");
    } catch { return null; }
  }
  throw new SecretError("secret-ref-syntax", `unknown kind "${kind}"; want env or secret`);
}

export function resolveInputs(playbook, callerInputs = {}) {
  const inputs = playbook?.meta?.inputs || [];
  const resolved = { ...callerInputs };
  const missing = [];
  for (const spec of inputs) {
    if (resolved[spec.name] !== undefined && resolved[spec.name] !== null) continue;
    if (spec.ref) {
      const v = resolveRef(spec.ref);
      resolved[spec.name] = v;
      if (v === null && spec.required) missing.push({ name: spec.name, ref: spec.ref, source: refSource(spec.ref) });
    } else if (spec.required) {
      missing.push({ name: spec.name, ref: null, source: null });
    } else {
      resolved[spec.name] = null;
    }
  }
  return { resolved, missing };
}

function refSource(ref) {
  const m = REF_PATTERN.exec(ref.trim());
  if (!m) return null;
  const inner = m[1].trim();
  if (inner.startsWith("secret:")) return "file";
  return "env";
}

export function validatePlaybook(playbook) {
  const { missing } = resolveInputs(playbook, {});
  // For validation, we only care about required secrets specifically:
  const secretMissing = missing.filter((m) => {
    const spec = (playbook?.meta?.inputs || []).find((s) => s.name === m.name);
    return spec?.type === "secret" && spec?.required && spec?.ref;
  });
  return { ok: secretMissing.length === 0, missing: secretMissing };
}

export function scrubTrace(trace, resolvedSecrets) {
  const secretValues = new Set(
    Object.entries(resolvedSecrets || {})
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .map(([, v]) => v),
  );
  const nameByValue = {};
  for (const [name, v] of Object.entries(resolvedSecrets || {})) {
    if (typeof v === "string" && v.length > 0) nameByValue[v] = name;
  }
  return trace.map((call) => {
    if (!call?.args) return call;
    const args = { ...call.args };
    for (const k of Object.keys(args)) {
      if (typeof args[k] === "string" && secretValues.has(args[k])) {
        args[k] = `[REDACTED:${nameByValue[args[k]]}]`;
      }
    }
    return { ...call, args };
  });
}

export async function listAvailableSecrets() {
  const out = [];
  for (const [name] of Object.entries(process.env)) {
    if (/PASSWORD|TOKEN|SECRET|KEY|API/i.test(name)) out.push({ name, source: "env" });
  }
  try {
    const files = await fs.readdir(secretsDir());
    for (const f of files) {
      if (f.endsWith(".txt")) out.push({ name: f.slice(0, -4), source: "file" });
    }
  } catch {}
  return out;
}

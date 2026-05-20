// server/src/visual-diff.js
// PNG pixel-diff via pixelmatch. Per-step screenshot comparison for playbook replays.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export async function diffStep({ actualPath, refPath, warnThreshold = 0.05, failThreshold = 0.20 } = {}) {
  if (!actualPath || !refPath) throw new Error("diffStep requires actualPath and refPath");
  let actualBuf, refBuf;
  try { actualBuf = await fs.readFile(actualPath); }
  catch (e) { return { verdict: "fail", reason: "actual-missing", diff: 1, details: { actualPath } }; }
  try { refBuf = await fs.readFile(refPath); }
  catch (e) { return { verdict: "fail", reason: "ref-missing", diff: 1, details: { refPath } }; }

  const actual = PNG.sync.read(actualBuf);
  const ref    = PNG.sync.read(refBuf);
  if (actual.width !== ref.width || actual.height !== ref.height) {
    return { verdict: "fail", reason: "dimension-mismatch", diff: 1, details: { actual: { w: actual.width, h: actual.height }, ref: { w: ref.width, h: ref.height } } };
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const mismatched = pixelmatch(actual.data, ref.data, diff.data, actual.width, actual.height, { threshold: 0.1 });
  const ratio = mismatched / (actual.width * actual.height);
  let verdict = "match";
  let diffImagePath;
  if (ratio >= failThreshold) verdict = "fail";
  else if (ratio >= warnThreshold) verdict = "warn";
  if (verdict !== "match") {
    diffImagePath = actualPath.replace(/\.png$/i, "-diff.png");
    await fs.writeFile(diffImagePath, PNG.sync.write(diff));
  }
  return { verdict, diff: ratio, mismatchedPixels: mismatched, diffImagePath };
}

export function pngSha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function acceptStepShots({ runDir, refDir, steps } = {}) {
  await fs.mkdir(refDir, { recursive: true });
  const entries = await fs.readdir(runDir);
  const out = [];
  const wanted = steps && steps.length ? new Set(steps.map((n) => String(n).padStart(2, "0"))) : null;
  for (const f of entries) {
    const m = /^step-(\d+)\.png$/i.exec(f);
    if (!m) continue;
    const stepNum = m[1].padStart(2, "0");
    if (wanted && !wanted.has(stepNum) && !wanted.has(String(parseInt(stepNum, 10)))) continue;
    const fromPath = path.join(runDir, f);
    const toPath   = path.join(refDir, `step-${stepNum}.png`);
    const buf = await fs.readFile(fromPath);
    await fs.writeFile(toPath, buf);
    out.push({ step: parseInt(stepNum, 10), refPath: toPath, sha: pngSha(buf) });
  }
  return out;
}

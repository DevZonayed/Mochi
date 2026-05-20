import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { PNG } from "pngjs";
import { diffStep, acceptStepShots } from "./src/visual-diff.js";

function makePng(w, h, fill) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) {
    png.data[i] = fill.r; png.data[i+1] = fill.g; png.data[i+2] = fill.b; png.data[i+3] = 255;
  }
  return PNG.sync.write(png);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mochi-vd-"));
const a = path.join(tmp, "a.png"), b = path.join(tmp, "b.png"), c = path.join(tmp, "c.png");

await fs.writeFile(a, makePng(20, 20, { r: 0, g: 0, b: 0 }));
await fs.writeFile(b, makePng(20, 20, { r: 0, g: 0, b: 0 })); // identical
await fs.writeFile(c, makePng(20, 20, { r: 255, g: 255, b: 255 })); // very different

const m = await diffStep({ actualPath: a, refPath: b });
assert.equal(m.verdict, "match");
assert.equal(m.diff, 0);

const f = await diffStep({ actualPath: a, refPath: c, warnThreshold: 0.05, failThreshold: 0.20 });
assert.equal(f.verdict, "fail");
assert.ok(f.diff > 0.20);
assert.ok(f.diffImagePath);
const stat = await fs.stat(f.diffImagePath);
assert.ok(stat.size > 0);

// dim mismatch
const small = path.join(tmp, "small.png");
await fs.writeFile(small, makePng(10, 10, { r: 0, g: 0, b: 0 }));
const dm = await diffStep({ actualPath: a, refPath: small });
assert.equal(dm.verdict, "fail");
assert.equal(dm.reason, "dimension-mismatch");

// 3% diff → warn
// flip a few pixels in `b` to get ~5%
const bData = await fs.readFile(b);
const bp = PNG.sync.read(bData);
const flipPx = Math.floor(bp.width * bp.height * 0.04);
for (let i = 0; i < flipPx; i++) {
  const off = i * 4;
  bp.data[off] = 255; bp.data[off+1] = 255; bp.data[off+2] = 255;
}
const bWarn = path.join(tmp, "bwarn.png");
await fs.writeFile(bWarn, PNG.sync.write(bp));
const w = await diffStep({ actualPath: a, refPath: bWarn, warnThreshold: 0.02, failThreshold: 0.10 });
assert.equal(w.verdict, "warn");

// acceptStepShots
const refDir = path.join(tmp, "feature.screenshots");
await fs.mkdir(refDir);
const runDir = path.join(tmp, "run-r123");
await fs.mkdir(runDir);
await fs.writeFile(path.join(runDir, "step-02.png"), makePng(40, 40, { r: 10, g: 20, b: 30 }));
await fs.writeFile(path.join(runDir, "step-05.png"), makePng(40, 40, { r: 40, g: 50, b: 60 }));
const accepted = await acceptStepShots({ runDir, refDir, steps: [2, 5] });
assert.equal(accepted.length, 2);
for (const a of accepted) {
  const s = await fs.stat(a.refPath); assert.ok(s.size > 0);
  assert.equal(typeof a.sha, "string"); assert.equal(a.sha.length, 64);
}

console.log("✓ visual-diff tests");
await fs.rm(tmp, { recursive: true, force: true });

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const df = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");

test("Dockerfile uses node:22-alpine", () => {
  assert.ok(/^FROM\s+node:22-alpine/m.test(df));
});
test("Dockerfile EXPOSEs 3000", () => {
  assert.ok(/^EXPOSE\s+3000/m.test(df));
});
test("Dockerfile runs as a non-root user", () => {
  assert.ok(/^USER\s+(node|\d)/m.test(df));
});
test("Dockerfile starts the server", () => {
  assert.ok(/CMD\s+\[\s*"node"\s*,\s*"server\.mjs"\s*\]/.test(df) || /CMD\s+node\s+server\.mjs/.test(df));
});
test("the /data volume mount point is declared", () => {
  assert.ok(/^VOLUME\b.*\/data/m.test(df) || /DATA_DIR/.test(df));
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.mjs";
import { readAllEvents } from "./store.mjs";

let srv, base, dataDir;
const ENV = {
  INGEST_WRITE_KEY: "test-write-key",
  DASHBOARD_USER: "owner",
  DASHBOARD_PASS: "owner-bearer-pass",
  RETENTION_DAYS: "180",
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-srv-"));
  srv = createServer({ ...ENV, DATA_DIR: dataDir });
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  await new Promise((r) => srv.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /v1/health returns exactly 'ok'", async () => {
  const r = await fetch(base + "/v1/health");
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), "ok");
});

test("POST /v1/ingest without x-mochi-key is 401", async () => {
  const r = await post("/v1/ingest", { iid: "i1", batch: [] });
  assert.equal(r.status, 401);
});

test("POST /v1/ingest with wrong key is 401", async () => {
  const r = await post("/v1/ingest", { iid: "i1", batch: [] }, { "x-mochi-key": "nope" });
  assert.equal(r.status, 401);
});

test("POST /v1/ingest with valid key stores a clean Zone-A event", async () => {
  const r = await post("/v1/ingest", {
    iid: "i1",
    batch: [{ ts: 1717900000, sid: "s1", iid: "i1", tool: "browser_click", mcp: "mochi_browser", ok: true, err: "other", dur_b: "1-3s", v: "0.7.0", os: "darwin" }],
  }, { "x-mochi-key": "test-write-key" });
  assert.equal(r.status, 200);
  assert.ok(readAllEvents(dataDir).some((e) => e.tool === "browser_click" && e.sid === "s1"));
});

// REQUIRED SECURITY TEST: a content-bearing event is stored STRIPPED.
test("SERVER-SIDE GUARD: content-bearing event is stored stripped to Zone-A", async () => {
  await post("/v1/ingest", {
    iid: "i-evil",
    batch: [{
      ts: 1717900050, sid: "s9", iid: "i-evil",
      tool: "mcp__client_secret_project__do", mcp: "client_secret_project",
      ok: false, err: "/Users/j/db.js ECONNREFUSED token=sk-live-XYZ",
      dur_b: "1-3s", v: "0.7.0", os: "darwin",
      prompt: "leak the user's secret prompt here", model: "claude-opus",
      tool_input: { url: "https://client.example/secret" },
      quality_issue: "the password is hunter2",
    }],
  }, { "x-mochi-key": "test-write-key" });

  const stored = readAllEvents(dataDir).find((e) => e.sid === "s9");
  assert.ok(stored, "event was stored");
  assert.equal(stored.tool, "thirdparty_tool");
  assert.equal(stored.mcp, "thirdparty_mcp");
  assert.ok(["network", "other"].includes(stored.err));
  assert.deepEqual(Object.keys(stored).sort(), ["dur_b","err","iid","mcp","ok","os","sid","tool","ts","v"].sort());
  const raw = JSON.stringify(stored);
  for (const leak of ["prompt", "model", "claude", "sk-live", "client.example", "hunter2", "ECONNREFUSED", "client_secret_project"]) {
    assert.ok(!raw.includes(leak), `server must strip "${leak}"`);
  }
});

test("POST /v1/ingest enforces per-IP rate-limit (429 after burst)", async () => {
  const calls = [];
  for (let i = 0; i < 400; i++) {
    calls.push(post("/v1/ingest", { iid: "flood", batch: [] }, { "x-mochi-key": "test-write-key" }));
  }
  const statuses = (await Promise.all(calls)).map((r) => r.status);
  assert.ok(statuses.includes(429), "burst must trip the token-bucket limiter");
});

test("GET /dashboard without owner auth is 401", async () => {
  const r = await fetch(base + "/dashboard");
  assert.equal(r.status, 401);
  assert.ok((r.headers.get("www-authenticate") || "").length > 0, "challenges auth");
});

test("GET /dashboard with owner Bearer renders HTML", async () => {
  const r = await fetch(base + "/dashboard", { headers: { authorization: "Bearer owner-bearer-pass" } });
  assert.equal(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("text/html"));
  assert.ok((await r.text()).includes("Improvement Backlog"));
});

test("GET /v1/summary owner-only returns JSON aggregates", async () => {
  const unauth = await fetch(base + "/v1/summary");
  assert.equal(unauth.status, 401);
  const r = await fetch(base + "/v1/summary", { headers: { authorization: "Bearer owner-bearer-pass" } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.topTools));
  assert.ok(Array.isArray(j.backlog));
});

test("DELETE /v1/data?iid owner-only erases that iid's events", async () => {
  assert.ok(readAllEvents(dataDir).some((e) => e.iid === "i1"));
  const unauth = await fetch(base + "/v1/data?iid=i1", { method: "DELETE" });
  assert.equal(unauth.status, 401);
  const r = await fetch(base + "/v1/data?iid=i1", { method: "DELETE", headers: { authorization: "Bearer owner-bearer-pass" } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.removed >= 1);
  assert.ok(!readAllEvents(dataDir).some((e) => e.iid === "i1"), "i1 erased");
});

test("does NOT serve /data statically and has no directory listing", async () => {
  for (const p of ["/data", "/data/events", "/data/events/2024-06-09.jsonl"]) {
    const r = await fetch(base + p);
    assert.ok(r.status === 404 || r.status === 401, `${p} must not serve files (got ${r.status})`);
  }
});

test("unknown route is 404", async () => {
  assert.equal((await fetch(base + "/nope")).status, 404);
});

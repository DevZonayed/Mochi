// /Users/jonayedahamed/conductor/workspaces/Super-Tester/sydney/server/_comms_provider.test.mjs
import assert from "node:assert/strict";
import { CommsProvider, ProviderRegistry, NotImplemented } from "./src/comms/provider.js";

// 1) Base class: required methods throw NotImplemented; declared-but-v2 send* throw too.
{
  const p = new CommsProvider("dummy");
  assert.equal(p.name, "dummy");
  for (const m of ["link","status","unlink","listChats","listGroups","getMessages","onMessage","getSessionDir"]) {
    assert.throws(() => p[m]("acc"), NotImplemented, `${m} should be NotImplemented`);
  }
  assert.throws(() => p.sendText("a","b","c"), /v2/i);
  assert.throws(() => p.sendMedia("a","b",{}), /v2/i);
}

// 2) Registry: register a factory, get a per-(provider) singleton, list names.
{
  let made = 0;
  class Fake extends CommsProvider {
    constructor() { super("fake"); made++; }
    status() { return "logged_out"; }
  }
  const reg = new ProviderRegistry();
  reg.register("fake", (deps) => { assert.ok(deps && deps.projectDirFor); return new Fake(); });
  const a = reg.get("fake", { projectDirFor: () => "/tmp/x" });
  const b = reg.get("fake", { projectDirFor: () => "/tmp/x" });
  assert.equal(a, b, "registry must return a singleton per provider");
  assert.equal(made, 1);
  assert.equal(a.status(), "logged_out");
  assert.deepEqual(reg.names(), ["fake"]);
}

// 3) Registry: unknown provider throws a clear error.
{
  const reg = new ProviderRegistry();
  assert.throws(() => reg.get("nope", {}), /unknown provider: nope/);
}

console.log("✓ comms provider + registry");

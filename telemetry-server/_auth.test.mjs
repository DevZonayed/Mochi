import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr, checkWriteKey, checkOwner, TokenBucket } from "./auth.mjs";

test("timingSafeEqualStr matches equal strings, rejects unequal/length-mismatch", () => {
  assert.equal(timingSafeEqualStr("abc123", "abc123"), true);
  assert.equal(timingSafeEqualStr("abc123", "abc124"), false);
  assert.equal(timingSafeEqualStr("abc", "abc123"), false);
  assert.equal(timingSafeEqualStr("", "x"), false);
});

test("checkWriteKey requires exact x-mochi-key header (constant-time)", () => {
  assert.equal(checkWriteKey({ "x-mochi-key": "secret-key" }, "secret-key"), true);
  assert.equal(checkWriteKey({ "x-mochi-key": "wrong" }, "secret-key"), false);
  assert.equal(checkWriteKey({}, "secret-key"), false);
});

test("checkWriteKey rejects when server key is unset (fail-closed)", () => {
  assert.equal(checkWriteKey({ "x-mochi-key": "anything" }, ""), false);
  assert.equal(checkWriteKey({ "x-mochi-key": "anything" }, undefined), false);
});

test("checkOwner accepts a correct Bearer token (constant-time)", () => {
  const env = { DASHBOARD_PASS: "long-random-bearer", DASHBOARD_USER: "owner" };
  assert.equal(checkOwner({ authorization: "Bearer long-random-bearer" }, env), true);
  assert.equal(checkOwner({ authorization: "Bearer nope" }, env), false);
});

test("checkOwner accepts correct Basic auth, rejects wrong", () => {
  const env = { DASHBOARD_USER: "owner", DASHBOARD_PASS: "p@ss" };
  const ok = "Basic " + Buffer.from("owner:p@ss").toString("base64");
  const bad = "Basic " + Buffer.from("owner:WRONG").toString("base64");
  assert.equal(checkOwner({ authorization: ok }, env), true);
  assert.equal(checkOwner({ authorization: bad }, env), false);
  assert.equal(checkOwner({}, env), false);
});

test("checkOwner fails closed when creds unset", () => {
  assert.equal(checkOwner({ authorization: "Bearer x" }, {}), false);
});

test("TokenBucket allows up to capacity then blocks until refill", () => {
  let now = 0;
  const tb = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.equal(tb.take("ip1"), true);
  assert.equal(tb.take("ip1"), true);
  assert.equal(tb.take("ip1"), true);
  assert.equal(tb.take("ip1"), false);
  now = 1000;
  assert.equal(tb.take("ip1"), true);
});

test("TokenBucket is per-key (per-IP isolation)", () => {
  let now = 0;
  const tb = new TokenBucket({ capacity: 1, refillPerSec: 1, now: () => now });
  assert.equal(tb.take("ipA"), true);
  assert.equal(tb.take("ipA"), false);
  assert.equal(tb.take("ipB"), true);
});

test("global TokenBucket caps total ingest across all keys (§13.5)", () => {
  let now = 0;
  const global = new TokenBucket({ capacity: 2, refillPerSec: 0, now: () => now });
  assert.equal(global.take("*"), true);
  assert.equal(global.take("*"), true);
  assert.equal(global.take("*"), false);
});

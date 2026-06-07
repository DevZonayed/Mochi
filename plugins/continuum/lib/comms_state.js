import fs from "node:fs";
import path from "node:path";
import { commsDir, commsStatePath, commsSeenPath } from "./paths.js";

// Runtime state files the comms MCP writes and the fs-only init hook reads
// (spec §6.3):
//   state.json              { "<provider>": { "<accountId>": { status, updatedAt } } }
//   .last-session-seen.json { "<provider>/<accountId>/<chatId>": newestTs }
// status ∈ "connected" | "needs_login" | "logged_out".

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(dir, file, obj) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ── read side (hook uses these) ──────────────────────────────────────────────
export function readState(projectDir) {
  return readJsonSafe(commsStatePath(projectDir), {});
}

export function readSeen(projectDir) {
  return readJsonSafe(commsSeenPath(projectDir), {});
}

// Flatten state.json into [{provider, accountId, status, updatedAt}] for the
// hook's onboarding/freshness branches.
export function accountStatuses(state) {
  const out = [];
  for (const provider of Object.keys(state || {})) {
    const accounts = state[provider] || {};
    for (const accountId of Object.keys(accounts)) {
      const rec = accounts[accountId] || {};
      out.push({
        provider,
        accountId,
        status: rec.status ?? "needs_login",
        updatedAt: rec.updatedAt ?? null,
      });
    }
  }
  return out;
}

// ── write side (MCP/provider call these) ─────────────────────────────────────
export function setAccountStatus(projectDir, provider, accountId, status) {
  const state = readState(projectDir);
  if (!state[provider]) state[provider] = {};
  state[provider][accountId] = { status, updatedAt: Math.floor(Date.now() / 1000) };
  writeJsonAtomic(commsDir(projectDir), commsStatePath(projectDir), state);
  return state;
}

export function setSeen(projectDir, provider, accountId, chatId, newestTs) {
  const seen = readSeen(projectDir);
  seen[`${provider}/${accountId}/${chatId}`] = newestTs;
  writeJsonAtomic(commsDir(projectDir), commsSeenPath(projectDir), seen);
  return seen;
}

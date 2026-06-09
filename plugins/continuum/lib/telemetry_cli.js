#!/usr/bin/env node
// CLI shim for /mochi:telemetry. Subcommands: status | show | on | off |
// review-auto on|off | flush | reset-id | purge. All operate on an explicit
// --project-dir (never cwd for writes). `show` prints the IDENTICAL redacted
// payload that would POST (§13.1 N2) so the audit is byte-for-byte truthful.
import fs from "node:fs";
import { telemetryDir } from "./paths.js";
import { readConfig, writeConfig, isSharingEnabled, INGEST_URL } from "./telemetry_config.js";
import { readEvents } from "./telemetry_log.js";
import { redactEvent } from "./telemetry_redact.js";
import { aggregate } from "./telemetry_aggregate.js";
import { flush } from "./telemetry_emit.js";
import { getInstallId, resetInstallId } from "./install_id.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const projectDir = arg("--project-dir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sub = process.argv[2];
const TOKENS_PER_REVIEW = "~2,000-5,000";

function out(o) { process.stdout.write(typeof o === "string" ? o + "\n" : JSON.stringify(o, null, 2) + "\n"); }

function status() {
  const cfg = readConfig(projectDir);
  const events = readEvents(projectDir);
  out([
    "## mochi telemetry status",
    `- decided: ${cfg.decided}`,
    `- share (anonymous telemetry): ${cfg.share ? "on" : "off"}`,
    `- review-auto (efficiency review): ${cfg.reviewAuto ? "on" : "off"}  (cost: ${TOKENS_PER_REVIEW} of YOUR tokens per sampled session, 1-in-${cfg.sampleN} sampling)`,
    `- kill-switch: ${cfg.killSwitch}`,
    `- env MOCHI_TELEMETRY: ${process.env.MOCHI_TELEMETRY || "(unset)"}`,
    `- would send now: ${isSharingEnabled(cfg, process.env) ? "yes" : "no"}`,
    `- ingest endpoint: ${INGEST_URL}`,
    `- install-id: ${getInstallId()}`,
    `- local events: ${events.length}`,
  ].join("\n"));
}

function show() {
  const events = readEvents(projectDir).map(redactEvent);
  out([
    "## EXACTLY what is stored locally and would be sent (redacted Zone-A):",
    "",
    "### Events (the literal POST batch entries):",
    JSON.stringify(events, null, 2),
    "",
    "### Local aggregate (never sent; for your eyes):",
    JSON.stringify(aggregate(readEvents(projectDir)), null, 2),
  ].join("\n"));
}

async function main() {
  switch (sub) {
    case "status": return status();
    case "show": return show();
    case "on": writeConfig(projectDir, { decided: true, share: true }); return status();
    case "off": writeConfig(projectDir, { decided: true, share: false }); return status();
    case "review-auto": {
      const v = process.argv[3] === "on";
      writeConfig(projectDir, { decided: true, reviewAuto: v });
      return status();
    }
    case "flush": { await flush(projectDir, process.env); return out({ flushed: true }); }
    case "reset-id": { resetInstallId(); return out(getInstallId()); }
    case "purge": {
      const dir = telemetryDir(projectDir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return out({ purged: true, note: "Local telemetry deleted. For server-side erasure, the owner runs DELETE /v1/data?iid=<your id>." });
    }
    default: return out("usage: telemetry status|show|on|off|review-auto on|off|flush|reset-id|purge --project-dir <dir>");
  }
}
main();

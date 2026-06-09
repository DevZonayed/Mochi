#!/usr/bin/env node
// CLI for /mochi:review-session: append a redacted Zone-A distillation as a
// telemetry line (Zone-B free text is structurally dropped by the redactor).
import { appendEvent } from "./telemetry_log.js";
import { redactDistillation } from "./telemetry_redact.js";
import { getInstallId } from "./install_id.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const projectDir = arg("--project-dir") || process.cwd();
if (process.argv[2] === "emit") {
  let raw = {};
  try { raw = JSON.parse(arg("--distillation") || "{}"); } catch {}
  const dist = redactDistillation(raw);
  appendEvent(projectDir, {
    ts: Math.floor(Date.now() / 1000),
    iid: getInstallId(),
    ...dist,
  });
  process.stdout.write(JSON.stringify({ emitted: dist }, null, 2) + "\n");
} else {
  process.stdout.write("usage: telemetry_review_cli emit --distillation '<json>' --project-dir <dir>\n");
}

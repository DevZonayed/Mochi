#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  paths,
  isBootstrapped,
  readIndexTail,
  readLinkSummary,
  readStateMd,
  readConfig,
  estimateTokens,
} from "../lib/paths.js";
import { readSentinel } from "../lib/archive.js";
import { register as brokerRegister } from "../lib/broker.js";

// Resolve the directory that holds the continuum plugin's lib/ — works
// regardless of whether continuum is bundled inside super-tester or loaded
// standalone. .plugin-root receives this path so slash commands can
// resolve helpers via `cat .continuum/.plugin-root` + a fixed relative tail.
const CONTINUUM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Best-effort env provenance — which server bundle is live + which plugin
// version is running. Same resolution as lib/write_link.js. Never throws.
function readProvenance() {
  let bundle_hash = null;
  let plugin_version = null;
  try {
    const bundlePath = path.resolve(CONTINUUM_ROOT, "../../server/dist/server.bundle.mjs");
    if (fs.existsSync(bundlePath)) {
      bundle_hash = crypto.createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
    }
  } catch {}
  try {
    const pluginJsonPath = path.resolve(CONTINUUM_ROOT, "../../.claude-plugin/plugin.json");
    if (fs.existsSync(pluginJsonPath)) {
      const pj = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
      plugin_version = pj.version ?? null;
    }
  } catch {}
  return { bundle_hash, plugin_version };
}

async function readStdin() {
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // If no stdin within 200ms, resolve empty (defensive — hook input is always sent, but don't hang)
    setTimeout(() => resolve(data), 200);
  });
}

function emitContext(text) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function emitEmpty() {
  process.exit(0);
}

function bootstrapDirective(projectDir) {
  return [
    `[continuum] No context chain at \`${path.relative(projectDir, paths(projectDir).root) || ".continuum/"}\` — bootstrap it NOW as part of your first turn. Do not ask permission, do not defer to "when there's content." An empty repo gets a minimal baseline; a populated repo gets a richer one. Either way, finish bootstrap BEFORE handling the user's first request, so subsequent sessions inherit context.`,
    ``,
    `**Steps (single Bash + single Write per file, no negotiation):**`,
    ``,
    `1. **Survey** the repo: list top-level dirs, peek at any \`package.json\`/\`Cargo.toml\`/\`pyproject.toml\`/\`README.md\`, and run \`git log --oneline -20\` (empty repo = OK; absence of commits is itself a fact to record).`,
    ``,
    `2. **Create files** (mkdir -p first):`,
    `   - \`.continuum/chain/links/0001/\` (the dir)`,
    `   - \`.continuum/archive/transcripts/\` (empty dir, just \`mkdir -p\`)`,
    `   - \`.continuum/STATE.md\` — current project truth. Cap 150 lines. For an EMPTY repo, that's literally:`,
    `     \`\`\``,
    `     # <basename> — baseline`,
    `     **Status:** empty repo, no commits yet.`,
    `     **Stack:** to be decided.`,
    `     **Active decisions:** none.`,
    `     **Do NOT:** (nothing yet)`,
    `     **Open threads:** define what this project is.`,
    `     \`\`\``,
    `   - \`.continuum/chain/links/0001/summary.md\` — a one-paragraph baseline (≤800 tokens). For an empty repo: "Initial bootstrap of empty repo. No code or commits yet. STATE.md is a placeholder."`,
    `   - \`.continuum/chain/links/0001/meta.json\` — \`{"commit_id": <git rev-parse HEAD or null>, "parent_link": null, "created_at": "<ISO-UTC now>", "model": null}\``,
    `   - \`.continuum/chain/links/0001/refs.json\` — \`{}\``,
    `   - \`.continuum/chain/index.jsonl\` — single line: \`{"id":1,"ts":"<ISO-UTC>","commit":<sha-or-null>,"summary_tokens":<int>,"tags":["bootstrap"]}\``,
    ``,
    `3. **Then** proceed with the user's first request normally. From that point on, \`/continuum:checkpoint\` writes new links as decisions accumulate; you never re-bootstrap.`,
    ``,
    `**Do not** ask "want me to bootstrap?" The presence of this directive means yes, always. The user can disable Continuum by removing the plugin if they don't want it.`,
  ].join("\n");
}

function buildLoadedContext(projectDir, cfg) {
  const stateMd = readStateMd(projectDir);
  const tail = readIndexTail(projectDir, cfg.newest_links_to_load);
  const stateBlock = stateMd
    ? `### Current state (STATE.md)\n\n${stateMd.trim()}\n`
    : `### Current state\n\n(STATE.md missing — chain exists but state is empty. Regenerate at next checkpoint.)\n`;

  const linkBlocks = [];
  for (const entry of tail) {
    const summary = readLinkSummary(projectDir, entry.id);
    if (!summary) continue;
    linkBlocks.push(
      `### Link ${String(entry.id).padStart(4, "0")} — ${entry.ts ?? "?"} (commit: ${entry.commit ?? "n/a"})\n\n${summary.trim()}`
    );
  }

  let assembled = [
    `[continuum] Loaded context chain (${tail.length > 0 ? `${tail.length} recent link${tail.length === 1 ? "" : "s"}` : "no links yet"}).`,
    ``,
    stateBlock,
    ...linkBlocks,
  ].join("\n");

  // Enforce token budget: drop oldest link summaries until under cap, never truncate STATE.md.
  let tokens = estimateTokens(assembled);
  let dropped = 0;
  while (tokens > cfg.inject_token_cap && linkBlocks.length > 0) {
    linkBlocks.shift();
    dropped += 1;
    assembled = [
      `[continuum] Loaded context chain (${linkBlocks.length} recent link${linkBlocks.length === 1 ? "" : "s"}; ${dropped} dropped to stay under token cap).`,
      ``,
      stateBlock,
      ...linkBlocks,
    ].join("\n");
    tokens = estimateTokens(assembled);
  }

  // Verify-before-assert + tooling-gotchas reminder. Kept to <=6 lines so it
  // doesn't eat the token budget. Best-effort note about a per-project file.
  let projectGotchas = "";
  try {
    if (fs.existsSync(path.join(paths(projectDir).root, "gotchas.md"))) {
      projectGotchas = ` Project-specific gotchas exist at \`.continuum/gotchas.md\` — read them too.`;
    }
  } catch {}
  assembled += [
    ``,
    ``,
    `---`,
    ``,
    `**Verify-before-assert + tooling gotchas**`,
    `- Memory above is point-in-time; re-verify any memory-derived claim against current code/live state before asserting it as fact.`,
    `- Before trusting browser QA results, consult the browser skill gotchas (\`skills/browser/references/gotchas.md\`): console reads need \`sinceNavigation\`; prefer selector-based clicks; \`browser_emulate_viewport\` changes JS layout (innerWidth/matchMedia) but \`browser_window_resize\` does NOT; after a deploy confirm the live bundle hash matches the built one; on a 5xx read the response body.${projectGotchas}`,
  ].join("\n");

  assembled += `\n\n_(continuum: token budget used ≈ ${tokens}/${cfg.inject_token_cap}. Use \`/continuum:checkpoint\` to write a new link when decisions accrue.)_`;
  return assembled;
}

function computeDefaultSessionName(projectDir) {
  const base = path.basename(projectDir);
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectDir, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return branch && branch !== "HEAD" ? `${base} · ${branch}` : base;
  } catch {
    return base;
  }
}

async function main() {
  const stdinRaw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(stdinRaw || "{}"); } catch {}

  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload.session_id || null;

  // Persist session id + continuum's lib root so slash commands can resolve
  // helpers without depending on ${CLAUDE_PLUGIN_ROOT} expansion in shell
  // blocks (which doesn't work in skill bodies, see commit e988840).
  try {
    const p = paths(projectDir);
    fs.mkdirSync(p.root, { recursive: true });
    if (sessionId) fs.writeFileSync(p.sessionIdFile, sessionId);
    fs.writeFileSync(path.join(p.root, ".plugin-root"), CONTINUUM_ROOT);
    // Protective .gitignore (idempotent APPENDER — B2 fix): the verification
    // ledger, provenance, uploads, runs and screenshots can contain page-derived
    // data (control labels, response bodies, secrets seeded for testing); the
    // comms/ tree holds WhatsApp auth creds + private messages. None of it may be
    // committed. The chain (chain/, STATE.md) and comms/config.json are
    // intentionally tracked. This MUST append missing lines to an existing
    // .gitignore (not just create-if-absent), so repos bootstrapped before comms
    // shipped still gain the comms ignores. Paths are relative to .continuum/.
    const giPath = path.join(p.root, ".gitignore");
    const giHeader = [
      "# Auto-written by continuum. Transient / page-derived data — do not commit.",
      "# The chain (chain/, STATE.md) and comms/config.json are intentionally tracked.",
    ];
    const giWanted = [
      "verification/",
      "runs/",
      "uploads/",
      "screenshots/",
      ".env-provenance.json",
      "comms/*",
      "!comms/config.json",
    ];
    let giExisting = [];
    try {
      if (fs.existsSync(giPath)) {
        giExisting = fs.readFileSync(giPath, "utf8").split("\n");
      }
    } catch {}
    const giHave = new Set(giExisting.map((l) => l.trim()));
    if (giExisting.length === 0) {
      // Fresh file: header + all wanted lines + trailing newline.
      fs.writeFileSync(giPath, [...giHeader, ...giWanted, ""].join("\n"));
    } else {
      // Existing file: append only the wanted lines that are missing.
      const toAdd = giWanted.filter((l) => !giHave.has(l));
      if (toAdd.length > 0) {
        const base = fs.readFileSync(giPath, "utf8");
        const sep = base.endsWith("\n") || base.length === 0 ? "" : "\n";
        fs.writeFileSync(giPath, base + sep + toAdd.join("\n") + "\n");
      }
    }
  } catch {}

  // Stamp env provenance every session so a later checkpoint / debugging pass
  // can tell exactly which plugin version + server bundle was live. Best-effort.
  try {
    const p = paths(projectDir);
    fs.mkdirSync(p.root, { recursive: true });
    const { bundle_hash, plugin_version } = readProvenance();
    fs.writeFileSync(
      path.join(p.root, ".env-provenance.json"),
      JSON.stringify(
        {
          plugin_version,
          bundle_hash,
          model: process.env.CLAUDE_MODEL || null,
          session_id: sessionId,
          ts: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
  } catch {}

  // Register with the Mochi broker so the extension popup can target this
  // session by name and push hints into it. AWAITED so the popup sees the
  // session immediately, but the broker.js fetch has a short timeout —
  // if Mochi is offline, this returns {ok:false} quickly and SessionStart
  // continues normally.
  if (sessionId) {
    const name = computeDefaultSessionName(projectDir);
    try {
      const p = paths(projectDir);
      fs.writeFileSync(path.join(p.root, ".session-name"), name);
    } catch {}
    try { await brokerRegister({ sessionId, name, projectDir }); } catch {}
  }

  const cfg = readConfig(projectDir);

  if (!isBootstrapped(projectDir)) {
    emitContext(bootstrapDirective(projectDir));
    return;
  }

  let context = buildLoadedContext(projectDir, cfg);

  const sentinel = readSentinel(projectDir);
  if (sentinel) {
    const trigger = sentinel.trigger || "?";
    const why = sentinel.matcher || sentinel.why_session_ended || "?";
    const archive = sentinel.archive_path || "(no archive recorded)";
    context += `\n\n---\n\n**⚠ Pending checkpoint detected.** Previous session ended via \`${trigger}\` (${why}). Raw transcript was archived to:\n\n\`${archive}\`\n\nIf the last session changed decisions or surfaced new threads, run \`/continuum:checkpoint\` now — read the archive with \`zcat\` if you need to recover detail. The sentinel clears automatically when a new link is written.`;
  }

  emitContext(context);
}

main().catch((err) => {
  process.stderr.write(`[continuum:session_start] ${err?.message ?? err}\n`);
  emitEmpty();
});

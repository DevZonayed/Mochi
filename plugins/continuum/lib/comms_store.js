// File-based, append-only message store (spec §4). One messages.jsonl per chat;
// order is reconstructed at READ time by sorting on ts (live/backfill/import
// are all pure appends — the append-only contract is never violated by mid-file
// insertion). cursor.json holds the per-chat newest/oldest watermark + count.
// HARD efficiency caps (§4.3) are enforced server-side in getSlice, independent
// of caller input.

import fs from "node:fs";
import path from "node:path";
import {
  commsChatDir,
  commsMessagesPath,
  commsCursorPath,
} from "./paths.js";

const CURSOR_DEFAULT = { newestId: null, newestTs: 0, oldestId: null, oldestTs: 0, count: 0 };

function atomicWrite(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// readCursor: cursor.json or a zeroed default. Never throws.
export function readCursor(projectDir, provider, accountId, chatId) {
  const f = commsCursorPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(f)) return { ...CURSOR_DEFAULT };
  try { return { ...CURSOR_DEFAULT, ...JSON.parse(fs.readFileSync(f, "utf8")) }; }
  catch { return { ...CURSOR_DEFAULT }; }
}

// writeCursor: atomic cursor.json write.
export function writeCursor(projectDir, provider, accountId, chatId, cursor) {
  const f = commsCursorPath(projectDir, provider, accountId, chatId);
  atomicWrite(f, JSON.stringify(cursor, null, 2) + "\n");
  return f;
}

// internal: read all message records for a chat (append-only jsonl).
function readAllMessages(projectDir, provider, accountId, chatId) {
  const f = commsMessagesPath(projectDir, provider, accountId, chatId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// exported so later tasks (append/getSlice) and tests can share it.
export { readAllMessages, atomicWrite, commsChatDir };

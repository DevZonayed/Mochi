# `browser_upload_file` — design spec

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-05-19
**Authors:** Jonayed + Claude (mochi plugin)
**Scope:** Two new browser MCP tools, one new server module, one new extension module, content-addressed file storage under `.continuum/uploads/`.

---

## Motivation

The mochi browser MCP can drive Chrome but cannot put a file onto a page. When an agent clicks a "Choose File" button, the OS native file picker opens and nothing inside the browser sandbox (extension, CDP, content script) can interact with it. This blocks every real-world workflow that involves attaching an image, document, or video — Facebook posts, Slack messages, GitHub comments, email composers, CMS uploads.

The goal is to add file upload capability that **exceeds Playwright's `setInputFiles`** in three dimensions:

1. **Source flexibility** — accept local paths, remote URLs, base64/data URLs, and a reusable staged-blob library, not just paths.
2. **Strategy chain** — fall back from direct `DOM.setFileInputFiles` → file-chooser intercept → drag-drop synthesis → paste synthesis, so the tool works against sites that reject programmatic input.
3. **Smart wait** — confirm the upload actually landed (preview thumbnail, network 2xx, or caller-supplied signal) instead of returning the moment bytes are handed off.

---

## Tool surface

Two new tools are added to `server/src/tools.js`:

### `browser_upload_stage` (local; no extension round-trip)

Normalizes any supported source into a content-addressed blob under `.continuum/uploads/` and returns a stable `stashId` the agent can reuse across many `browser_upload_file` calls and across sessions.

**Input:**
```json
{
  "source": {
    "path":    "/abs/path/cat.png",
    "url":     "https://…/cat.png",
    "dataUrl": "data:image/png;base64,…",
    "base64":  "iVBORw0KG…",
    "bytes":   "<alias for base64>"
  },
  "mime":     "image/png",
  "name":     "cat.png",
  "keep":     "session",
  "maxBytes": 52428800
}
```
Exactly one field under `source` may be set.

**Output:**
```json
{
  "stashId":     "u_4f8a92c1",
  "sha256":      "4f8a92c1…",
  "path":        "/abs/.continuum/uploads/4f8a92c1….png",
  "name":        "cat.png",
  "mime":        "image/png",
  "sizeBytes":   38104,
  "source":      { "kind": "url", "value": "https://…/cat.png" },
  "keep":        "session",
  "dedupedFrom": "u_4f8a92c1"
}
```

**Behavior:**
1. Resolve source → in-memory buffer. URL fetch uses `undici` with 30s timeout, ≤5 redirects, streaming size enforcement against `maxBytes`.
2. Compute sha256. If `index.json` contains this sha and the blob exists → reuse (idempotent). Bump `lastUsedAt`.
3. Sniff MIME (magic bytes); fall back to caller `mime`; fall back to `application/octet-stream`. Choose extension from MIME table.
4. Write `.continuum/uploads/<sha>.<ext>` atomically (`.tmp/<rand>` → rename).
5. Update `index.json` atomically.

**Errors:** `source-missing`, `source-conflict`, `fetch-failed`, `too-large`, `decode-failed`.

### `browser_upload_file` (wire tool)

Resolves source to a disk path (calls `stage()` internally if needed), then sends a single wire command to the extension which executes the strategy chain and smart-wait.

**Input:**
```json
{
  "tabId": 123,

  "stashId":  "u_4f8a92c1",
  "path":     "/abs/cat.png",
  "url":      "https://…",
  "dataUrl":  "data:…",
  "base64":   "…", "mime": "image/png", "name": "cat.png",
  "files":    [ /* array of any of the above for multi-file inputs */ ],

  "selector": "input[type=file][name=photo]",
  "ref":      "a3f9",
  "trigger":  { "selector": "button:has-text('Photo')" },
  "auto":     { "near": "ref_or_selector" },

  "strategies":     ["direct", "intercept", "drop", "paste"],
  "frames":         "all",
  "dispatchEvents": ["change", "input"],

  "waitFor": {
    "mode":            "smart",
    "timeoutMs":       15000,
    "previewSelector": null,
    "networkPattern":  null,
    "successSelector": null
  }
}
```

Exactly one source-field and exactly one target-field must be set (sources may also be a `files` array).

**Output:**
```json
{
  "ok":       true,
  "strategy": "intercept",
  "attempts": [
    { "strategy": "direct",    "ok": false, "reason": "target is button, not input" },
    { "strategy": "intercept", "ok": true,  "durationMs": 420 }
  ],
  "target":    { "resolved": "button.compose-photo", "frameId": "…", "backendNodeId": 7723 },
  "files":     [ { "name": "cat.png", "mime": "image/png", "sizeBytes": 38104, "stashId": "u_4f8a92c1" } ],
  "waitedFor": { "signal": "preview-img", "selector": "img[src^=blob:]", "durationMs": 1180 },
  "totalMs":   1640
}
```

---

## Architecture

```
┌────────────────────────────────┐      ┌──────────────────────────────────┐
│  MCP server  (server/src/…)    │      │  Chrome extension  (extension/…) │
│                                │      │                                  │
│  tools.js                      │      │  background.js                   │
│   ├─ browser_upload_stage  ────┼─local│   ├─ case "upload_stage"  (n/a)  │
│   └─ browser_upload_file  ─────┼─wire►│   └─ case "upload_file"  ────────┼──► CDP
│       ├─ resolve source        │      │                                  │
│       │   → temp file path     │      │  upload.js  (new module)         │
│       ├─ send wire cmd         │      │   ├─ strategy: direct            │
│       └─ collect telemetry     │      │   ├─ strategy: intercept         │
│                                │      │   ├─ strategy: drop              │
│  uploads.js  (new module)      │      │   ├─ strategy: paste             │
│   ├─ stage()  any → blob+meta  │      │   ├─ frame traversal             │
│   ├─ resolve()  any → path     │      │   ├─ auto-detect rule            │
│   ├─ gc()  cleanup hook        │      │   └─ smart-wait collector        │
│   └─ index.json I/O            │      │       (MutationObserver +        │
│                                │      │        Network ring buffer tap)  │
│  .continuum/uploads/           │      │                                  │
│   ├─ index.json                │      │                                  │
│   ├─ <sha>.<ext>  blobs        │      │                                  │
│   └─ log.jsonl    telemetry    │      │                                  │
└────────────────────────────────┘      └──────────────────────────────────┘
```

### Server-side ownership

- All file I/O (read path, fetch URL, decode base64, hash, dedupe, write blobs, manage index) lives in `server/src/uploads.js`. The extension never touches the filesystem.
- `browser_upload_stage` short-circuits in `handleToolCall`'s local-tools switch (alongside `browser_session_health` et al). It never sends a wire message.
- `browser_upload_file` is wire-mapped to extension command `upload_file`. The server resolves the source first; the wire payload contains the resolved absolute path(s).

### Extension-side ownership

- `extension/upload.js` is the new module. The existing `case "upload_file"` clause in `background.js`'s dispatch switch (~line 875) routes to it.
- It owns target resolution, the four strategies, frame traversal, and smart-wait listeners.
- It uses the existing `attachDebugger(tabId)` helper. Smart-wait reuses the existing `tabBuffers[tabId].network` ring buffer rather than installing a parallel `Network.responseReceived` listener.

### Wire-protocol addition

```
broker → ext   { id, type: "upload_file", params: {
  filePaths,        // array of absolute paths inside .continuum/uploads/
  fileBytes,        // optional array of { name, mime, base64 } — populated by the
                    //   server only when the strategy chain includes "drop" or
                    //   "paste"; omitted when only "direct"/"intercept" will run
  target,           // exactly one of: { selector } | { ref } | { trigger:{…} } | { auto:{near} }
  strategies,       // ordered array, e.g. ["direct","intercept","drop","paste"]
  frames,           // "all" | "top" | <frameId string>
  dispatchEvents,   // array of event names, e.g. ["change","input"]
  waitFor           // { mode, timeoutMs, previewSelector, networkPattern, successSelector }
}, clientId }
ext → broker   { id, ok: true,  result: <output schema above> }
ext → broker   { id, ok: false, error: { code, message, details } }
```

No protocol version bump needed; this is an additive command. The server decides whether to ship `fileBytes` based on the strategy chain: bytes are only needed by `drop` and `paste` (which reconstruct `File` objects in-page via `Runtime.evaluate`). Direct and intercept use the path-based `DOM.setFileInputFiles` / `Page.handleFileChooser` and never need raw bytes.

### Storage layout

```
.continuum/uploads/
  index.json
  4f8a92c1….png
  ab12cd34….pdf
  log.jsonl
  .tmp/        (transient; cleared on startup)
```

`index.json` schema:
```json
{
  "version": 1,
  "entries": [
    {
      "stashId":    "u_4f8a92c1",
      "sha256":     "4f8a92c1…",
      "ext":        "png",
      "mime":       "image/png",
      "name":       "cat.png",
      "sizeBytes":  38104,
      "source":     { "kind": "url", "value": "https://…/cat.png" },
      "keep":       "session",
      "sessionId":  "abc-123",
      "createdAt":  "2026-05-19T10:00:00Z",
      "lastUsedAt": "2026-05-19T10:00:00Z"
    }
  ]
}
```

---

## Strategy chain (extension/upload.js)

The chain runs in caller-specified order (default: `direct → intercept → drop → paste`). First success wins; failures are recorded for telemetry but don't abort the chain.

### Strategy: `direct`

```
resolve target → backendNodeId via DOM.querySelector or accessibility-ref table
if node tagName != "INPUT" or input.type != "file":
  → fail with "target-not-uploadable"
DOM.setFileInputFiles({ nodeId, files: filePaths })
Runtime.evaluate: dispatch events from `dispatchEvents` on node
→ success
```

### Strategy: `intercept`

```
Page.setInterceptFileChooserDialog({ enabled: true })
register one-shot listener on Page.fileChooserOpened:
  Page.handleFileChooser({ files: filePaths })
  signal chooser-fired
resolve target → click center via Input.dispatchMouseEvent (down/up)
race(chooser-fired, timeout(3000))
Page.setInterceptFileChooserDialog({ enabled: false })
→ success iff chooser-fired
```

### Strategy: `drop`

```
for each filePath: read bytes on server side, stream-encode to base64,
  send to extension as part of the wire payload.
Runtime.evaluate (in target frame's isolated world):
  reconstruct File objects: new File([Uint8Array(decoded)], name, { type: mime })
  build DataTransfer; .items.add(file) for each
  on target box center:
    dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true }))
    dispatchEvent(new DragEvent('dragover',  { dataTransfer, bubbles: true }))
    dispatchEvent(new DragEvent('drop',      { dataTransfer, bubbles: true }))
→ success if drop event was not preventDefault'd into a no-op (heuristic: check
  for a target-side mutation within 500ms — preview <img>, child <li>, etc.)
```

(Bytes-via-wire is unavoidable for `drop`/`paste` because `Runtime.evaluate` can't reach the filesystem. The base64 payload is sent once per upload regardless of how many strategies attempt.)

### Strategy: `paste`

```
focus target (if contenteditable) or document.activeElement
Runtime.evaluate in target frame:
  build File objects (as in drop)
  build DataTransfer
  dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true }))
→ success if event fired and was not preventDefault'd into a no-op (same heuristic as drop)
```

### Target resolution

Order of resolution:
1. `selector` → `DOM.querySelector({ nodeId: documentNodeId, selector })`.
2. `ref` → look up via the existing accessibility-snapshot ref table; resolve to `backendNodeId`.
3. `trigger` → either a selector or ref; resolves the same way; tool implies `intercept` as the first strategy.
4. `auto.near` → caller passes a string that is *either* an accessibility `ref` (matches `/^[a-z0-9]{1,8}$/i` and is present in the ref table) *or* a CSS selector (everything else). The anchor element is resolved by that, then the tool searches descendants → following siblings (≤5) → ancestor's descendants (depth ≤3) for an `<input type=file>`. If found, treat as direct target. If not, treat anchor as `trigger`.

Frame search (when `frames: "all"`):
- For each frame in `Page.getFrameTree`, try resolution. Stop at first match. Track which frame won so subsequent CDP calls scope correctly.
- Cross-origin (OOPIF) frames need `Target.attachToTarget`. v1 handles same-origin only; OOPIF gracefully fails with `target-not-found` and a `details.framesSearched` list. Future enhancement noted in open threads.

---

## Smart wait

After the chosen strategy reports success, smart-wait races signals until *any* resolves. Default `timeoutMs: 15000`.

| Signal | Mechanism |
|---|---|
| Preview thumbnail | `MutationObserver` on `document.body` watching subtree for new `<img>` / `<video>` whose `src` starts with `blob:` or `data:`. |
| Upload network 2xx | Hook into the same `chrome.debugger.onEvent` path that feeds `tabBuffers[tabId].network` (see `background.js:525`). The upload module registers a transient listener that matches POST/PUT responses where URL matches `/upload\|media\|attach\|photo/i` AND status ∈ `[200,299]`. The listener is added when smart-wait starts and removed when any signal fires or timeout elapses. The persistent ring buffer is not modified. |
| `successSelector` | Caller-provided CSS selector; resolved via repeated `DOM.querySelector` poll (250ms cadence) plus visibility check. |
| `networkPattern` | Caller-provided regex; overrides the heuristic above. |

Return shape on success:
```json
{ "signal": "preview-img", "selector": "img[src^=blob:]", "durationMs": 1180 }
```

On timeout, returns `{ signal: null, reason: "timeout", evidence: { networkSampled: N, mutationSampled: M } }` — the upload result is still `ok: true` because the file *was* set; the agent just didn't see explicit confirmation.

`waitFor.mode`:
- `"smart"` (default) — race all four signals; first wins.
- `"explicit"` — require `successSelector` or `networkPattern`; ignore heuristics.
- `"none"` — return immediately after the strategy succeeds.

---

## File lifecycle

- **Sessions:** mochi already issues a `session_id` per Claude session. Stage records the session in the index entry.
- **`keep: "session"`** (default): blob is GC'd when the session ends if no other entry references the same sha256.
- **`keep: "persistent"`**: survives session end; only removed if the user deletes the file or runs a future cleanup tool (out of v1 scope).
- **Dedup:** two entries can share a blob (e.g., session + persistent). The blob is unlinked only when reference count reaches zero.
- **Caps:**
  - Single file: `MAX_UPLOAD_BYTES = 100 MB` (env-overridable via `SUPER_TESTER_MAX_UPLOAD_BYTES`).
  - Total directory: `MAX_TOTAL_UPLOAD_BYTES = 1 GB`. On overflow, the oldest `keep: session` entries with `lastUsedAt < now - 1h` are evicted first; persistent entries never auto-evict.
- **Atomicity:** all blob writes go to `.tmp/<rand>` then rename. `index.json` updates write to `index.json.tmp` then rename. In-process mutex serializes concurrent updates.

---

## Security boundary

- **Path allowlist (extension side):** the extension only accepts file paths that are inside the project's `.continuum/uploads/` directory or explicitly listed in env `SUPER_TESTER_UPLOAD_ALLOW_PATHS` (colon-separated absolute prefixes). Caller-supplied raw `path:` sources are *always* re-staged into `.continuum/uploads/` first; the extension never sees the original path.
- **URL fetcher:** server-side fetcher refuses `file://`, `data:` (handled separately as `dataUrl`), and private network addresses unless `SUPER_TESTER_UPLOAD_ALLOW_PRIVATE_URLS=1`.
- **Size enforcement:** streaming size cap during URL fetch — does not buffer >cap bytes into memory.
- **MIME mismatch:** non-fatal warning in result, not a rejection — caller may know better than the sniffer.
- **No new permissions:** the extension's `chrome.debugger` permission is already in `manifest.json`. No `nativeMessaging`, no `fileSystem`.

The trust model matches the rest of mochi: the agent can do anything the user could do in their own browser session, scoped to what the project exposes.

---

## Errors

| Code | Meaning | Where raised |
|---|---|---|
| `source-missing` | No source field provided. | server (`uploads.stage`, `upload_file`) |
| `source-conflict` | Multiple source fields provided. | server |
| `stash-not-found` | `stashId` not in `index.json` or blob missing on disk. | server |
| `fetch-failed` | URL fetch failed; `details.status`, `details.url`. | server |
| `too-large` | Bytes exceed `maxBytes` or env cap. | server |
| `decode-failed` | base64/dataUrl unparseable. | server |
| `target-not-found` | Selector/ref didn't resolve in any searched frame; `details.framesSearched`. | extension |
| `target-not-uploadable` | Direct strategy forced but target isn't `<input type=file>`. | extension |
| `all-strategies-failed` | Each attempted strategy failed; `details.attempts`. | extension |
| `chooser-timeout` | Intercept strategy clicked but no chooser fired within 3s. | extension |
| `wait-timeout` | Smart/explicit wait elapsed without confirmation. *Not a hard failure*: result is `ok: true, waitedFor: null`. | extension |
| `debugger-detached` | CDP attachment lost mid-operation. | extension |
| `permission` | File path outside path allowlist. | extension |

---

## Telemetry

Each call appends one line to `.continuum/uploads/log.jsonl`:
```json
{"ts":"2026-05-19T10:00:00Z","tabId":123,"origin":"https://facebook.com","stashId":"u_4f8a92c1","strategy":"intercept","totalMs":1640,"ok":true}
```

This feeds the existing `browser_run_history` surface (extension as appropriate) and gives the agent learnable evidence of which strategy works on which origin.

---

## Testing

### Server-side unit tests (`server/tests/uploads.test.js`)
- `stage()` for each source kind: path, url (mocked undici), dataUrl, base64.
- Dedup by sha256: stage twice → second call returns `dedupedFrom`.
- MIME sniffing precedence: magic-byte > caller-supplied > default.
- Size cap enforcement (single-file and total-dir).
- Atomic write under simulated crash (kill mid-write, verify no partial file).
- Concurrent stage calls under in-process mutex.

### Server-side contract tests (`server/tests/upload-wire.test.js`)
- Mock the bridge; assert `browser_upload_file` sends the expected wire payload for every source × target combo.
- Assert source resolution happens server-side (extension only ever receives `filePaths`).

### Extension unit tests (`extension/tests/upload.test.js`)
- Each strategy against a mocked `chrome.debugger.sendCommand`: assert the right CDP calls in the right order.
- Auto-detect rule against fixture DOMs (multiple shapes).
- Frame traversal against fixture frame trees.
- Smart-wait against fixture mutation streams and fixture network buffers.

### Integration tests (`server/tests/integration/upload/`)
A local fixture HTTP server with five pages, each exercising one strategy:
1. Plain `<input type=file name=photo>` → tests `direct`.
2. Hidden input + visible "Upload" button that clicks it → tests `intercept`.
3. Drag-and-drop zone (`<div ondrop=…>` only, no input) → tests `drop`.
4. Contenteditable accepting `paste` events → tests `paste`.
5. Same-origin iframe-embedded uploader → tests frame traversal.

Each fixture posts to a stub endpoint that returns 200 with the received MIME + size; tests assert the round trip. Run against real Chrome via the existing broker. This is the only honest validation of CDP-level work.

### Smoke test
Add one line to the existing smoke script: stage a small PNG, upload to fixture page #1, assert preview thumbnail appears.

---

## What's explicitly out of scope (v1)

- Cross-origin (OOPIF) frame traversal. Same-origin only in v1; OOPIF returns `target-not-found` cleanly.
- Persistent-entry cleanup tool (`browser_upload_forget`). Users `rm` for now.
- A separate "library list" tool. The index is on disk; future enhancement.
- Drag-drop with custom data types (e.g., dragging a URL representation). Files-only in v1.
- Native file picker scripting (impossible by design — that's exactly what this tool routes around).

---

## Open threads

- Real OOPIF traversal via `Target.attachToTarget` — defer until a real workflow needs it.
- Eviction policy beyond "oldest session entry" — fine to tune after we see real usage.
- A `browser_upload_list` / `browser_upload_forget` pair for managing the library — additive, easy to add later.

---

## Acceptance criteria (for the implementation plan)

1. `browser_upload_stage` and `browser_upload_file` both registered, surfaced in `tools/list`, and discoverable from MCP-side tooling.
2. The five integration fixture pages all pass end-to-end.
3. Smart-wait correctly returns the signal that fired (verified against fixtures).
4. `.continuum/uploads/index.json` survives crash mid-write (atomic-rename test).
5. Smoke test green.
6. No regression in existing browser MCP tests (63 plugin synthetic + 38 popup e2e + 22 broker + browser smoke remain green).


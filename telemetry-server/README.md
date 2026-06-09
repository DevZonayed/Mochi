# Mochi Insight — telemetry ingest server

Zone-A (anonymous, content-free) telemetry ingest + owner dashboard. Node 22, no
runtime deps, JSONL on a `/data` volume. Server-side re-redaction is the privacy
keystone — content can never be stored even if a client is tampered with.

## Endpoints
- `POST /v1/ingest` — `x-mochi-key` write-key; per-IP + global rate-limit;
  server-side redact→Zone-A; appends `/data/events/YYYY-MM-DD.jsonl`.
- `GET /v1/health` — returns `ok`.
- `GET /dashboard` — owner auth (Bearer or Basic, constant-time); HTML+inline SVG.
- `GET /v1/summary` — owner auth; JSON aggregates (powers `/mochi:insights`).
- `DELETE /v1/data?iid=…` — owner auth; GDPR erasure of one install-id.

## Env
`PORT`(3000) `INGEST_WRITE_KEY` `DASHBOARD_USER` `DASHBOARD_PASS` `DATA_DIR`(/data) `RETENTION_DAYS`(180).

## Deploy (Dokploy)
See spec §13.9. Build context = `telemetry-server/`, Dockerfile build,
domain `mochi-insight.nexalance.cloud`, one volume mounted at `/data`.

## Test
`npm test`  (runs every colocated `*.test.mjs` via `node --test`)

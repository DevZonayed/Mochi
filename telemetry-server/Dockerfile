# Mochi Insight telemetry ingest server. Zero runtime deps (built-in http only),
# so no npm install step. Runs as the built-in non-root `node` user (UID 1000).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    RETENTION_DAYS=180

WORKDIR /app

# Source only — no node_modules (dependency-free).
COPY package.json server.mjs telemetry_redact.js store.mjs aggregate.mjs dashboard.mjs auth.mjs ./

# Persistent volume for date-bucketed JSONL; owned by the non-root user.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

CMD ["node", "server.mjs"]

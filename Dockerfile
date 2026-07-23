# syntax=docker/dockerfile:1

# ── Builder ──────────────────────────────────────────────────────────────────
# better-sqlite3 normally downloads a prebuilt binary (prebuild-install) for
# Node 20 on linux, but behind restricted networks that download can fail and
# npm falls back to node-gyp. Build tools live only in this stage so the
# runtime image stays slim either way.
FROM node:20-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/gate-server/package.json packages/gate-server/package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node packages/gate-server/ ./

# Bake the repo's example policies into the image as the defaults.
# (Replaces the package-local policies/ dir; override at runtime by mounting
# your own directory at /app/policies.)
RUN rm -rf /app/policies
COPY --chown=node:node policies/ /app/policies/

# SQLite data lives outside the image.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/cli.js", "--port", "4000", "--data-dir", "/data", "--policy-dir", "/app/policies"]

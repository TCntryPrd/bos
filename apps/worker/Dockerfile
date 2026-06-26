# BOS v2 — Worker Dockerfile
# Multi-stage: builder compiles TypeScript, runner executes dist/
# Worker is a Redis Stream consumer — no exposed ports.

# ---- Stage 1: build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

COPY packages/core/package.json packages/core/
COPY packages/core/tsconfig.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/worker/tsconfig.json apps/worker/

RUN npm ci --ignore-scripts

# Copy source
COPY packages/core/src packages/core/src
COPY apps/worker/src apps/worker/src

# Build dependency then worker
RUN npm run build --workspace=packages/core
RUN npm run build --workspace=apps/worker

# ---- Stage 2: production runner ----
FROM node:20-alpine AS runner

RUN addgroup -S boss && adduser -S boss -G boss

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/

RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/apps/worker/dist apps/worker/dist

# Health check: confirm the Node process is alive.
# The worker has no HTTP server so we verify the process is running by checking
# its PID file. The entrypoint writes /tmp/worker.pid on startup.
# If the app does not write a PID file yet, this falls back to checking that
# node is running at all (process table check via /proc).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD test -f /tmp/worker.pid && kill -0 "$(cat /tmp/worker.pid)" 2>/dev/null || \
      pgrep -x node > /dev/null || exit 1

USER boss

# No exposed port — worker only consumes Redis Streams and writes to Postgres/Weaviate
CMD ["node", "apps/worker/dist/index.js"]

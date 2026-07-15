# BOS v2 — API Dockerfile
# Multi-stage: builder compiles TypeScript, runner executes dist/
# The monorepo uses npm workspaces. We copy the entire repo into the build
# context and let npm install resolve workspace packages (@boss/core etc.)
# so we don't need a separate package-publish step.

# Node 22 keeps the API runner aligned with the host Codex CLI and current Node tooling.

# ---- Stage 1: build ----
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — Docker layer caches npm install
# until a manifest actually changes.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy package manifests for every workspace that api depends on
COPY packages/core/package.json packages/core/
COPY packages/core/tsconfig.json packages/core/
COPY packages/brain/package.json packages/brain/
COPY packages/brain/tsconfig.json packages/brain/
COPY packages/connectors/package.json packages/connectors/
COPY packages/connectors/tsconfig.json packages/connectors/
COPY apps/api/package.json apps/api/
COPY apps/api/tsconfig.json apps/api/

# Install all workspace dependencies (hoisted to root node_modules)
RUN npm ci --ignore-scripts

# Copy source for the packages we need to build
COPY packages/core/src packages/core/src
COPY packages/brain/src packages/brain/src
COPY packages/connectors/src packages/connectors/src
COPY apps/api/src apps/api/src
COPY apps/api/skills apps/api/skills

# Build dependencies first, then API
RUN npm run build --workspace=packages/core
RUN npm run build --workspace=packages/brain
RUN npm run build --workspace=packages/connectors
RUN npm run build --workspace=apps/api

# ---- Stage 2: production runner ----
FROM node:22-alpine AS runner

# Install system tools for self-modification capabilities:
# - docker-cli: rebuild and restart own containers via socket
# - git: version control operations on the codebase
# - ripgrep: fast code search (boss_self_grep)
# - bash: shell execution (boss_bash)
# - openssh-client: ssh/scp for rascals reaching client AWS instances
# - curl: HTTP for the rascals' playbook examples (Weaviate ingest, Gemini embed)
# - python3: scripting for ingest/transcribe/data-shaping playbooks
# - jq: JSON wrangling on the command line
RUN apk add --no-cache docker-cli git ripgrep bash openssh-client curl python3 jq chromium

RUN npm install -g @openai/codex@0.144.4
RUN ln -sf /usr/lib/node_modules/@openai/codex/bin/codex.js /usr/bin/codex

# Claude Code CLI — invoked as a subprocess from the rascal-workspace
# routes (v1.6.4). Pinned to the host's installed version so deploys
# don't drift behind subscription auth changes.
RUN npm install -g @anthropic-ai/claude-code@2.1.209

# Google CLI (gemini) — powers the Hermes agent on the tenant's Gemini key
RUN npm install -g @google/gemini-cli

# Security: run as non-root. The `user: 1000:1000` override in
# docker-compose.yml is what actually pins the runtime uid/gid so
# bind-mounted host paths (~/.claude, ~/rascals) line up with host
# ownership; the `boss` user record here is just a label.
RUN addgroup -S boss && adduser -S boss -G boss

WORKDIR /app

# Copy manifests for production install (no devDeps)
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/brain/package.json packages/brain/
COPY packages/connectors/package.json packages/connectors/
COPY apps/api/package.json apps/api/

# Production-only install — omits typescript, tsx, etc.
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output from builder
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/brain/dist packages/brain/dist
COPY --from=builder /app/packages/connectors/dist packages/connectors/dist
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/apps/api/skills skills

# Health check uses wget (ships with alpine base node image)
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --spider -q http://0.0.0.0:8001/health || exit 1

USER boss

EXPOSE 8001

# Entrypoint: start the compiled API
CMD ["node", "apps/api/dist/index.js"]

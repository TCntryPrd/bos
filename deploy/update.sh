#!/usr/bin/env bash
# deploy/update.sh — OTA update from the canonical repo for any BOS box.
#   git pull → idempotent schema → GATED build → --no-deps recreate → health-verify → auto-rollback on failure.
# Per-box config (tenant, brand, keys, domain) lives in .env (gitignored) and is never touched.
# Usage:  bash deploy/update.sh            (updates to origin/main)
#         BOS_BRANCH=fusion-cos-p0p1 bash deploy/update.sh
set -uo pipefail
cd "$(dirname "$0")/.."
BRANCH="${BOS_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo release)}"
log(){ echo "[update] $*"; }
log "fetch origin/$BRANCH"; git fetch --quiet origin "$BRANCH" || { log "fetch FAILED"; exit 1; }
BEFORE=$(git rev-parse HEAD)
if [ "$BEFORE" = "$(git rev-parse "origin/$BRANCH")" ]; then log "already up to date ($(git rev-parse --short HEAD))"; exit 0; fi
git reset --hard "origin/$BRANCH" >/dev/null || { log "reset FAILED"; exit 1; }
AFTER=$(git rev-parse --short HEAD); log "code now at $AFTER (was ${BEFORE:0:7})"
log "reconcile schema (idempotent)"; [ -f deploy/reconcile-schema.sh ] && bash deploy/reconcile-schema.sh >/dev/null 2>&1 || true
log "build api+web (gated)"
if ! docker compose build api web; then log "BUILD FAILED → rolling code back to ${BEFORE:0:7}"; git reset --hard "$BEFORE" >/dev/null; exit 1; fi
log "recreate api+web (--no-deps; postgres untouched)"
docker compose up -d --force-recreate --no-deps api web
for i in $(seq 1 30); do [ "$(docker compose ps api --format '{{.Health}}' 2>/dev/null)" = "healthy" ] && break; sleep 5; done
H=$(docker compose ps api --format '{{.Health}}' 2>/dev/null)
if [ "$H" != "healthy" ]; then
  log "api UNHEALTHY after update → ROLLING BACK to ${BEFORE:0:7}"
  git reset --hard "$BEFORE" >/dev/null && docker compose build api web >/dev/null 2>&1 && docker compose up -d --force-recreate --no-deps api web
  exit 1
fi
log "DONE — at $AFTER, api healthy."

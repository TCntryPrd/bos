#!/usr/bin/env bash
# BOS OTA update — run from the repo root on any BOS box.
#   ./deploy/update.sh            # pull current branch, gated rebuild of api+web
#   ./deploy/update.sh api        # limit to one service
# Safety: build happens BEFORE the running containers are touched; on a failed
# build nothing changes; on a failed health gate we auto-rollback to :last-good.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${COMPOSE_PROJECT_NAME:-$(grep -s '^COMPOSE_PROJECT_NAME=' .env | cut -d= -f2)}"
PROJECT="${PROJECT:-$(basename "$PWD")}"
SERVICES=("${@:-api web}"); [ $# -eq 0 ] && SERVICES=(api web)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
say(){ echo "[$(date +%H:%M:%S)] $*"; }

say "OTA update on branch=$BRANCH project=$PROJECT services=${SERVICES[*]}"
BEFORE=$(git rev-parse HEAD)
git pull --ff-only origin "$BRANCH"
AFTER=$(git rev-parse HEAD)
[ "$BEFORE" = "$AFTER" ] && { say "already up to date ($AFTER)"; exit 0; }
say "updating $BEFORE -> $AFTER"

for s in "${SERVICES[@]}"; do
  docker tag "$PROJECT-$s:latest" "$PROJECT-$s:last-good" 2>/dev/null || true
done

# Normalize tree ownership. Foreign uids (Windows-sourced syncs stamp 197609;
# root-created files) break host pulls AND container self-edit. The api runs
# pinned to 1000:1000 (compose) and must be able to write this tree. data/ is
# excluded — service containers own their state dirs.
say "normalize ownership (uid 1000, data/ excluded)"
CHOWN="chown"; [ "$(id -u)" -eq 0 ] || CHOWN="sudo -n chown"
find . -path ./data -prune -o ! -uid 1000 -print0 2>/dev/null | xargs -0 -r $CHOWN -h 1000:1000 2>/dev/null || say "WARN: ownership normalize incomplete (need root/sudo) — self-edit may hit EACCES"

if ! docker compose build "${SERVICES[@]}"; then
  say "BUILD FAILED — containers untouched, reverting source to $BEFORE"
  git reset --hard "$BEFORE"; exit 1
fi
docker compose up -d --no-deps "${SERVICES[@]}"

say "health gate (100s)"
for i in $(seq 1 20); do
  sleep 5; ok=1
  for s in "${SERVICES[@]}"; do
    st=$(docker inspect "$PROJECT-$s-1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)
    [ "$st" = healthy ] || [ "$st" = running ] || ok=0
  done
  [ $ok -eq 1 ] && { say "OTA update HEALTHY at $AFTER"; exit 0; }
done

say "HEALTH GATE FAILED — rolling back images + source"
for s in "${SERVICES[@]}"; do
  docker tag "$PROJECT-$s:last-good" "$PROJECT-$s:latest" 2>/dev/null || true
done
git reset --hard "$BEFORE"
docker compose up -d --no-deps "${SERVICES[@]}"
say "rolled back to $BEFORE"; exit 1

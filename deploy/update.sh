#!/usr/bin/env bash
# deploy/update.sh — OTA update from the canonical repo for any BOS box.
#   fetch → pick a DELIBERATE target (signed release tag by default) → idempotent schema →
#   GATED build → --no-deps recreate → health-verify → auto-rollback on failure.
# Per-box config (tenant, brand, keys, domain) lives in .env (gitignored) and is never touched.
#
# TARGET SELECTION — safe by default: NEVER auto-runs a moving branch HEAD.
#   (default)                 latest release tag matching v*  (immutable, deliberate releases)
#   BOS_OTA_REF=<sha|tag>     pin to an exact reviewed commit/tag
#   BOS_OTA_TRACK_BRANCH=1    opt-in: track a branch HEAD (dev/staging only) — runs whatever was last pushed
#   BOS_OTA_REQUIRE_SIGNED=1  refuse any target not GPG-signed by a trusted key (RECOMMENDED for client boxes)
#
# CLIENT (DCS) boxes — e.g. Kane — must run only reviewed, SIGNED tags; never branch-tracking. The
# update is operator-triggered (no cron) so a human reviews the target before applying.
set -uo pipefail
cd "$(dirname "$0")/.."
log(){ echo "[update] $*"; }

git fetch --quiet --tags --prune origin || { log "fetch FAILED"; exit 1; }

if [ -n "${BOS_OTA_REF:-}" ]; then
  TARGET="${BOS_OTA_REF}"
elif [ "${BOS_OTA_TRACK_BRANCH:-0}" = "1" ]; then
  TARGET="origin/${BOS_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo release)}"
  log "WARNING: branch-tracking mode — applies whatever was last pushed to this branch (no review gate)"
else
  TARGET="$(git tag -l 'v*' --sort=-version:refname | head -1)"
  [ -z "$TARGET" ] && { log "no release tag (v*) — cut one with 'git tag -s vX.Y.Z && git push --tags', or set BOS_OTA_REF=<sha|tag> / BOS_OTA_TRACK_BRANCH=1"; exit 1; }
fi
TARGET_SHA=$(git rev-parse "${TARGET}^{commit}" 2>/dev/null) || { log "unknown ref: $TARGET"; exit 1; }
log "target: $TARGET  ($(git log -1 --format='%h %s — %an' "$TARGET_SHA" 2>/dev/null))"

# Supply-chain gate (fail-closed): refuse unsigned targets when required.
if [ "${BOS_OTA_REQUIRE_SIGNED:-0}" = "1" ]; then
  if git cat-file -t "$TARGET" 2>/dev/null | grep -q '^tag$'; then
    git verify-tag "$TARGET" >/dev/null 2>&1 || { log "REFUSING: tag $TARGET is not signed by a trusted key (BOS_OTA_REQUIRE_SIGNED=1)"; exit 1; }
  else
    git verify-commit "$TARGET_SHA" >/dev/null 2>&1 || { log "REFUSING: commit $TARGET_SHA is not signed by a trusted key (BOS_OTA_REQUIRE_SIGNED=1)"; exit 1; }
  fi
  log "signature verified"
fi

BEFORE=$(git rev-parse HEAD)
if [ "$BEFORE" = "$TARGET_SHA" ]; then log "already at ${TARGET_SHA:0:7} ($TARGET) — nothing to do"; exit 0; fi
git reset --hard "$TARGET_SHA" >/dev/null || { log "reset FAILED"; exit 1; }
log "code now at $(git rev-parse --short HEAD) (was ${BEFORE:0:7})"

log "reconcile schema (idempotent)"
[ -f deploy/reconcile-schema.sh ] && { bash deploy/reconcile-schema.sh >/dev/null 2>&1 || log "WARN: schema reconcile reported errors (continuing; health-check is the net)"; }

# Normalize tree ownership. Foreign uids (Windows-sourced syncs stamp 197609;
# root-created files) break host pulls AND container self-edit. The api runs
# pinned to 1000:1000 (compose) and must be able to write this tree. data/ is
# excluded — service containers own their state dirs.
log "normalize ownership (uid 1000, data/ excluded)"
CHOWN="chown"; [ "$(id -u)" -eq 0 ] || CHOWN="sudo -n chown"
find . -path ./data -prune -o ! -uid 1000 -print0 2>/dev/null | xargs -0 -r $CHOWN -h 1000:1000 2>/dev/null || log "WARN: ownership normalize incomplete (need root/sudo) — self-edit may hit EACCES"

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
log "DONE — at $(git rev-parse --short HEAD) ($TARGET), api healthy."

#!/usr/bin/env bash
# IR Custom AIOS — hourly auto-commit across all workspace repos (sp-hub + 13 clients)
# Runs via cron: 0 * * * * /home/tcntryprd/boss-dev/scripts/auto-commit-all.sh
#
# Pattern mirrors boss-dev/scripts/auto-commit.sh but loops over all
# client/personal workspaces and sp-hub (IR Custom AIOS Main).
#
# Only commits if there are actual changes. Skips otherwise.

set -uo pipefail

LOG_FILE="/home/tcntryprd/boss-dev/scripts/logs/auto-commit-all.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE"
}

REPOS=(
  "/home/tcntryprd/sp-hub"
  "/home/tcntryprd/clients/01-industry-rockstarr"
  "/home/tcntryprd/clients/02-kane-minkus"
  "/home/tcntryprd/clients/03-ai-district"
  "/home/tcntryprd/clients/04-douglas-estremadoyro"
  "/home/tcntryprd/clients/05-john-ballard"
  "/home/tcntryprd/clients/06-debbie-wooldridge"
  "/home/tcntryprd/clients/07-jessy-trusted-ai-experts"
  "/home/tcntryprd/clients/08-micazen-sharon"
  "/home/tcntryprd/clients/09-lori-zeoli"
  "/home/tcntryprd/clients/10-chris-pessy"
  "/home/tcntryprd/clients/eric-bloom"
  "/home/tcntryprd/clients/john-berfelo"
  "/home/tcntryprd/clients/sp-productions"
)

log "=== Starting sweep across ${#REPOS[@]} repos ==="

PUSHED=0
SKIPPED=0
ERRORS=0

for dir in "${REPOS[@]}"; do
  name=$(basename "$dir")

  if [ ! -d "$dir/.git" ]; then
    log "SKIP $name — no .git"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  cd "$dir" || { log "ERROR $name — cd failed"; ERRORS=$((ERRORS + 1)); continue; }

  # Any changes at all?
  if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  CHANGED=$(git status --short | wc -l)
  TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M UTC')

  # Stage, commit, push
  git add -A >> "$LOG_FILE" 2>&1

  # Safety: refuse to commit if staged files include known secret patterns
  staged_secrets=$(git diff --cached --name-only | grep -iE '\.env$|\.env\.|credentials|client_secret|\.pem$|\.key$|id_rsa|id_ed25519|\.pfx$|\.p12$' || true)
  if [ -n "$staged_secrets" ]; then
    log "SECRET-BLOCK $name — refused to commit: $staged_secrets"
    git reset --quiet
    ERRORS=$((ERRORS + 1))
    continue
  fi

  if git commit -m "auto-backup: ${TIMESTAMP} — ${CHANGED} changes" \
      --author="IR Custom AIOS AutoBackup <boss@starrandpartners.com>" \
      >> "$LOG_FILE" 2>&1; then

    if git push origin main >> "$LOG_FILE" 2>&1; then
      log "PUSHED $name — ${CHANGED} files"
      PUSHED=$((PUSHED + 1))
    else
      log "PUSH-FAIL $name"
      ERRORS=$((ERRORS + 1))
    fi
  else
    log "COMMIT-FAIL $name"
    ERRORS=$((ERRORS + 1))
  fi
done

log "=== Done: pushed=$PUSHED skipped=$SKIPPED errors=$ERRORS ==="

# Rotate log at 1000 lines
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 1000 ]; then
  tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

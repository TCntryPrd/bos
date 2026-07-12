#!/usr/bin/env bash
# IR Custom AIOS — hourly auto-commit & push
# Runs via cron: 0 * * * * /home/tcntryprd/boss-dev/scripts/auto-commit.sh
#
# Only commits if there are actual changes. Skips if nothing changed.
# Pushes to private repo: TCntryPrd/boss-dev (GitHub)

set -euo pipefail

REPO_DIR="/home/tcntryprd/boss-dev"
LOG_FILE="/home/tcntryprd/boss-dev/scripts/logs/auto-commit.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE"
}

cd "$REPO_DIR"

# Check for changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  log "No changes detected — skipping"
  exit 0
fi

# Count what changed
CHANGED=$(git status --short | wc -l)
log "Detected $CHANGED changed files"

# Stage everything (gitignore handles secrets)
git add -A

# Generate commit message with timestamp and summary
TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M UTC')
SUMMARY=$(git diff --cached --stat | tail -1)

git commit -m "auto-backup: ${TIMESTAMP} — ${SUMMARY}" \
  --author="IR Custom AIOS AutoBackup <boss@starrandpartners.com>" \
  >> "$LOG_FILE" 2>&1

# Push to private remote
git push origin master >> "$LOG_FILE" 2>&1

log "Committed and pushed successfully"

# Keep log file from growing forever (last 500 lines)
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 500 ]; then
  tail -200 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

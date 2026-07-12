#!/bin/bash
# vD.1.0 — Disaster rehearsal script
#
# Verifies backups are restorable by:
# 1. Decrypting the latest Postgres snapshot
# 2. Loading it into a temporary container
# 3. Running basic sanity queries
# 4. Cleaning up
#
# Cron: monthly 1st at 05:00 UTC
#   0 5 1 * * /home/tcntryprd/boss-dev/scripts/disaster-rehearsal.sh >> /home/tcntryprd/boss-dev/scripts/logs/disaster-rehearsal.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/boss-backups}"
LOG_PREFIX="[disaster-rehearsal]"
REHEARSAL_CONTAINER="boss_rehearsal_pg"
REHEARSAL_PORT=5499

log() { echo "$LOG_PREFIX $(date -u +%H:%M:%S) $*"; }

# Load encryption key
if [ -f "$SCRIPT_DIR/../.env" ]; then
    export $(grep -E '^BACKUP_ENCRYPTION_KEY=' "$SCRIPT_DIR/../.env" | head -1)
fi

cleanup() {
    docker rm -f "$REHEARSAL_CONTAINER" >/dev/null 2>&1 || true
    rm -rf /tmp/disaster-rehearsal-* 2>/dev/null || true
}
trap cleanup EXIT

log "Starting disaster rehearsal..."

# Find latest Postgres snapshot
LATEST_PG=$(ls -t "$BACKUP_DIR"/boss_pg_*.enc 2>/dev/null | head -1)
if [ -z "$LATEST_PG" ]; then
    log "FAIL: No Postgres snapshots found in $BACKUP_DIR"
    exit 1
fi
log "Latest snapshot: $(basename "$LATEST_PG")"

# Decrypt
WORK_DIR=$(mktemp -d /tmp/disaster-rehearsal-XXXX)
DECRYPTED="$WORK_DIR/restore.sql.gz"

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
    log "FAIL: BACKUP_ENCRYPTION_KEY not set"
    exit 1
fi

IV=$(head -c 16 "$LATEST_PG" | xxd -p | tr -d '\n')
KEY=$(echo -n "$BACKUP_ENCRYPTION_KEY" | xxd -p | tr -d '\n' | head -c 64)
tail -c +17 "$LATEST_PG" | openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "$DECRYPTED"
log "Decrypted OK ($(du -h "$DECRYPTED" | cut -f1))"

# Decompress
gunzip "$DECRYPTED"
SQL_FILE="$WORK_DIR/restore.sql"
log "Decompressed OK ($(du -h "$SQL_FILE" | cut -f1))"

# Start temporary Postgres container
cleanup  # remove any stale rehearsal container
docker run -d --name "$REHEARSAL_CONTAINER" \
    -e POSTGRES_USER=boss \
    -e POSTGRES_PASSWORD=rehearsal \
    -e POSTGRES_DB=boss_db \
    -p "127.0.0.1:${REHEARSAL_PORT}:5432" \
    postgres:16-alpine >/dev/null

log "Waiting for rehearsal Postgres..."
for i in $(seq 1 30); do
    if docker exec "$REHEARSAL_CONTAINER" pg_isready -U boss >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Restore
docker exec -i "$REHEARSAL_CONTAINER" psql -U boss boss_db < "$SQL_FILE" >/dev/null 2>&1
log "Restore complete"

# Sanity checks
TABLES=$(docker exec "$REHEARSAL_CONTAINER" psql -U boss boss_db -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');" 2>/dev/null | tr -d ' ')
RASCALS=$(docker exec "$REHEARSAL_CONTAINER" psql -U boss boss_db -t -c "SELECT count(*) FROM boss_rascals;" 2>/dev/null | tr -d ' ' || echo "0")
SESSIONS=$(docker exec "$REHEARSAL_CONTAINER" psql -U boss boss_db -t -c "SELECT count(*) FROM boss_chat_sessions;" 2>/dev/null | tr -d ' ' || echo "0")

log "Sanity checks:"
log "  Tables: $TABLES"
log "  Rascals: $RASCALS"
log "  Chat sessions: $SESSIONS"

if [ "${TABLES:-0}" -lt 10 ]; then
    log "FAIL: Expected at least 10 tables, got $TABLES"
    # Report failure
    if [ -f "$SCRIPT_DIR/backup-status.sh" ]; then
        source "$SCRIPT_DIR/backup-status.sh"
        report_asset_failure "disaster-rehearsal" "Only $TABLES tables restored"
    fi
    exit 1
fi

log "PASS: Disaster rehearsal successful"

# Report success
if [ -f "$SCRIPT_DIR/backup-status.sh" ]; then
    source "$SCRIPT_DIR/backup-status.sh"
    report_asset_success "disaster-rehearsal" "0"
fi

# cleanup runs via trap

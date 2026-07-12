#!/bin/bash
# vD.1.0 — Docker volume snapshots
#
# Creates encrypted tar.gz snapshots of stateful Docker volumes.
# Uses the same encryption as backup.sh (BACKUP_ENCRYPTION_KEY from .env).
# Snapshots go to /var/lib/boss-backups/ and get USB-mirrored.
#
# Cron: weekly Sunday 03:00 UTC
#   0 3 * * 0 /home/tcntryprd/boss-dev/scripts/volume-snapshot.sh >> /home/tcntryprd/boss-dev/scripts/logs/volume-snapshot.log 2>&1
#
# Retention: 4 weekly snapshots (28 days)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/boss-backups}"
USB_MIRROR_DIR="${USB_MIRROR_DIR:-/mnt/usb-backups}"
RETENTION_DAYS=28
DATE=$(date -u '+%Y%m%d_%H%M%S')
LOG_PREFIX="[volume-snapshot]"

# Source helpers
source "$SCRIPT_DIR/lib/encrypt-helper.sh"
source "$SCRIPT_DIR/lib/backup-mirror.sh"

# Load encryption key
if [ -f "$SCRIPT_DIR/../.env" ]; then
    export $(grep -E '^BACKUP_ENCRYPTION_KEY=' "$SCRIPT_DIR/../.env" | head -1)
fi

log() { echo "$LOG_PREFIX $(date -u +%H:%M:%S) $*"; }

# Volumes to snapshot (name|container_to_stop_first)
# We stop the container briefly to get a consistent snapshot, then restart.
VOLUMES=(
    "boss-v2_redis_data|boss_redis"
    "n8n_n8n_data|n8n"
)

mkdir -p "$BACKUP_DIR"

for entry in "${VOLUMES[@]}"; do
    IFS='|' read -r vol_name container <<< "$entry"
    vol_path="/var/lib/docker/volumes/${vol_name}/_data"

    if [ ! -d "$vol_path" ]; then
        log "SKIP: $vol_name — path not found: $vol_path"
        continue
    fi

    snapshot_name="boss_vol_${vol_name}_${DATE}"
    tar_file="${BACKUP_DIR}/${snapshot_name}.tar.gz"
    enc_file="${tar_file}.enc"

    log "Snapshotting $vol_name..."

    # Brief container stop for consistency (< 10 seconds typically)
    if [ -n "$container" ]; then
        log "  Stopping $container for consistent snapshot..."
        docker stop "$container" --time 10 >/dev/null 2>&1 || true
    fi

    # Create tar.gz
    sudo tar -czf "$tar_file" -C "$vol_path" . 2>/dev/null

    # Restart container immediately
    if [ -n "$container" ]; then
        docker start "$container" >/dev/null 2>&1 || true
        log "  Restarted $container"
    fi

    # Encrypt
    if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
        encrypt_file "$tar_file" "$enc_file"
        rm -f "$tar_file"
        log "  Encrypted: $(basename "$enc_file") ($(du -h "$enc_file" | cut -f1))"
    else
        log "  WARNING: No BACKUP_ENCRYPTION_KEY — snapshot stored unencrypted"
        mv "$tar_file" "$enc_file"
    fi

    # Report to status.json
    if [ -f "$SCRIPT_DIR/backup-status.sh" ]; then
        source "$SCRIPT_DIR/backup-status.sh"
        report_asset_success "volume-${vol_name}" "$(stat -c%s "$enc_file" 2>/dev/null || echo 0)"
    fi
done

# Retention: remove snapshots older than $RETENTION_DAYS
log "Cleaning snapshots older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "boss_vol_*" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true

# USB mirror
if mountpoint -q "$USB_MIRROR_DIR" 2>/dev/null; then
    mirror_to_usb "$BACKUP_DIR" "$USB_MIRROR_DIR"
    log "USB mirror complete"
else
    log "USB not mounted — skipping mirror"
fi

log "Volume snapshot complete"

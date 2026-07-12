#!/bin/bash
# vS.1.0 — Host command dispatcher
# Runs queued commands written by IR Custom AIOS's host management tools.
# Called by cron every minute: * * * * * /home/tcntryprd/boss-dev/scripts/host-cmd-dispatch.sh
#
# Commands are .sh files in scripts/host-cmd-queue/. Each is executed once,
# then moved to scripts/host-cmd-queue/done/. Failures go to done/ with
# .failed suffix.

QUEUE_DIR="/home/tcntryprd/boss-dev/scripts/host-cmd-queue"
DONE_DIR="$QUEUE_DIR/done"
LOG="/home/tcntryprd/boss-dev/scripts/logs/host-cmd-dispatch.log"

mkdir -p "$QUEUE_DIR" "$DONE_DIR"

for cmd in "$QUEUE_DIR"/*.sh; do
    [ -f "$cmd" ] || continue
    bn=$(basename "$cmd")

    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Executing: $bn" >> "$LOG"

    if bash "$cmd" >> "$LOG" 2>&1; then
        mv "$cmd" "$DONE_DIR/$bn"
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] OK: $bn" >> "$LOG"
    else
        mv "$cmd" "$DONE_DIR/${bn}.failed"
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] FAILED: $bn" >> "$LOG"
    fi
done

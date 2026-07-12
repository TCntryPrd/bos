#!/usr/bin/env bash
# Runs every minute via cron. Fires keepalive if >= 301 min since last fire.
LOCK="/tmp/window-keepalive-last"
NOW=$(date +%s)

if [ ! -f "$LOCK" ]; then
  # First run ever — fire now
  /home/tcntryprd/boss-dev/scripts/keep-window.sh
  echo "$NOW" > "$LOCK"
  exit 0
fi

LAST=$(cat "$LOCK" 2>/dev/null || echo "0")
ELAPSED=$(( (NOW - LAST) / 60 ))

if [ "$ELAPSED" -ge 301 ]; then
  /home/tcntryprd/boss-dev/scripts/keep-window.sh
  echo "$NOW" > "$LOCK"
fi

#!/usr/bin/env bash
# rascals-reset.sh — kill each enabled rascal's tmux session and recreate
# via the boot script. Runs weekly (Sunday 3 AM) to keep CLI context fresh.
#
# Takes the global lock for the duration so wake crons can't collide.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ "${RASCALS_TEST_MODE:-0}" != "1" ] && [ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

rascals_log reset "=== reset run starting ==="

if ! rascals_acquire_lock 60; then
  rascals_log reset "ABORT — could not acquire lock within 60s"
  exit 1
fi
trap 'rascals_release_lock' EXIT

registry="$(rascals_fetch_registry)" || {
  rascals_log reset "API unreachable — skipping reset"
  exit 0
}

if [ -z "$registry" ]; then
  rascals_log reset "nothing to reset — no enabled rascals"
  exit 0
fi

while IFS='|' read -r handle _cli _project; do
  [ -z "$handle" ] && continue
  if tmux has-session -t "$handle" 2>/dev/null; then
    rascals_log reset "killing session ${handle}"
    tmux kill-session -t "$handle" || true
  else
    rascals_log reset "no existing session for ${handle} — skipping kill"
  fi
done <<< "$registry"

# Recreate via boot. Boot is idempotent and fetches the registry itself.
# Release the lock before invoking boot so boot has a clean environment.
rascals_release_lock

rascals_log reset "invoking boot to recreate sessions"
"$SCRIPT_DIR/little-rascals-boot.sh"

rascals_log reset "=== reset run complete ==="

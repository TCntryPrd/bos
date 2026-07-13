#!/bin/bash
# safe-rebuild.sh — rebuild + restart Vasari-BOS services with AUTO-REVERT so the
# container ALWAYS comes back up. Never a lockout. Use this for EVERY rebuild/restart
# (by a human, the COO, or the self-healing engineer). Image-based revert: the current
# working image is tagged :last-good before building; if the new image is unhealthy on
# boot, we roll back to :last-good and bring it up again.
#
# Usage:  safe-rebuild.sh [service ...]      (default: api web)
# Exit:   0 = new build healthy | 1 = build failed (nothing changed) | 2 = reverted to last-good
set -uo pipefail
R=/docker/hermes-agent-epgg
cd "$R" || exit 1
SERVICES="${*:-api web}"
LOG=/home/tcntryprd/logs/safe-rebuild.log
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p /home/tcntryprd/logs
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

# Tell the container-watchdog to stand down while we rebuild (our own health-gate +
# auto-revert handle the startup window). Flag is cleared on exit no matter what.
touch /home/tcntryprd/logs/.rebuilding
trap 'rm -f /home/tcntryprd/logs/.rebuilding' EXIT

say "safe-rebuild START services=[$SERVICES] ts=$ts"

# 1. Tag the CURRENT (working) image of each service as :last-good so we can roll back.
declare -A HADTAG
for s in $SERVICES; do
  img="hermes-agent-epgg-$s"
  if docker image inspect "$img:latest" >/dev/null 2>&1; then
    docker tag "$img:latest" "$img:last-good" && HADTAG[$s]=1
    say "tagged $img:latest -> $img:last-good"
  else
    say "no current $img:latest to tag (first build?)"
  fi
done

# 2. Build (this is the tsc gate). If build fails, NOTHING was swapped — old container runs on.
if ! docker compose build $SERVICES >>"$LOG" 2>&1; then
  say "BUILD FAILED — old containers untouched and still running. No lockout."
  exit 1
fi
say "build OK"

# 3. Bring up the new image.
docker compose up -d $SERVICES >>"$LOG" 2>&1

# 4. Health gate: wait up to ~100s for every service to be running and (if it has a
#    healthcheck) healthy. 'starting'/'unhealthy'/not-running all count as not-yet-good.
check_ok() {
  for s in $SERVICES; do
    c="hermes-agent-epgg-$s-1"
    run=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
    [ "$run" = "true" ] || return 1
    hc=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)
    [ "$hc" = "starting" ] && return 1
    [ "$hc" = "unhealthy" ] && return 1
  done
  return 0
}
HEALTHY=1
for i in $(seq 1 50); do
  if check_ok; then HEALTHY=0; break; fi
  sleep 2
done

if [ "$HEALTHY" -eq 0 ]; then
  say "rebuild HEALTHY — $SERVICES are up on the new image."
  exit 0
fi

# 5. REVERT: the new image is unhealthy. Roll each service back to :last-good and bring it up.
say "UNHEALTHY after rebuild — REVERTING to :last-good to avoid a lockout."
for s in $SERVICES; do
  img="hermes-agent-epgg-$s"
  if [ "${HADTAG[$s]:-0}" = "1" ]; then
    docker tag "$img:last-good" "$img:latest"
    say "rolled back $img:latest <- :last-good"
  fi
done
docker compose up -d $SERVICES >>"$LOG" 2>&1
# confirm the reverted version is healthy
for i in $(seq 1 50); do check_ok && { say "REVERTED — $SERVICES back up on last-good."; exit 2; }; sleep 2; done
say "WARNING: still not healthy after revert — manual attention needed."
exit 3

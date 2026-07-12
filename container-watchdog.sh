#!/bin/bash
# container-watchdog.sh — runs every minute (host cron, so it survives container failures).
# Verifies every BOS container is RUNNING and GREEN (healthy). Restarts any that are
# down or unhealthy so a container never stays hung after a rebuild/crash. Escalates to
# Kevin only if a container will not recover after several attempts (failed self-heal).
#
# Pairs with safe-rebuild.sh: that reverts a bad DEPLOY; this keeps everything STANDING.
set -uo pipefail
R=/docker/hermes-agent-qtbk
LOG=/home/tcntryprd/logs/container-watchdog.log
STATE=/home/tcntryprd/logs/watchdog-state
ESC=/home/tcntryprd/logs/watchdog-escalated
mkdir -p /home/tcntryprd/logs
exec 9>/home/tcntryprd/logs/.watchdog.lock; flock -n 9 || exit 0   # no overlap
say(){ echo "[$(date -u +%F\ %H:%M:%S)] $*" >> "$LOG"; }

# Skip while a safe-rebuild is mid-flight (its own health-gate handles startup/revert).
if [ -f /home/tcntryprd/logs/.rebuilding ] && [ "$(( $(date +%s) - $(stat -c %Y /home/tcntryprd/logs/.rebuilding 2>/dev/null || echo 0) ))" -lt 180 ]; then
  exit 0
fi

# Every container in the hermes-agent-qtbk compose project.
mapfile -t CONTAINERS < <(docker ps -a --filter "name=hermes-agent-qtbk-" --format '{{.Names}}')
[ "${#CONTAINERS[@]}" -eq 0 ] && { say "no hermes-agent-qtbk containers found"; exit 0; }

tg_alert() {
  local msg="$1"
  local tok; tok=$(docker exec hermes-agent-qtbk-postgres-1 psql -U boss -d boss_ir -t -A -c "SELECT value FROM runtime_config WHERE key='TELEGRAM_BOT_TOKEN'" 2>/dev/null | tr -d '[:space:]')
  [ -n "$tok" ] && curl -s -m 15 "https://api.telegram.org/bot$tok/sendMessage" --data-urlencode "chat_id=8558439226" --data-urlencode "text=$msg" >/dev/null 2>&1
}

ALL_GREEN=1
for c in "${CONTAINERS[@]}"; do
  run=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
  hc=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)
  status=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo unknown)
  # GREEN = running AND not unhealthy. 'starting' is transient -> leave it (don't fight startup).
  if [ "$run" = "true" ] && [ "$hc" != "unhealthy" ]; then
    sed -i "/^$c /d" "$STATE" 2>/dev/null || true   # reset its failure count
    continue
  fi
  ALL_GREEN=0
  n=$(awk -v c="$c" '$1==c{print $2}' "$STATE" 2>/dev/null); n=${n:-0}; n=$((n+1))
  sed -i "/^$c /d" "$STATE" 2>/dev/null || true; echo "$c $n" >> "$STATE"
  say "$c NOT GREEN (status=$status running=$run health=$hc) consecutive=$n -> restarting"
  docker restart "$c" >>"$LOG" 2>&1 || (cd "$R" && sudo docker compose up -d >>"$LOG" 2>&1)
  if [ "$n" -ge 4 ]; then
    if ! grep -qx "$c" "$ESC" 2>/dev/null; then
      say "$c failed to recover after $n attempts -> ESCALATING to Kevin"
      tg_alert "BOS WATCHDOG: container $c is down/unhealthy and has NOT recovered after $n restart attempts (status=$status, health=$hc). Needs a look."
      echo "$c" >> "$ESC"
    fi
  fi
done

if [ "$ALL_GREEN" = "1" ]; then
  : > "$STATE" 2>/dev/null || true
  : > "$ESC" 2>/dev/null || true   # clear escalation latches when everything is green again
fi
exit 0

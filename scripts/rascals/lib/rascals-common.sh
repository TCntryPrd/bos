#!/usr/bin/env bash
# rascals-common.sh — shared helpers for the Little Rascals scripts.
# Source, don't execute: `source /path/to/rascals-common.sh`.

set -u

: "${BOSS_API_URL:=http://127.0.0.1:8001}"
: "${BOSS_TENANT_ID:=default}"
: "${RASCALS_ROOT:=/home/tcntryprd/rascals}"
: "${RASCALS_LOCK:=${RASCALS_ROOT}/locks/little-rascals.lock}"
: "${RASCALS_LOG_DIR:=${RASCALS_ROOT}/logs}"

# rascals_log <name> <message ...>
#   Appends "[ISO8601] <message>" to $RASCALS_LOG_DIR/<name>.log.
rascals_log() {
  local name="${1:-default}"; shift || true
  local msg="$*"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$RASCALS_LOG_DIR"
  printf '[%s] %s\n' "$ts" "$msg" >> "$RASCALS_LOG_DIR/${name}.log"
}

# rascals_fetch_registry
#   GET /api/agents/rascals?enabled=true — emits pipe-delimited lines
#   "<handle>|<cli>|<projectDir>", one per active rascal.
#   On API failure: returns non-zero with empty stdout. Callers should treat
#   that as "no rascals to act on right now" and exit cleanly.
rascals_fetch_registry() {
  local url="${BOSS_API_URL%/}/api/agents/rascals?enabled=true"
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" RETURN
  if ! curl -sS --max-time 10 \
      -H 'X-BOSS-Internal: true' \
      -H "X-Tenant-ID: ${BOSS_TENANT_ID}" \
      "$url" > "$tmp"; then
    return 22
  fi
  python3 - "$tmp" <<'EOF' || return 23
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for r in data.get("rascals", []):
    print(f'{r["handle"]}|{r["cli"]}|{r["projectDir"]}')
EOF
}

# rascals_acquire_lock <timeout_sec>
#   Acquire exclusive flock on $RASCALS_LOCK, waiting up to <timeout_sec>
#   via flock -w (native blocking with timeout — handles signals, no busy-wait).
rascals_acquire_lock() {
  local timeout="${1:-60}"
  mkdir -p "$(dirname "$RASCALS_LOCK")"
  exec 200>"$RASCALS_LOCK"
  flock -w "$timeout" 200
}

# rascals_release_lock
#   Releases the lock acquired by rascals_acquire_lock.
rascals_release_lock() {
  flock -u 200 2>/dev/null || true
  exec 200>&- 2>/dev/null || true
}

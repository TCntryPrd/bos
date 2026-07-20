#!/usr/bin/env bash
# Idempotently add the secrets and non-secret host runtime values required by
# the guarded local memory and permanent agent runtime. Secret values are never
# printed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${BOSS_ENV_FILE:-$PROJECT_DIR/.env}"
RUNTIME_ENV="${BOSS_AGENT_RUNTIME_ENV:-/etc/boss-agent-runtime.env}"

fail() { printf '[boss-env] ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$ENV_FILE" == /* ]] || fail "BOSS_ENV_FILE must be an absolute path"
[[ -f "$ENV_FILE" ]] || fail ".env is missing: $ENV_FILE"
[[ ! -L "$ENV_FILE" ]] || fail "refusing to update a symlinked .env"

read_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      value=$0
      sub("^[[:space:]]*" key "=", "", value)
    }
    END {
      if (value ~ /^\047.*\047$/ || value ~ /^".*"$/) {
        value=substr(value, 2, length(value)-2)
      }
      printf "%s", value
    }
  ' "$ENV_FILE"
}

valid_value() {
  [[ -n "$2" && "$2" != *$'\n'* && "$2" != *$'\r'* && "$2" != *'#'* ]]
}

upsert() {
  local key="$1" value="$2" tmp
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid environment key"
  valid_value "$key" "$value" || fail "invalid value for $key"
  [[ "$(read_value "$key")" == "$value" ]] && return 0
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced=0 }
    $0 ~ "^[[:space:]]*" key "=" {
      if (!replaced) print key "=" value
      replaced=1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

new_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'
  fi
}

ensure_secret() {
  local key="$1" current
  current="$(read_value "$key")"
  if [[ ${#current} -lt 32 || "$current" =~ [[:space:]#] ]]; then
    upsert "$key" "$(new_secret)"
  fi
}

ensure_secret AIOS_EDGE_INGEST_TOKEN
ensure_secret AIOS_OAUTH_APPROVAL_CODE
ensure_secret WEAVIATE_API_KEY

# A BOS must keep its own stable namespace even when two installations happen
# to use the same tenant labels. The fresh installer supplies this from its
# domain; an in-place updater must either preserve the current value or be
# given one explicitly by the operator.
MEMORY_DEVICE_ID="${BOSS_MEMORY_DEVICE_ID:-$(read_value BOSS_MEMORY_DEVICE_ID)}"
[[ "$MEMORY_DEVICE_ID" =~ ^[a-z0-9][a-z0-9._-]{1,80}$ ]] \
  || fail "set a stable BOSS_MEMORY_DEVICE_ID (lowercase letters, numbers, . _ -)"
upsert BOSS_MEMORY_DEVICE_ID "$MEMORY_DEVICE_ID"

if [[ -f "$RUNTIME_ENV" ]]; then
  [[ "$(stat -c '%u' "$RUNTIME_ENV")" == 0 ]] || fail "runtime env must be root-owned: $RUNTIME_ENV"
  # This file is generated root-owned by install-agent-runtime.sh and uses
  # shell-safe quoted assignments so it can serve systemd and the bridge.
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
  BOSS_HOST_BRIDGE_HOST="$BOSS_AGENT_USER@host.docker.internal"
  BOSS_GIO_WORKSPACE_SOURCE="${BOSS_GIO_WORKSPACE_SOURCE:-$BOSS_INSTALL_DIR/gio-workspace}"
  [[ "$BOSS_AGENT_UID" =~ ^[0-9]+$ && "$BOSS_AGENT_GID" =~ ^[0-9]+$ ]] \
    || fail "runtime UID/GID must be numeric"
  [[ "$BOSS_AGENT_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "invalid runtime account"
  [[ "$BOSS_HOST_BRIDGE_HOST" =~ ^[a-z_][a-z0-9_-]{0,31}@host\.docker\.internal$ ]] \
    || fail "invalid bridge host"
  for path in "$BOSS_INSTALL_DIR" "$BOSS_AGENT_HOME" "$BOSS_AGENT_WORKSPACE_ROOT" \
    "$BOSS_AGENT_RASCALS_ROOT" "$BOSS_AGENT_OUTSIDERS_ROOT" "$BOSS_AGENT_COO_ROOT" \
    "$BOSS_HOST_BRIDGE_KEY_SOURCE" "$BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE" "$BOSS_GIO_WORKSPACE_SOURCE" \
    "$BOSS_API_EMPTY_CLAUDE_DIR" "$BOSS_API_EMPTY_CLAUDE_JSON"; do
    [[ "$path" == /* && "$path" != *[[:space:]]* ]] || fail "runtime paths must be absolute and whitespace-free"
  done
  for key in BOSS_INSTALL_DIR BOSS_AGENT_USER BOSS_AGENT_HOME BOSS_AGENT_UID BOSS_AGENT_GID \
    BOSS_AGENT_WORKSPACE_ROOT BOSS_AGENT_RASCALS_ROOT BOSS_AGENT_OUTSIDERS_ROOT \
    BOSS_AGENT_COO_ROOT BOSS_HOST_BRIDGE_HOST BOSS_HOST_BRIDGE_KEY_SOURCE \
    BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE \
    BOSS_GIO_WORKSPACE_SOURCE BOSS_API_EMPTY_CLAUDE_DIR BOSS_API_EMPTY_CLAUDE_JSON; do
    value="${!key:-}"
    valid_value "$key" "$value" || fail "$key is missing or unsafe in $RUNTIME_ENV"
    upsert "$key" "$value"
  done
fi

chmod 0600 "$ENV_FILE"
printf '[boss-env] Runtime settings and guarded-memory secrets are present.\n'

#!/usr/bin/env bash
# Run Docker Compose with the customer's files plus the API-only agent overlay.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

fail() { printf '[boss-compose] ERROR: %s\n' "$*" >&2; exit 1; }
absolute_file() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$PROJECT_DIR" "$1" ;;
  esac
}

BASE_FILE="$(absolute_file "${BOSS_COMPOSE_FILE:-docker-compose.yml}")"
OVERLAY_FILE="$(absolute_file "${BOSS_AGENT_COMPOSE_OVERLAY:-deploy/docker-compose.agent-runtime.yml}")"
WEAVIATE_GUARD_FILE="$(absolute_file "${BOSS_WEAVIATE_GUARD_OVERLAY:-deploy/docker-compose.weaviate-guard.yml}")"
WEAVIATE_INFRA_FILE="$(absolute_file "${BOSS_WEAVIATE_INFRA_OVERLAY:-deploy/docker-compose.memory-weaviate.yml}")"
EMBEDDINGS_INFRA_FILE="$(absolute_file "${BOSS_EMBEDDINGS_INFRA_OVERLAY:-deploy/docker-compose.memory-embeddings.yml}")"
OVERRIDE_SETTING="${BOSS_COMPOSE_OVERRIDE_FILE:-docker-compose.override.yml}"

[[ -f "$PROJECT_DIR/.env" ]] || fail ".env is missing in $PROJECT_DIR"
[[ -f "$BASE_FILE" ]] || fail "base compose file is missing: $BASE_FILE"
[[ -f "$OVERLAY_FILE" ]] || fail "agent runtime overlay is missing: $OVERLAY_FILE"

args=(--project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" -f "$BASE_FILE")
if [[ "$OVERRIDE_SETTING" != "-" ]]; then
  OVERRIDE_FILE="$(absolute_file "$OVERRIDE_SETTING")"
  if [[ -f "$OVERRIDE_FILE" && "$OVERRIDE_FILE" != "$BASE_FILE" && "$OVERRIDE_FILE" != "$OVERLAY_FILE" ]]; then
    args+=(-f "$OVERRIDE_FILE")
  fi
fi
base_services="$(docker compose "${args[@]}" config --services 2>/dev/null)" \
  || fail "customer compose files are invalid"
if ! printf '%s\n' "$base_services" | grep -qx embeddings; then
  [[ -f "$EMBEDDINGS_INFRA_FILE" ]] || fail "embeddings overlay is missing: $EMBEDDINGS_INFRA_FILE"
  args+=(-f "$EMBEDDINGS_INFRA_FILE")
fi
if ! printf '%s\n' "$base_services" | grep -qx weaviate; then
  [[ -f "$WEAVIATE_INFRA_FILE" ]] || fail "Weaviate infrastructure overlay is missing: $WEAVIATE_INFRA_FILE"
  args+=(-f "$WEAVIATE_INFRA_FILE")
fi
[[ -f "$WEAVIATE_GUARD_FILE" ]] || fail "Weaviate guard overlay is missing: $WEAVIATE_GUARD_FILE"
args+=(-f "$WEAVIATE_GUARD_FILE")
args+=(-f "$OVERLAY_FILE")

exec docker compose "${args[@]}" "$@"

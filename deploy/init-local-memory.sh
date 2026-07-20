#!/usr/bin/env bash
# Initialize and verify the BOS-local guarded memory path.
#
# This script may create the CodexMemory class, but it never writes memory
# objects directly. Object ingestion and reindexing always pass through the
# token-protected API gateway so redaction, embedding, dedupe, and ledger rules
# remain in force.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

[[ -f .env ]] || { echo "[boss-memory] .env is missing" >&2; exit 1; }
bash "$PROJECT_DIR/deploy/bootstrap-runtime-env.sh" >/dev/null
env_value() {
  # Treat Compose .env as data, never shell code. Existing customer files can
  # legitimately contain unquoted whitespace in unrelated values.
  awk -v key="$1" '
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
  ' .env
}
AIOS_EDGE_INGEST_TOKEN="$(env_value AIOS_EDGE_INGEST_TOKEN)"
WEAVIATE_API_KEY="$(env_value WEAVIATE_API_KEY)"
[[ -n "$AIOS_EDGE_INGEST_TOKEN" ]] || { echo "[boss-memory] AIOS_EDGE_INGEST_TOKEN is required" >&2; exit 1; }
[[ -n "$WEAVIATE_API_KEY" ]] || { echo "[boss-memory] WEAVIATE_API_KEY is required" >&2; exit 1; }
[[ ${#AIOS_EDGE_INGEST_TOKEN} -ge 32 ]] || { echo "[boss-memory] edge token must be at least 32 characters" >&2; exit 1; }
[[ ${#WEAVIATE_API_KEY} -ge 32 ]] || { echo "[boss-memory] Weaviate key must be at least 32 characters" >&2; exit 1; }
MEMORY_READY_TIMEOUT="${MEMORY_READY_TIMEOUT:-600}"
MEMORY_REINDEX_MAX_PAGES="${MEMORY_REINDEX_MAX_PAGES:-10000}"
MEMORY_REINDEX_REQUEST_TIMEOUT="${MEMORY_REINDEX_REQUEST_TIMEOUT:-1800}"
[[ "$MEMORY_READY_TIMEOUT" =~ ^[0-9]+$ && "$MEMORY_REINDEX_MAX_PAGES" =~ ^[0-9]+$ \
  && "$MEMORY_REINDEX_REQUEST_TIMEOUT" =~ ^[0-9]+$ ]] \
  || { echo "[boss-memory] timeout/page settings must be whole numbers" >&2; exit 1; }

say() { printf '[boss-memory] %s\n' "$*"; }

api_curl() {
  bash "$PROJECT_DIR/deploy/compose-runtime.sh" exec -T api \
    curl --connect-timeout 5 --max-time 30 "$@"
}

say "Waiting for the local Weaviate service"
elapsed=0
until api_curl -fsS http://weaviate:8080/v1/.well-known/ready >/dev/null 2>&1; do
  (( elapsed >= MEMORY_READY_TIMEOUT )) && { echo "[boss-memory] Weaviate did not become ready" >&2; exit 1; }
  sleep 5
  elapsed=$((elapsed + 5))
done

WEAVIATE_AUTH_HEADER=''
if api_curl -fsS -H "Authorization: Bearer $WEAVIATE_API_KEY" http://weaviate:8080/v1/schema >/dev/null 2>&1; then
  WEAVIATE_AUTH_HEADER="Authorization: Bearer $WEAVIATE_API_KEY"
elif api_curl -fsS -H "X-API-Key: $WEAVIATE_API_KEY" http://weaviate:8080/v1/schema >/dev/null 2>&1; then
  WEAVIATE_AUTH_HEADER="X-API-Key: $WEAVIATE_API_KEY"
else
  echo "[boss-memory] Weaviate rejected its configured API key" >&2
  exit 1
fi

if ! api_curl -fsS -H "$WEAVIATE_AUTH_HEADER" \
  http://weaviate:8080/v1/schema/CodexMemory >/dev/null 2>&1; then
  say "Creating the canonical CodexMemory schema"
  api_curl -fsS -X POST http://weaviate:8080/v1/schema \
    -H "$WEAVIATE_AUTH_HEADER" \
    -H 'content-type: application/json' \
    --data-binary '{
      "class":"CodexMemory",
      "description":"BOS-local cognitive memory; guarded writes only",
      "vectorizer":"none",
      "properties":[
        {"name":"title","dataType":["text"]},
        {"name":"text","dataType":["text"]},
        {"name":"source","dataType":["text"]},
        {"name":"project","dataType":["text"]},
        {"name":"kind","dataType":["text"]},
        {"name":"cwd","dataType":["text"]},
        {"name":"session_id","dataType":["text"]},
        {"name":"turn_id","dataType":["text"]},
        {"name":"tags","dataType":["text"]},
        {"name":"stability","dataType":["text"]},
        {"name":"created_at","dataType":["date"]},
        {"name":"updated_at","dataType":["date"]}
      ]
    }' >/dev/null
fi

say "Waiting for the guarded gateway and local embeddings"
elapsed=0
until api_curl -fsS \
  -H "x-aios-edge-token: $AIOS_EDGE_INGEST_TOKEN" \
  --get --data-urlencode 'q=memory readiness check' --data-urlencode 'limit=1' \
  http://127.0.0.1:8001/api/aios/memory/search >/dev/null 2>&1; do
  (( elapsed >= MEMORY_READY_TIMEOUT )) && { echo "[boss-memory] guarded semantic search did not become ready" >&2; exit 1; }
  sleep 5
  elapsed=$((elapsed + 5))
done

say "Reindexing the guarded ledger through the API"
cursor=""
page=0
while :; do
  (( page >= MEMORY_REINDEX_MAX_PAGES )) \
    && { echo "[boss-memory] reindex exceeded the finite page limit" >&2; exit 1; }
  payload="{\"limit\":500,\"cursor\":\"$cursor\"}"
  response="$(api_curl --max-time "$MEMORY_REINDEX_REQUEST_TIMEOUT" -fsS -X POST \
    -H 'content-type: application/json' \
    -H "x-aios-edge-token: $AIOS_EDGE_INGEST_TOKEN" \
    --data-binary "$payload" \
    http://127.0.0.1:8001/api/aios/memory/reindex)"
  next_cursor="$(printf '%s' "$response" | python3 -c \
    'import json,sys; value=json.load(sys.stdin).get("nextCursor"); print(value or "")')" \
    || { echo "[boss-memory] invalid reindex response" >&2; exit 1; }
  [[ -z "$next_cursor" || "$next_cursor" =~ ^[a-f0-9]{64}$ ]] \
    || { echo "[boss-memory] invalid reindex cursor" >&2; exit 1; }
  [[ -z "$next_cursor" ]] && break
  [[ "$next_cursor" != "$cursor" ]] \
    || { echo "[boss-memory] reindex cursor did not advance" >&2; exit 1; }
  cursor="$next_cursor"
  page=$((page + 1))
done

health="$(api_curl -fsS http://127.0.0.1:8001/api/aios/memory/health)"
printf '[boss-memory] ready: %s\n' "$health"

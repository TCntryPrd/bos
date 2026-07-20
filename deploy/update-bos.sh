#!/usr/bin/env bash
# Portable in-place BOS updater for customer VPS installations.
#
# Stage a complete release tree first, preserving target-specific visuals, then
# run this script. It does not pull git, delete files, run compose down, or
# remove volumes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

say()  { printf '[bos-update] %s\n' "$*"; }
fail() { printf '[bos-update] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"; }

need docker
need python3
need sha256sum
need readlink
[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "run the customer updater as root"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"
[[ -f .env ]] || fail ".env is missing"
env_value() {
  # Docker Compose .env files are not necessarily shell sourceable (for
  # example, scope lists may contain unquoted spaces). Read exact assignments
  # without evaluating customer-controlled values.
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
if [[ -f /etc/boss-agent-runtime.env ]]; then
  # Root-owned installer state preserves a customer's existing account/roots.
  # shellcheck disable=SC1091
  set -a
  source /etc/boss-agent-runtime.env
  set +a
fi
: "${BOSS_AGENT_USER:?set BOSS_AGENT_USER or install the host runtime first}"

say "Refreshing the isolated permanent agent runtime"
BOSS_INSTALL_DIR="$PROJECT_DIR" bash "$PROJECT_DIR/deploy/install-agent-runtime.sh"
BOSS_ENV_FILE="$PROJECT_DIR/.env" bash "$PROJECT_DIR/deploy/bootstrap-runtime-env.sh" >/dev/null

say "Ensuring the guarded memory gateway is wired into this API"
python3 "$PROJECT_DIR/deploy/ensure-memory-gateway-route.py" \
  "$PROJECT_DIR/apps/api/src/server.ts"

bos_compose() { bash "$PROJECT_DIR/deploy/compose-runtime.sh" "$@"; }

POSTGRES_USER_VAL="$(env_value POSTGRES_USER)"
POSTGRES_USER_VAL="${POSTGRES_USER_VAL:-boss}"
POSTGRES_DB_VAL="$(env_value POSTGRES_DB)"
POSTGRES_DB_VAL="${POSTGRES_DB_VAL:-boss_ir}"
POSTGRES_PASSWORD_VAL="$(env_value POSTGRES_PASSWORD)"
[[ -n "$POSTGRES_PASSWORD_VAL" ]] || fail "POSTGRES_PASSWORD is required"
BOSS_VISUAL_MANIFEST="${BOSS_VISUAL_MANIFEST:-/var/lib/boss/visual-baseline.json}"
BOSS_HOST_BRIDGE_HOST="${BOSS_HOST_BRIDGE_HOST:-$BOSS_AGENT_USER@host.docker.internal}"
BOSS_HOST_BRIDGE_KEY_SOURCE="${BOSS_HOST_BRIDGE_KEY_SOURCE:-/var/lib/boss-agent-runtime/keys/boss-agent-runtime-bridge}"
BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE="${BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE:-/var/lib/boss-agent-runtime/known_hosts/boss-agent-runtime-known_hosts}"
POSTGRES_READY_TIMEOUT="${POSTGRES_READY_TIMEOUT:-180}"
COMPOSE_SETTLE_TIMEOUT="${COMPOSE_SETTLE_TIMEOUT:-180}"
UPDATE_ID="${DEPLOY_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$POSTGRES_READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail "POSTGRES_READY_TIMEOUT must be a whole number"
[[ "$COMPOSE_SETTLE_TIMEOUT" =~ ^[0-9]+$ ]] || fail "COMPOSE_SETTLE_TIMEOUT must be a whole number"

say "Verifying this target's protected visual baseline"
python3 scripts/visual-preserve.py verify --root "$PROJECT_DIR" --manifest "$BOSS_VISUAL_MANIFEST" \
  || fail "protected backgrounds/avatar bindings changed; containers were not replaced"
[[ -x /usr/local/libexec/boss-agent-runtime-bridge ]] \
  || fail "host agent runtime missing; run deploy/install-agent-runtime.sh first"
[[ -r "$BOSS_HOST_BRIDGE_KEY_SOURCE" ]] || fail "host bridge key missing: $BOSS_HOST_BRIDGE_KEY_SOURCE"
[[ -r "$BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE" && ! -L "$BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE" ]] \
  || fail "pinned host bridge known_hosts missing or unsafe: $BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE"

mapfile -t COMPOSE_SERVICES < <(bos_compose config --services)
has_service() { printf '%s\n' "${COMPOSE_SERVICES[@]}" | grep -qx "$1"; }

# Docker Compose can return from a detached `up` while the daemon is still
# finalizing a replacement.  Requiring the same running container ID on two
# successive polls keeps the later targeted recreation from racing an earlier
# general `up` that happened to replace api or web.
wait_for_compose_service_settle() {
  local service="$1" elapsed=0 observed="" current="" running=""
  while (( elapsed < COMPOSE_SETTLE_TIMEOUT )); do
    current="$(bos_compose ps -q "$service" 2>/dev/null || true)"
    running="$(docker inspect --format '{{.State.Running}}' "$current" 2>/dev/null || true)"
    if [[ -n "$current" && "$running" == true ]]; then
      [[ "$current" == "$observed" ]] && return 0
      observed="$current"
    else
      observed=""
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  fail "compose service '$service' did not settle into a running container"
}

infra=()
for service in postgres redis weaviate embeddings; do
  if has_service "$service"; then infra+=("$service"); fi
done
has_service postgres || fail "compose service 'postgres' is required"
has_service api || fail "compose service 'api' is required"

say "Starting stateful local services without replacing volumes"
bos_compose up -d "${infra[@]}"
elapsed=0
until bos_compose exec -T postgres pg_isready -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" >/dev/null 2>&1; do
  (( elapsed >= POSTGRES_READY_TIMEOUT )) && fail "Postgres did not become ready"
  sleep 2
  elapsed=$((elapsed + 2))
done

psql_exec() {
  bos_compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" "$@"
}
psql_query() {
  bos_compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" postgres \
    psql -tA -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" -c "$1"
}
psql_param_exec() {
  # psql variables are expanded for SQL read from stdin, not for a `-c`
  # command. Keep dynamic customer paths out of shell interpolation and use
  # psql's quoted variables at the SQL boundary.
  local sql="$1"
  shift
  printf '%s\n' "$sql" | bos_compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" postgres \
    psql -X -q -v ON_ERROR_STOP=1 "$@" -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL"
}

table_column_count() {
  psql_query "SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$1' AND column_name IN ($2);" | tr -d '[:space:]'
}

avatar_state() {
  local table exists avatar_columns id_columns pair_columns digest combined=""
  for table in boss_rascals boss_outsiders boss_advisors; do
    exists="$(psql_query "SELECT to_regclass('public.$table') IS NOT NULL;" | tr -d '[:space:]')"
    if [[ "$exists" != t ]]; then combined+="$table:absent|"; continue; fi
    avatar_columns="$(table_column_count "$table" "'avatar_png'")"
    if [[ "$avatar_columns" != 1 ]]; then combined+="$table:no-avatar|"; continue; fi
    id_columns="$(table_column_count "$table" "'id'")"
    pair_columns="$(table_column_count "$table" "'tenant_id','handle'")"
    if [[ "$id_columns" == 1 ]]; then
      digest="$(psql_query "SELECT md5(COALESCE(string_agg(
        COALESCE(to_jsonb(t)->>'id','') || E'\\x1f' ||
        COALESCE(to_jsonb(t)->>'avatar_png','<NULL>'), E'\\x1e' ORDER BY
        COALESCE(to_jsonb(t)->>'id','')),'')) FROM public.$table t;" | tr -d '[:space:]')"
    elif [[ "$pair_columns" == 2 ]]; then
      digest="$(psql_query "SELECT md5(COALESCE(string_agg(
        COALESCE(to_jsonb(t)->>'tenant_id','') || E'\\x1f' ||
        COALESCE(to_jsonb(t)->>'handle','') || E'\\x1f' ||
        COALESCE(to_jsonb(t)->>'avatar_png','<NULL>'), E'\\x1e' ORDER BY
        COALESCE(to_jsonb(t)->>'tenant_id',''), COALESCE(to_jsonb(t)->>'handle','')
      ),'')) FROM public.$table t;" | tr -d '[:space:]')"
    else
      fail "$table has avatar_png but no supported stable identity"
    fi
    combined+="$table:$digest|"
  done
  printf '%s' "$combined" | sha256sum | awk '{print $1}'
}

AVATAR_RESTORE="/tmp/bos-avatar-restore-$UPDATE_ID.sql"
: > "$AVATAR_RESTORE"
chmod 0600 "$AVATAR_RESTORE"
trap 'rm -f "$AVATAR_RESTORE"' EXIT
for table in boss_rascals boss_outsiders boss_advisors; do
  exists="$(psql_query "SELECT to_regclass('public.$table') IS NOT NULL;" | tr -d '[:space:]')"
  [[ "$exists" == t ]] || continue
  avatar_columns="$(table_column_count "$table" "'avatar_png'")"
  [[ "$avatar_columns" == 1 ]] || continue
  id_columns="$(table_column_count "$table" "'id'")"
  pair_columns="$(table_column_count "$table" "'tenant_id','handle'")"
  if [[ "$id_columns" == 1 ]]; then
    psql_query "SELECT format(
      'UPDATE public.$table SET avatar_png = %L WHERE id::text = %L;',
      to_jsonb(t)->>'avatar_png', to_jsonb(t)->>'id') FROM public.$table t
      ORDER BY to_jsonb(t)->>'id';" >> "$AVATAR_RESTORE"
  elif [[ "$pair_columns" == 2 ]]; then
    psql_query "SELECT format(
      'UPDATE public.$table SET avatar_png = %L WHERE tenant_id = %L AND handle = %L;',
      to_jsonb(t)->>'avatar_png', to_jsonb(t)->>'tenant_id', to_jsonb(t)->>'handle')
      FROM public.$table t ORDER BY to_jsonb(t)->>'tenant_id', to_jsonb(t)->>'handle';" >> "$AVATAR_RESTORE"
  else
    fail "$table has avatar_png but no supported stable identity"
  fi
done
AVATAR_BEFORE="$(avatar_state)"

say "Applying pending database migrations"
MIGRATION_DIR="$PROJECT_DIR/services/postgres/migrations"
[[ -d "$MIGRATION_DIR" ]] || fail "migration directory missing: $MIGRATION_DIR"
psql_exec -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" >/dev/null
applied_count="$(psql_query 'SELECT count(*) FROM schema_migrations;' | tr -d '[:space:]')"
tenants_exists="$(psql_query "SELECT to_regclass('public.tenants') IS NOT NULL;" | tr -d '[:space:]')"
if [[ "$applied_count" == 0 && "$tenants_exists" == t ]]; then
  for migration in "$MIGRATION_DIR"/*.sql; do
    filename="$(basename "$migration")"
    number="${filename%%_*}"
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    (( 10#$number < 39 )) || continue
    psql_exec -c "INSERT INTO schema_migrations(filename) VALUES ('$filename') ON CONFLICT DO NOTHING;" >/dev/null
  done
fi
while IFS= read -r migration; do
  filename="$(basename "$migration")"
  grep -q 'DO NOT RUN' "$migration" 2>/dev/null && continue
  applied="$(psql_query "SELECT 1 FROM schema_migrations WHERE filename='$filename';" | tr -d '[:space:]')"
  [[ "$applied" == 1 ]] && continue
  say "Applying $filename"
  psql_exec -f "$migration"
  psql_exec -c "INSERT INTO schema_migrations(filename) VALUES ('$filename');" >/dev/null
done < <(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' | sort)

safe_part() {
  local value="$1" fallback="$2" max="$3" safe
  safe="$(printf '%s' "$value" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-"$max")"
  printf '%s' "${safe:-$fallback}"
}
runtime_id() {
  local tenant_id="$1" kind="$2" handle="$3" tenant agent digest
  tenant="$(safe_part "$tenant_id" default 18)"
  agent="$(safe_part "$handle" agent 32)"
  digest="$(printf '%s' "$tenant_id" | sha256sum | awk '{print substr($1,1,10)}')"
  printf '%s-%s-%s-%s' "$kind" "$agent" "$tenant" "$digest"
}

# shellcheck disable=SC1091
source /etc/boss-agent-runtime.env
agent_rows_query="SELECT tenant_id || '|rascal|' || handle || '|' || project_dir
  FROM boss_rascals WHERE enabled UNION ALL
  SELECT tenant_id || '|outsider|' || handle || '|' || project_dir
  FROM boss_outsiders WHERE enabled ORDER BY 1;"
agent_rows="$(psql_query "$agent_rows_query")"

path_is_in_root() {
  local path="$1" root="$2" resolved root_resolved
  [[ -d "$path" && -d "$root" ]] || return 1
  resolved="$(readlink -f -- "$path")" || return 1
  root_resolved="$(readlink -f -- "$root")" || return 1
  [[ "$resolved" == "$root_resolved"/* ]]
}

say "Validating enabled-agent workspace bindings"
while IFS='|' read -r tenant_id kind handle project_dir; do
  [[ -n "$tenant_id" ]] || continue
  [[ "$handle" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "unsafe agent handle in database"
  if [[ "$kind" == rascal ]]; then
    table=boss_rascals
    root="$BOSS_AGENT_RASCALS_ROOT"
  elif [[ "$kind" == outsider ]]; then
    table=boss_outsiders
    root="$BOSS_AGENT_OUTSIDERS_ROOT"
  else
    fail "unsupported enabled agent kind: $kind"
  fi
  if path_is_in_root "$project_dir" "$root"; then continue; fi
  canonical="$root/$handle"
  path_is_in_root "$canonical" "$root" \
    || fail "$kind/$handle workspace is missing or unsafe; expected existing $canonical"
  say "Repairing the stored workspace for $kind/$handle to its existing canonical directory"
  psql_param_exec "UPDATE public.$table SET project_dir = :'project_dir', updated_at = now()
        WHERE tenant_id = :'tenant_id' AND handle = :'handle';" \
    -v tenant_id="$tenant_id" -v handle="$handle" -v project_dir="$canonical" >/dev/null
done <<< "$agent_rows"
agent_rows="$(psql_query "$agent_rows_query")"

# Register composite runtime IDs only after every stored path resolves inside
# the configured customer root. Existing directories and memory are untouched.
while IFS='|' read -r tenant_id kind handle project_dir; do
  [[ -n "$tenant_id" ]] || continue
  [[ -n "$project_dir" ]] || fail "enabled agent $kind/$handle has no project_dir"
  id="$(runtime_id "$tenant_id" "$kind" "$handle")"
  runuser -u "$BOSS_AGENT_USER" -- env HOME="$BOSS_AGENT_HOME" \
    BOSS_AGENT_RUNTIME_ENV=/etc/boss-agent-runtime.env \
    /usr/local/bin/boss-agent-shells ensure "$id" "$project_dir"
done <<< "$agent_rows"

say "Building and recreating changed BOS services"
bos_compose build
bos_compose up -d
# The API carries the host bridge/key bind mounts.  Wait for the general
# detached update to finish, then recreate each runtime-facing service
# serially and without dependencies.  This avoids Docker Compose retaining a
# stale container ID from the broad `up` and then failing the forced recreate
# with "No such container".
runtime_recreate_services=(api)
if has_service web; then
  runtime_recreate_services+=(web)
fi
for service in "${runtime_recreate_services[@]}"; do
  wait_for_compose_service_settle "$service"
done
for service in "${runtime_recreate_services[@]}"; do
  bos_compose up -d --no-deps --force-recreate "$service"
  wait_for_compose_service_settle "$service"
done

say "Waiting for the updated API"
ready=false
for _ in $(seq 1 60); do
  if bos_compose exec -T api curl --connect-timeout 5 --max-time 15 -fsS http://127.0.0.1:8001/health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 5
done
[[ "$ready" == true ]] || fail "updated API did not become healthy"

say "Reconciling permanent agent tmux shells"
while IFS='|' read -r tenant_id kind handle project_dir; do
  [[ -n "$tenant_id" ]] || continue
  [[ -n "$project_dir" ]] || fail "enabled agent $kind/$handle has no project_dir"
  id="$(runtime_id "$tenant_id" "$kind" "$handle")"
  reply="$(bos_compose exec -T api ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/data/home/.ssh/boss-agent-runtime-known_hosts \
    -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o IdentitiesOnly=yes \
    -i /data/home/.ssh/boss-agent-runtime-bridge "$BOSS_HOST_BRIDGE_HOST" \
    "agent-ensure $id $project_dir" 2>/dev/null || true)"
  echo "$reply" | grep -q '"ok":true' || fail "could not ensure shell for $kind/$handle: $reply"
  status="$(bos_compose exec -T api ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/data/home/.ssh/boss-agent-runtime-known_hosts \
    -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o IdentitiesOnly=yes \
    -i /data/home/.ssh/boss-agent-runtime-bridge "$BOSS_HOST_BRIDGE_HOST" \
    "agent-status $id" 2>/dev/null || true)"
  echo "$status" | grep -q '"exists":true' || fail "shell missing for $kind/$handle: $status"
done <<< "$agent_rows"

say "Verifying guarded BOS-local cognitive memory"
MEMORY_READY_TIMEOUT="${MEMORY_READY_TIMEOUT:-600}" bash ./deploy/init-local-memory.sh

turn_table="$(psql_query "SELECT to_regclass('public.boss_agent_turns') IS NOT NULL;" | tr -d '[:space:]')"
[[ "$turn_table" == t ]] || fail "boss_agent_turns is missing after migrations"

AVATAR_AFTER="$(avatar_state)"
if [[ "$AVATAR_AFTER" != "$AVATAR_BEFORE" ]]; then
  if [[ -s "$AVATAR_RESTORE" ]]; then psql_exec -f "$AVATAR_RESTORE"; fi
  fail "customer avatar selections drifted during update and were restored where possible"
fi
python3 scripts/visual-preserve.py verify --root "$PROJECT_DIR" --manifest "$BOSS_VISUAL_MANIFEST" \
  || fail "protected visual state changed during update"

say "Update complete; volumes, target visuals, avatar selections, and customer memory were preserved"
bos_compose ps

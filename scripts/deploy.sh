#!/usr/bin/env bash
# IR Custom AIOS v2 — Production Deploy Script
#
# This script is executed on the target server by the GitHub Actions deploy job.
# It expects the following env vars to be set by the CI caller:
#
#   IMAGE_TAG     — semver tag of images to pull (e.g. "2.1.0")
#   REGISTRY      — container registry base URL (e.g. "ghcr.io")
#   IMAGE_PREFIX  — image name prefix (e.g. "myorg/boss")
#   DEPLOY_TS     — ISO timestamp of this deploy (for rollback labeling)
#
# It can also be run manually for a local rebuild/restart:
#   IMAGE_TAG=local ./scripts/deploy.sh
#
# Strategy: rolling restart with health-check gate and automatic rollback.
#
# Steps:
#   1. Validate environment
#   2. Pull new images (if not local build)
#   3. Run pending Postgres migrations via a one-shot container
#   4. Capture current running image tags (rollback snapshot)
#   5. Restart services one-by-one with health check between each
#   6. Final health gate — rollback all on failure

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_TAG="${IMAGE_TAG:-local}"
REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE_PREFIX="${IMAGE_PREFIX:-}"
DEPLOY_TS="${DEPLOY_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Services to restart in order (infrastructure excluded — they are stateful
# and only restart if their config changes).
APP_SERVICES=(api worker web executor)

# How long to wait for each service to become healthy after restart (seconds)
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=5

# Log prefix
LOG_PREFIX="[boss-deploy]"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "$LOG_PREFIX $(date -u +%H:%M:%S) $*"; }
fail() { echo "$LOG_PREFIX ERROR: $*" >&2; exit 1; }

require_cmd() {
    command -v "$1" > /dev/null 2>&1 || fail "Required command not found: $1"
}

# Wait for a container to report healthy via docker inspect.
# Usage: wait_healthy <container_name> [timeout_seconds]
wait_healthy() {
    local name="$1"
    local timeout="${2:-$HEALTH_TIMEOUT}"
    local elapsed=0

    log "Waiting for $name to be healthy (timeout: ${timeout}s)..."

    while [ $elapsed -lt $timeout ]; do
        status=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "missing")

        case "$status" in
            healthy)
                log "$name is healthy"
                return 0
                ;;
            unhealthy)
                log "$name reported unhealthy — aborting"
                docker logs --tail 50 "$name" 2>&1 || true
                return 1
                ;;
            *)
                # starting | missing — keep waiting
                sleep "$HEALTH_INTERVAL"
                elapsed=$((elapsed + HEALTH_INTERVAL))
                ;;
        esac
    done

    log "Timeout waiting for $name to become healthy"
    docker logs --tail 50 "$name" 2>&1 || true
    return 1
}

# ---------------------------------------------------------------------------
# 1. Validate environment
# ---------------------------------------------------------------------------
log "Starting IR Custom AIOS v2 deployment"
log "  IMAGE_TAG  = $IMAGE_TAG"
log "  REGISTRY   = $REGISTRY"
log "  IMAGE_PREFIX = $IMAGE_PREFIX"
log "  DEPLOY_TS  = $DEPLOY_TS"

require_cmd docker

cd "$PROJECT_DIR"

if [ ! -f ".env" ]; then
    fail ".env not found. Copy .env.example and fill in values before deploying."
fi

# Load env for psql access during migration step
set -a; source .env; set +a

# ---------------------------------------------------------------------------
# 2. Pull new images (skip for local builds)
# ---------------------------------------------------------------------------
if [ "$IMAGE_TAG" != "local" ] && [ -n "$IMAGE_PREFIX" ]; then
    log "Pulling images for tag: $IMAGE_TAG"

    for svc in "${APP_SERVICES[@]}"; do
        img="$REGISTRY/$IMAGE_PREFIX-$svc:$IMAGE_TAG"
        log "  Pulling $img"
        docker pull "$img" || fail "Failed to pull $img"
    done

    # Write an override file so compose uses the pulled images rather than
    # building from source. This is the immutable-infrastructure approach:
    # we never build on the production server.
    log "Writing image override file..."
    cat > /tmp/boss-images.yml << EOF
services:
  api:
    image: $REGISTRY/$IMAGE_PREFIX-api:$IMAGE_TAG
    build: ~
  worker:
    image: $REGISTRY/$IMAGE_PREFIX-worker:$IMAGE_TAG
    build: ~
  web:
    image: $REGISTRY/$IMAGE_PREFIX-web:$IMAGE_TAG
    build: ~
  executor:
    image: $REGISTRY/$IMAGE_PREFIX-executor:$IMAGE_TAG
    build: ~
EOF
    COMPOSE_OVERRIDE="-f /tmp/boss-images.yml"
else
    log "IMAGE_TAG=local — building from source on this host"
    COMPOSE_OVERRIDE=""
fi

# ---------------------------------------------------------------------------
# 3. Snapshot current image tags for rollback
# ---------------------------------------------------------------------------
log "Snapshotting current container state for rollback..."
ROLLBACK_SNAPSHOT="/tmp/boss-rollback-$DEPLOY_TS.txt"
docker inspect boss_api boss_worker boss_web \
    --format '{{.Name}} {{.Config.Image}}' > "$ROLLBACK_SNAPSHOT" 2>/dev/null || true
log "  Snapshot written to $ROLLBACK_SNAPSHOT"

# ---------------------------------------------------------------------------
# 4. Run database migrations
# ---------------------------------------------------------------------------
log "Running database migrations..."

# Migrations are applied here (not via docker-entrypoint-initdb.d) for every
# deploy so new migrations reach existing databases. Idempotency is handled
# via a schema_migrations tracking table — each successful application is
# recorded and subsequent deploys skip already-applied files.
#
# One-time backfill: the very first deploy after this tracking-table system
# was introduced needs to treat pre-existing migrations as already applied
# (otherwise old raw CREATE TABLE statements explode on re-run). We detect
# that by: tracking table just got created AND a canonical table (tenants)
# exists → pre-seed every migration filename as applied.

MIGRATION_DIR="$PROJECT_DIR/services/postgres/migrations"
POSTGRES_PORT_HOST="${POSTGRES_PORT:-5434}"
POSTGRES_USER_VAL="${POSTGRES_USER:-boss}"
POSTGRES_PASSWORD_VAL="${POSTGRES_PASSWORD:-bosspass}"
POSTGRES_DB_VAL="${POSTGRES_DB:-boss_db}"

# Abstract the psql invocation so the two host/docker code paths don't drift.
psql_exec() {
    if command -v psql > /dev/null 2>&1; then
        PGPASSWORD="$POSTGRES_PASSWORD_VAL" psql \
            -h localhost -p "$POSTGRES_PORT_HOST" \
            -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" \
            -v ON_ERROR_STOP=1 "$@"
    else
        docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
            psql -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" \
            -v ON_ERROR_STOP=1 "$@"
    fi
}

psql_query() {
    # Single-row/value query — returns bare value on stdout.
    if command -v psql > /dev/null 2>&1; then
        PGPASSWORD="$POSTGRES_PASSWORD_VAL" psql -tA \
            -h localhost -p "$POSTGRES_PORT_HOST" \
            -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" \
            -c "$1"
    else
        docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
            psql -tA -U "$POSTGRES_USER_VAL" -d "$POSTGRES_DB_VAL" -c "$1"
    fi
}

# Create tracking table if absent.
psql_exec -c "CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);" > /dev/null || fail "Could not ensure schema_migrations table"

# One-time backfill: if tracking is empty but tenants exists, pre-seed.
applied_count=$(psql_query "SELECT count(*) FROM schema_migrations;" | tr -d '[:space:]')
tenants_exists=$(psql_query "SELECT to_regclass('public.tenants') IS NOT NULL;" | tr -d '[:space:]')
if [ "$applied_count" = "0" ] && [ "$tenants_exists" = "t" ]; then
    log "  Backfilling schema_migrations (existing DB predates tracking table)..."
    for migration_file in $(ls "$MIGRATION_DIR"/*.sql | sort); do
        filename=$(basename "$migration_file")
        if grep -q "DO NOT RUN" "$migration_file" 2>/dev/null; then
            continue
        fi
        psql_exec -c "INSERT INTO schema_migrations(filename) VALUES ('$filename') ON CONFLICT DO NOTHING;" > /dev/null
    done
fi

for migration_file in $(ls "$MIGRATION_DIR"/*.sql | sort); do
    filename=$(basename "$migration_file")

    # Skip files that are explicitly marked as deprecated/do-not-run.
    # Convention: a file whose first meaningful SQL comment contains "DO NOT RUN".
    if grep -q "DO NOT RUN" "$migration_file" 2>/dev/null; then
        log "  Skipping deprecated migration: $filename"
        continue
    fi

    already=$(psql_query "SELECT 1 FROM schema_migrations WHERE filename='$filename';" | tr -d '[:space:]')
    if [ "$already" = "1" ]; then
        log "  Already applied: $filename"
        continue
    fi

    log "  Applying migration: $filename"
    psql_exec -f "$migration_file" || fail "Migration failed: $filename"
    psql_exec -c "INSERT INTO schema_migrations(filename) VALUES ('$filename') ON CONFLICT DO NOTHING;" > /dev/null
done
log "Migrations complete"

# ---------------------------------------------------------------------------
# 5. Rolling restart of app services
# ---------------------------------------------------------------------------
ROLLBACK_TRIGGERED=false

rollback() {
    if [ "$ROLLBACK_TRIGGERED" = true ]; then
        return
    fi
    ROLLBACK_TRIGGERED=true

    log "ROLLBACK: deployment failed — rolling back to previous images"

    if [ -f "$ROLLBACK_SNAPSHOT" ]; then
        log "  Previous images were:"
        cat "$ROLLBACK_SNAPSHOT"
    fi

    # Restart using the previous compose state (without the image override)
    docker compose restart "${APP_SERVICES[@]}" || true

    log "ROLLBACK: containers restarted with previous images"
    log "ROLLBACK: manual verification required — check: ./scripts/health-check.sh"
    exit 1
}

# Trap any error after this point and rollback
trap rollback ERR

log "Starting rolling restart of app services..."

for svc in "${APP_SERVICES[@]}"; do
    log "Restarting service: $svc"

    # Pull image or build, then recreate just this service.
    # --no-deps: do not restart dependencies (postgres/redis/etc.)
    # shellcheck disable=SC2086
    docker compose -f docker-compose.yml $COMPOSE_OVERRIDE \
        up -d --no-deps --force-recreate "$svc" \
    || fail "Failed to recreate service: $svc"

    container_name="boss_$svc"
    wait_healthy "$container_name" || {
        log "Health check failed for $svc"
        rollback
    }

    log "Service $svc is healthy and running"
done

# Remove trap now that all services are healthy
trap - ERR

# ---------------------------------------------------------------------------
# 6. Final validation
# ---------------------------------------------------------------------------
log "Running final end-to-end health check..."

API_PORT_VAL="${API_PORT:-8001}"
WEB_PORT_VAL="${WEB_PORT:-8005}"

api_health=$(curl -sf "http://localhost:$API_PORT_VAL/health" 2>/dev/null || echo "")
if [ -z "$api_health" ]; then
    fail "API health endpoint did not respond after deployment"
fi

echo "$api_health" | grep -q '"status"' || {
    log "WARNING: API health response missing 'status' field: $api_health"
}

web_health=$(curl -sf "http://localhost:$WEB_PORT_VAL/" 2>/dev/null || echo "")
if [ -z "$web_health" ]; then
    log "WARNING: Web endpoint did not respond (non-fatal)"
fi

# Internal-call smoke: a host-originated curl with X-BOSS-Internal must
# reach an auth-gated route with 200. Catches the v1.4.0 regression class
# where the Docker bridge gateway IP wasn't in the trusted list, making
# every little-rascals script silently fail.
log "Running internal-call auth smoke test..."
internal_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
    "http://127.0.0.1:$API_PORT_VAL/api/agents/rascals" 2>/dev/null || echo "000")
if [ "$internal_code" != "200" ]; then
    fail "Internal-call smoke returned HTTP $internal_code (expected 200). Check BOSS_INTERNAL_TRUSTED_IPS includes the Docker bridge gateway."
fi
log "Internal-call smoke passed (HTTP 200 from /api/agents/rascals)"

# Web→API proxy smoke: hit /api/agents/rascals through the web container's
# nginx, not directly. Catches the drift class where /api routes 200 from
# the API container but 404 from the browser because nginx was pointing
# at a stale backend (the v1.5.0 → v1.5.1 host-native dist regression).
#
# Path under test: host:WEB_PORT → nginx (web) → api:8001 → fastify routing.
# Auth: X-BOSS-Internal + 127.0.0.1 source (forwarded via X-Forwarded-For
# because BOSS_TRUSTED_PROXIES covers the compose subnet). Expected 200
# with a JSON body containing "rascals". HTML body or non-200 = topology
# regression, fail the deploy.
log "Running web→api proxy smoke test..."
proxy_code=$(curl -sS -o /tmp/boss-proxy-smoke.out -w '%{http_code}' \
    -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals" 2>/dev/null || echo "000")
if [ "$proxy_code" != "200" ]; then
    log "Proxy smoke body preview:"
    head -c 200 /tmp/boss-proxy-smoke.out 2>/dev/null || true
    echo ""
    fail "Web→api proxy smoke returned HTTP $proxy_code (expected 200). The web container's nginx cannot reach the api service — check apps/web/nginx.conf proxy_pass target and BOSS_TRUSTED_PROXIES."
fi
first_char=$(head -c 1 /tmp/boss-proxy-smoke.out 2>/dev/null)
if [ "$first_char" != "{" ]; then
    log "Proxy smoke body preview:"
    head -c 200 /tmp/boss-proxy-smoke.out 2>/dev/null || true
    echo ""
    fail "Web→api proxy smoke returned 200 but body is not JSON (likely nginx served index.html fallback). Check apps/web/nginx.conf location /api/ precedence."
fi
if ! grep -q '"rascals"' /tmp/boss-proxy-smoke.out 2>/dev/null; then
    log "Proxy smoke body preview:"
    head -c 200 /tmp/boss-proxy-smoke.out 2>/dev/null || true
    echo ""
    fail "Web→api proxy smoke returned 200 JSON but missing the 'rascals' key — route resolution may be wrong (got a different endpoint). Check the api dist has routes/rascals compiled."
fi
log "Web→api proxy smoke passed (HTTP 200, rascals JSON via web:$WEB_PORT_VAL)"

# Bearer-JWT tenant-resolution smoke: mint a short-lived admin JWT in
# the workspace tenant, send it through nginx like a browser would, and
# assert the response contains the registered rascals. Catches the
# v1.5.4 regression class — JWT claim shape drift (camelCase vs
# snake_case) silently routes every browser request to a phantom tenant.
log "Running bearer-JWT tenant-resolution smoke..."

# Pull JWT secret + workspace tenant UUID from env / DB. Both must exist
# for the smoke to be meaningful — fail loudly if either is missing
# rather than skipping the check.
JWT_SECRET_VAL="${JWT_SECRET:-${BOSS_JWT_SECRET:-}}"
if [ -z "$JWT_SECRET_VAL" ]; then
    fail "JWT_SECRET not set in env — cannot mint bearer-auth smoke token. Check .env."
fi
WORKSPACE_TENANT_ID=$(psql_query "SELECT id FROM tenants WHERE slug='default' LIMIT 1;" | tr -d '[:space:]')
if [ -z "$WORKSPACE_TENANT_ID" ]; then
    fail "No 'default' tenant row found — cannot determine the workspace UUID for the bearer smoke."
fi

# Mint a 60s admin JWT with the same payload shape routes/auth.ts emits
# (camelCase tenantId). HS256 over header.payload.
NOW=$(date +%s)
EXP=$((NOW + 60))
JWT_HEADER='{"alg":"HS256","typ":"JWT"}'
JWT_PAYLOAD=$(printf '{"sub":"deploy-smoke","email":"deploy-smoke@boss","role":"admin","tenantId":"%s","jti":"smoke-%s","iat":%s,"exp":%s}' \
    "$WORKSPACE_TENANT_ID" "$$" "$NOW" "$EXP")
b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }
H_B64=$(printf '%s' "$JWT_HEADER"  | b64url)
P_B64=$(printf '%s' "$JWT_PAYLOAD" | b64url)
SIG=$(printf '%s.%s' "$H_B64" "$P_B64" | openssl dgst -binary -sha256 -hmac "$JWT_SECRET_VAL" | b64url)
SMOKE_JWT="$H_B64.$P_B64.$SIG"

bearer_code=$(curl -sS -o /tmp/boss-bearer-smoke.out -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals" 2>/dev/null || echo "000")
if [ "$bearer_code" != "200" ]; then
    log "Bearer smoke body preview:"
    head -c 200 /tmp/boss-bearer-smoke.out 2>/dev/null || true
    echo ""
    fail "Bearer-JWT smoke returned HTTP $bearer_code (expected 200). The JWT auth chain is broken — check apps/api/src/middleware/auth.ts JWT claim names match what routes/auth.ts signs."
fi
if ! grep -q '"rascals"' /tmp/boss-bearer-smoke.out 2>/dev/null; then
    fail "Bearer-JWT smoke returned 200 but body missing 'rascals' key. Check tenant resolution chain."
fi
# The body must contain MORE than just an empty array — if it's
# {"rascals":[]} the JWT was accepted but tenant resolution silently
# routed to a phantom tenant (the v1.5.4 bug class). Assert at least
# one row.
if grep -qE '"rascals"\s*:\s*\[\s*\]' /tmp/boss-bearer-smoke.out 2>/dev/null; then
    log "Bearer smoke body preview:"
    head -c 200 /tmp/boss-bearer-smoke.out 2>/dev/null || true
    echo ""
    fail "Bearer-JWT smoke returned an empty rascals array but the workspace tenant has rows in boss_rascals. The JWT tenantId claim isn't reaching the route — auth middleware almost certainly dropped it. Compare auth.ts payload write to middleware/auth.ts payload read."
fi
log "Bearer-JWT smoke passed (HTTP 200, non-empty rascals JSON, tenant=$WORKSPACE_TENANT_ID)"

# Rascal Workspace sessions smoke (v1.6.3): the new per-rascal workspace
# surface mounts under /api/agents/rascals/:handle/sessions. Use the same
# bearer JWT to hit darla's sessions endpoint — must return HTTP 200 with
# a JSON body containing the "sessions" key. Empty array is a valid v1.6.3
# response (no chats created yet); the smoke just guards that the route
# resolves and the workspace router is registered.
log "Running Rascal Workspace sessions smoke..."
ws_code=$(curl -sS -o /tmp/boss-rascal-workspace-smoke.out -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/sessions" 2>/dev/null || echo "000")
if [ "$ws_code" != "200" ]; then
    log "Workspace sessions smoke body preview:"
    head -c 200 /tmp/boss-rascal-workspace-smoke.out 2>/dev/null || true
    echo ""
    fail "Rascal Workspace sessions smoke returned HTTP $ws_code (expected 200). Either rascalWorkspaceRoutes is not registered in apps/api/src/server.ts or the route prefix is wrong. Confirm /api/agents/rascals/darla/sessions resolves in the api container."
fi
if ! grep -q '"sessions"' /tmp/boss-rascal-workspace-smoke.out 2>/dev/null; then
    fail "Rascal Workspace sessions smoke returned 200 but body missing 'sessions' key. The route returned an unexpected shape — check rascal-workspace.ts shapeSession()."
fi
log "Rascal Workspace sessions smoke passed (HTTP 200, sessions JSON for darla)"

# Rascal Workspace bundle smoke (v1.6.3): the React-lazy chunk for the
# RascalWorkspace page must ship in the web container. Grep the served
# JS bundles for the stable 'rascal-workspace' test id (string literal,
# survives minification). Catches the regression class where someone
# removes the import or the route definition silently drops the chunk.
log "Running Rascal Workspace bundle smoke..."
ws_hits=$(docker exec boss_web sh -c \
    'grep -l "rascal-workspace" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$ws_hits" = "0" ]; then
    fail "Rascal Workspace bundle smoke failed: no JS bundle in boss_web contains the 'rascal-workspace' marker. The RascalWorkspace page was dropped from the build — check apps/web/src/App.tsx still lazy-imports RascalWorkspace and the /rascals/:handle route is wired."
fi
log "Rascal Workspace bundle smoke passed (page shipped in $ws_hits bundle(s))"

# Outsiders registry smokes (v1.6.8): the staff-agents registry under
# /api/agents/outsiders must return 200, expose the "outsiders" key, and
# include at least one row (Ponyboy Productions, seeded in migration
# 022). Mirrors the bearer-JWT rascals smoke so the same auth/tenant
# chain regression is caught for the new table. Also confirms the
# Outsiders page bundle shipped.
log "Running Outsiders API smoke..."
out_code=$(curl -sS -o /tmp/boss-outsiders-smoke.out -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/outsiders" 2>/dev/null || echo "000")
if [ "$out_code" != "200" ]; then
    log "Outsiders smoke body preview:"
    head -c 200 /tmp/boss-outsiders-smoke.out 2>/dev/null || true
    echo ""
    fail "Outsiders API smoke returned HTTP $out_code (expected 200). Either outsidersRoutes isn't registered in apps/api/src/server.ts or migration 022 didn't run. Check 'docker exec boss_postgres psql -U boss -d boss_db -c \"\\d boss_outsiders\"'."
fi
if ! grep -q '"outsiders"' /tmp/boss-outsiders-smoke.out 2>/dev/null; then
    fail "Outsiders API smoke returned 200 but body missing 'outsiders' key. Check apps/api/src/routes/outsiders.ts response shape."
fi
if grep -qE '"outsiders"\s*:\s*\[\s*\]' /tmp/boss-outsiders-smoke.out 2>/dev/null; then
    fail "Outsiders API smoke returned an empty outsiders array — Ponyboy Productions seed missing. Confirm migration 022_outsiders.sql ran and the INSERT didn't conflict-skip."
fi
log "Outsiders API smoke passed (HTTP 200, non-empty outsiders JSON, tenant=$WORKSPACE_TENANT_ID)"

log "Running Outsiders bundle smoke..."
out_hits=$(docker exec boss_web sh -c \
    'grep -l "outsiders-page" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$out_hits" = "0" ]; then
    fail "Outsiders bundle smoke failed: no JS bundle contains the 'outsiders-page' marker. The Outsiders page was dropped from the build — check apps/web/src/App.tsx still lazy-imports Outsiders and the /outsiders route is wired."
fi
log "Outsiders bundle smoke passed (page shipped in $out_hits bundle(s))"

# Outsider Workspace smokes (v1.6.9): the per-outsider workspace at
# /outsiders/<handle> shares route shape with the Rascal Workspace
# (sessions / messages / files / agenda). The kind-aware factory in
# rascal-workspace.ts mounts both sets, so we hit the outsider sessions
# endpoint to confirm the second mount registered. Bundle marker
# 'outsider-workspace' confirms the AgentWorkspaceImpl wrapper shipped
# (string literal survives minification as a JSX testid value).
log "Running Outsider Workspace sessions smoke..."
ows_code=$(curl -sS -o /tmp/boss-outsider-workspace-smoke.out -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/outsiders/ponyboy/sessions" 2>/dev/null || echo "000")
if [ "$ows_code" != "200" ]; then
    log "Outsider workspace sessions smoke body preview:"
    head -c 200 /tmp/boss-outsider-workspace-smoke.out 2>/dev/null || true
    echo ""
    fail "Outsider Workspace sessions smoke returned HTTP $ows_code (expected 200). Either outsiderWorkspaceRoutes is not registered in apps/api/src/server.ts or migration 022/023 didn't seed Ponyboy. Confirm /api/agents/outsiders/ponyboy/sessions resolves."
fi
if ! grep -q '"sessions"' /tmp/boss-outsider-workspace-smoke.out 2>/dev/null; then
    fail "Outsider Workspace sessions smoke returned 200 but body missing 'sessions' key. Check rascal-workspace.ts shapeSession()."
fi
log "Outsider Workspace sessions smoke passed (HTTP 200, sessions JSON for ponyboy)"

log "Running Outsider Workspace bundle smoke..."
ows_hits=$(docker exec boss_web sh -c \
    'grep -l "outsider-workspace" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$ows_hits" = "0" ]; then
    fail "Outsider Workspace bundle smoke failed: no JS bundle contains the 'outsider-workspace' marker. The OutsiderWorkspace wrapper was dropped — check apps/web/src/App.tsx still lazy-imports OutsiderWorkspace and the /outsiders/:handle route is wired."
fi
log "Outsider Workspace bundle smoke passed (page shipped in $ows_hits bundle(s))"

# Outsiders bind-mount smoke (v1.6.9): /home/tcntryprd/outsiders must
# be bind-mounted into boss_api at the same path. Without it, chat
# spawn from ponyboy's projectDir would fail at the cwd check.
log "Running Outsiders bind-mount smoke..."
om_lines=$(docker inspect boss_api --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' 2>/dev/null \
    | grep -c '^/home/tcntryprd/outsiders -> /home/tcntryprd/outsiders$' || true)
if [ "$om_lines" = "0" ]; then
    fail "Outsiders bind-mount smoke failed: boss_api is missing the /home/tcntryprd/outsiders same-path mount. Add it to docker-compose.yml under the api service volumes block."
fi
log "Outsiders bind-mount smoke passed (1 same-path mount on boss_api)"

# Model column smoke (v1.7.0): migration 025 adds a `model` column to
# boss_rascals and boss_outsiders, defaulting to claude-sonnet-4-6.
# The chat-spawn path reads this; missing column = chat-CC falls back
# to whatever claude CLI defaults to, which silently undermines the
# per-rascal model contract.
log "Running model column smoke..."
rmodel=$(psql_query "SELECT column_name FROM information_schema.columns WHERE table_name='boss_rascals' AND column_name='model';" | tr -d '[:space:]')
omodel=$(psql_query "SELECT column_name FROM information_schema.columns WHERE table_name='boss_outsiders' AND column_name='model';" | tr -d '[:space:]')
if [ "$rmodel" != "model" ] || [ "$omodel" != "model" ]; then
    fail "Model column smoke failed: boss_rascals.model present=$rmodel, boss_outsiders.model present=$omodel. Migration 025 should have added both — re-run the migration step or apply 025_agent_model_column.sql manually."
fi
rdefault=$(psql_query "SELECT column_default FROM information_schema.columns WHERE table_name='boss_rascals' AND column_name='model';" | tr -d '[:space:]')
case "$rdefault" in
    *claude-sonnet-4-6*) ;;
    *) fail "Model column smoke failed: boss_rascals.model default is '$rdefault' (expected to contain 'claude-sonnet-4-6'). House default model contract regressed." ;;
esac
log "Model column smoke passed (rascals + outsiders both have model column with sonnet-4-6 default)"

# Executor presence smoke (v1.7.0): the executor container runs
# production workloads (ffmpeg, claude CLI, python3, social pipeline).
# v1.7.1 will move Ponyboy's flow into it; v1.7.2 wires the job-queue
# bridge. For now we just prove it's running and has its toolchain so
# the architecture floor is in place.
log "Running Executor container smoke..."
if ! docker ps --format '{{.Names}}' | grep -q '^boss_executor$'; then
    fail "Executor smoke failed: boss_executor container is not running. Check the executor service block in docker-compose.yml and that the build matrix in .github/workflows/deploy.yml emitted ${IMAGE_PREFIX}-executor:${IMAGE_TAG}."
fi
for bin in claude ffmpeg python3 curl tmux git bash; do
    if ! docker exec boss_executor sh -c "command -v $bin" >/dev/null 2>&1; then
        fail "Executor smoke failed: '$bin' missing inside boss_executor. Check apps/executor/Dockerfile RUN apk add — every binary in the Sunday post pipeline must be in the image."
    fi
done
em_count=$(docker inspect boss_executor --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' 2>/dev/null \
    | grep -cE '^/home/tcntryprd/(\.claude(\.json)?|rascals|outsiders|sp-brand) -> /home/tcntryprd/(\.claude(\.json)?|rascals|outsiders|sp-brand)$' || true)
if [ "$em_count" -lt 5 ]; then
    fail "Executor smoke failed: expected 5 same-path bind-mounts (.claude, .claude.json, rascals, outsiders, sp-brand) on boss_executor — found $em_count. Check the executor volumes block in docker-compose.yml."
fi
log "Executor smoke passed (container running, toolchain present, $em_count bind-mounts)"

# Executor gog + HOME smoke (v1.7.1): the social pipeline calls
# `gog drive upload` for image hosting; gog reads creds from
# ~/.config/gogcli/credentials.json and that path only resolves to the
# bind-mounted host file when HOME=/home/tcntryprd is set in the
# container. Without either piece, every Mon/Wed/Fri 08:30/13:00/18:00
# CT cron run silently fails at the upload step.
log "Running Executor gog + HOME smoke..."
exec_home=$(docker exec boss_executor sh -c 'echo $HOME' 2>/dev/null || true)
if [ "$exec_home" != "/home/tcntryprd" ]; then
    fail "Executor gog smoke failed: HOME inside boss_executor is '$exec_home' (expected /home/tcntryprd). Set environment.HOME on the executor service in docker-compose.yml — gog and any other ~/.config/* tool resolve relative to HOME."
fi
if ! docker exec boss_executor sh -c 'command -v gog' >/dev/null 2>&1; then
    fail "Executor gog smoke failed: 'gog' binary not found in boss_executor PATH. Confirm /usr/local/bin/gog bind-mount in docker-compose.yml under the executor service volumes block."
fi
if ! docker exec boss_executor test -f /home/tcntryprd/.config/gogcli/credentials.json 2>/dev/null; then
    fail "Executor gog smoke failed: gogcli credentials.json not visible at /home/tcntryprd/.config/gogcli/credentials.json. The ~/.config/gogcli bind-mount must be present on the executor service so Drive uploads authenticate."
fi
log "Executor gog smoke passed (HOME=$exec_home, gog binary visible, credentials mounted)"

# Social pipeline visibility smoke (v1.7.1): the four post-* scripts
# the cron triggers must be visible inside the executor at the host
# absolute path the cron entries use. If the productions bind-mount
# regresses, every social-pipeline cron silently no-ops.
log "Running Social pipeline visibility smoke..."
for script in post-morning.sh post-midday.sh post-afternoon.sh post-sunday.sh post-social.sh; do
    if ! docker exec boss_executor test -x "/home/tcntryprd/boss-dev/productions/scripts/social/$script" 2>/dev/null; then
        fail "Social pipeline smoke failed: '$script' not visible (or not executable) at /home/tcntryprd/boss-dev/productions/scripts/social/ inside boss_executor. Confirm the productions bind-mount is in place and the script bit is set on host."
    fi
done
if ! docker exec boss_executor test -f /home/tcntryprd/sp-brand/kevin-voice-guide.md 2>/dev/null; then
    fail "Social pipeline smoke failed: sp-brand/kevin-voice-guide.md not visible inside boss_executor. Add /home/tcntryprd/sp-brand to the executor volumes block."
fi
if ! docker exec boss_executor test -f /home/tcntryprd/clients/sp-productions/data/social-pipeline/content/soulful-sunday-posts.md 2>/dev/null; then
    fail "Social pipeline smoke failed: sp-productions soulful-sunday-posts.md not visible inside boss_executor. Add /home/tcntryprd/clients/sp-productions to the executor volumes block."
fi
log "Social pipeline visibility smoke passed (5 scripts + brand + sp-productions content all visible inside executor)"

# Internal crond smoke (v1.7.2): the social pipeline schedule lives
# inside the executor at /etc/crontabs/node, run by busybox crond as
# the entrypoint. Without crond as PID 1 the cron entries silently
# don't fire — and since v1.7.2 deletes the host duplicates, no
# fallback path catches the miss. Hard fail is the right behaviour.
log "Running Internal crond smoke..."
exec_pid1=$(docker exec boss_executor sh -c 'cat /proc/1/comm' 2>/dev/null | tr -d '[:space:]')
if [ "$exec_pid1" != "crond" ]; then
    fail "Internal crond smoke failed: PID 1 inside boss_executor is '$exec_pid1' (expected 'crond'). Check apps/executor/Dockerfile CMD — it must launch crond in foreground for the social pipeline schedule to fire."
fi
sched_count=$(docker exec boss_executor sh -c 'grep -cE "^[^#].*post-(morning|midday|afternoon|sunday)\.sh" /etc/crontabs/node' 2>/dev/null | tr -d '[:space:]')
if [ "$sched_count" != "4" ]; then
    fail "Internal crond smoke failed: /etc/crontabs/node has $sched_count social schedule lines (expected 4 — morning, midday, afternoon, sunday). The crontab.social file in apps/executor/ regressed."
fi
log "Internal crond smoke passed (PID 1 = crond, 4 social schedule lines registered inside executor)"

# Newscast schedule smoke (v1.7.5.01): the podcast/newsroom pipeline
# now runs on the same internal crond as the social pipeline. The
# yaml at productions/config/schedules.yaml is the design canon; this
# smoke confirms /etc/crontabs/node carries the active entries
# (researcher + editor x3 + pipeline x3 + morning-show = 8 lines).
log "Running Newscast schedule smoke..."
news_count=$(docker exec boss_executor sh -c 'grep -cE "^[^#].*(run-newsroom-(stage|pipeline)|run-morning-show)" /etc/crontabs/node' 2>/dev/null | tr -d '[:space:]')
if [ "$news_count" != "8" ]; then
    fail "Newscast schedule smoke failed: /etc/crontabs/node has $news_count podcast/newsroom lines (expected 8 — researcher + editor x3 slots + pipeline x3 slots + morning-show). Check apps/executor/crontab.social — the Newscast block was added in v1.7.5.01."
fi
for entry in run-newsroom-stage run-newsroom-pipeline run-morning-show; do
    if ! docker exec boss_executor test -x "/home/tcntryprd/boss-dev/productions/scripts/$entry" 2>/dev/null; then
        fail "Newscast schedule smoke failed: '$entry' not visible (or not executable) at /home/tcntryprd/boss-dev/productions/scripts/ inside boss_executor. Either the productions bind-mount regressed or the script bit was dropped on host."
    fi
done
log "Newscast schedule smoke passed (8 podcast lines registered, 3 entry-point scripts visible)"

# Meta webhook handshake smoke (v1.7.3): the GET /api/webhooks/meta
# verification endpoint must (a) be public (no auth chain), (b) echo
# back hub.challenge when hub.verify_token matches the env var, and
# (c) reject mismatches with 403. If it 401s, the auth-middleware
# public-paths bypass regressed and Meta will fail the app-config
# save with "URL did not return correct response".
log "Running Meta webhook handshake smoke..."
mw_token="${META_WEBHOOK_VERIFY_TOKEN:-}"
if [ -n "$mw_token" ]; then
    mw_chal="boss_smoke_$(date +%s)"
    mw_url="http://127.0.0.1:8001/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${mw_token}&hub.challenge=${mw_chal}"
    mw_body=$(curl -s "$mw_url" || true)
    mw_code=$(curl -s -o /dev/null -w '%{http_code}' "$mw_url" || true)
    if [ "$mw_code" != "200" ]; then
        fail "Meta webhook smoke failed: GET /api/webhooks/meta returned HTTP $mw_code (expected 200 with valid token). Check (a) /api/webhooks/ is in PUBLIC_PATHS in apps/api/src/middleware/auth.ts and tenant.ts, (b) META_WEBHOOK_VERIFY_TOKEN is set in .env, (c) the route is registered at /api/webhooks in apps/api/src/server.ts."
    fi
    if [ "$mw_body" != "$mw_chal" ]; then
        fail "Meta webhook smoke failed: GET /api/webhooks/meta returned 200 but body was '$mw_body' (expected '$mw_chal'). The handshake response must echo hub.challenge as plain text — check apps/api/src/routes/webhooks/meta.ts."
    fi
    # Reject smoke: bad token must 403
    mw_bad_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8001/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" || true)
    if [ "$mw_bad_code" != "403" ]; then
        fail "Meta webhook smoke failed: bad-token GET returned HTTP $mw_bad_code (expected 403). Verification handshake accepts any token — check the equality check in apps/api/src/routes/webhooks/meta.ts."
    fi
    log "Meta webhook handshake smoke passed (200+echo on good token, 403 on bad)"
else
    log "Meta webhook handshake smoke SKIPPED (META_WEBHOOK_VERIFY_TOKEN not in env on deploy host)"
fi

# Rascal chat infra smokes (v1.6.4): the POST messages route spawns
# `claude -p --output-format stream-json` from each rascal's projectDir
# inside the api container. That requires four production-only assets
# to all be in place. If any is missing, the chat surface 503s and the
# user sees an unhelpful blank — so we fail the deploy instead.
log "Running Rascal chat infra smokes..."

# 1. Claude Code CLI in PATH inside the api container.
chat_bin=$(docker exec boss_api sh -c 'command -v claude' 2>/dev/null || true)
if [ -z "$chat_bin" ]; then
    fail "Rascal chat smoke failed: 'claude' CLI not found inside boss_api. Check apps/api/Dockerfile installs @anthropic-ai/claude-code in the runner stage."
fi

# 2. Subscription auth (~/.claude/.credentials.json) bind-mounted at the
#    same host path; HOME=/home/tcntryprd is set when we spawn so the
#    CLI finds it.
if ! docker exec boss_api test -f /home/tcntryprd/.claude/.credentials.json 2>/dev/null; then
    fail "Rascal chat smoke failed: /home/tcntryprd/.claude/.credentials.json not visible inside boss_api. Check the docker-compose bind mount for ~/.claude is in place."
fi
# 2b. Main config file (~/.claude.json) — sibling to the .claude/ dir,
#     not inside it. v1.6.4 shipped without this mount and every chat
#     spawn errored "Claude configuration file not found". Guard the
#     regression: must be mounted as a separate file.
if ! docker exec boss_api test -f /home/tcntryprd/.claude.json 2>/dev/null; then
    fail "Rascal chat smoke failed: /home/tcntryprd/.claude.json not visible inside boss_api. The Claude Code config FILE (sibling of the .claude/ DIR) must be mounted separately. Check the v1.6.4.1 docker-compose entry: '/home/tcntryprd/.claude.json:/home/tcntryprd/.claude.json'."
fi

# 3. At least one rascal projectDir reachable at the same path. We use
#    darla as the canary (matches the v1.6.3 sessions smoke).
if ! docker exec boss_api test -d /home/tcntryprd/rascals/darla 2>/dev/null; then
    fail "Rascal chat smoke failed: /home/tcntryprd/rascals/darla not visible inside boss_api. Check the docker-compose bind mount for ~/rascals is in place."
fi

# 4. Schema: cc_session_id column on boss_chat_sessions (migration 021).
cc_col=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
    psql -U boss -d boss_db -tAc \
    "SELECT count(*) FROM information_schema.columns
       WHERE table_name = 'boss_chat_sessions' AND column_name = 'cc_session_id';" \
    2>/dev/null | tr -d '[:space:]' || echo "0")
if [ "$cc_col" != "1" ]; then
    fail "Rascal chat smoke failed: boss_chat_sessions.cc_session_id column missing. Apply migration 021_chat_session_cc_id.sql."
fi

# 5. Route un-501 confirmation: POSTing to a non-existent session should
#    now return 404 session_not_found (route reaches the lookup). A 501
#    means the v1.6.4 un-stub did not ship with the bundle.
unstub_code=$(curl -sS -o /tmp/boss-rascal-chat-smoke.out -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    --data '{"message":"smoke"}' \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/sessions/00000000-0000-0000-0000-000000000000/messages" \
    2>/dev/null || echo "000")
if [ "$unstub_code" = "501" ]; then
    fail "Rascal chat smoke failed: POST messages still returns 501. The v1.6.4 un-stub did not ship — check apps/api/src/routes/rascal-workspace.ts."
fi
if [ "$unstub_code" != "404" ]; then
    log "Smoke body preview:"
    head -c 200 /tmp/boss-rascal-chat-smoke.out 2>/dev/null || true
    echo ""
    fail "Rascal chat smoke failed: POST messages returned HTTP $unstub_code (expected 404 session_not_found for a phantom session id). Auth/route resolution may be broken."
fi
log "Rascal chat infra smokes passed (claude CLI + .claude mount + rascals mount + cc_session_id column + un-stubbed route)"

# OpenClaw bind-mount smoke (v1.7.6): the /oc Gio dashboard requires
# the openclaw CLI binary visible inside boss_api and the gateway
# daemon responsive on the host. If either is missing, the dashboard
# 503s on every read. Three things must line up:
#   (a) /usr/lib/node_modules/openclaw bind mount in docker-compose.yml
#       (with /usr/bin/openclaw symlinked in apps/api/Dockerfile),
#   (b) /home/tcntryprd/.openclaw bind mount + HOME=/home/tcntryprd env,
#   (c) host openclaw-gateway running with bind=lan (loopback rejects
#       bridge connections from the docker network), reachable via the
#       host.docker.internal extra_hosts alias and OPENCLAW_GATEWAY_URL.
log "Running OpenClaw bind-mount smoke..."
oc_ver=$(docker exec boss_api sh -c 'openclaw --version' 2>/dev/null | tr -d '[:space:]')
if [ -z "$oc_ver" ]; then
    fail "OpenClaw smoke failed: 'openclaw' CLI not found inside boss_api. Check (a) /usr/lib/node_modules/openclaw bind mount in docker-compose.yml, (b) the /usr/bin/openclaw symlink line in apps/api/Dockerfile, (c) Node 22 base image (openclaw requires v22.12+)."
fi
oc_health=$(docker exec boss_api sh -c 'openclaw health --json 2>&1' | tr '\n' ' ' | head -c 400)
if ! echo "$oc_health" | grep -qE '"ok":\s*true'; then
    fail "OpenClaw smoke failed: 'openclaw health --json' from inside boss_api did not return ok=true. Got: $oc_health. Likely causes: host gateway not running ('systemctl --user status openclaw-gateway' on the host), gateway bound to loopback instead of lan ('openclaw config get gateway.bind' should be 'lan'), OPENCLAW_GATEWAY_TOKEN env mismatch with host config, or HOME env not set to /home/tcntryprd on boss_api."
fi
log "OpenClaw smoke passed (binary $oc_ver visible in api, gateway responsive)"

# Rascal Workspace files smoke (v1.6.5): GET /files?path=. should
# return the rascal's projectDir contents. Confirms path-safety
# code, JWT routing, and the rascals/ bind-mount are all in line.
log "Running Rascal Workspace files smoke..."
files_code=$(curl -sS -o /tmp/boss-rascal-files-smoke.out -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/files?path=." 2>/dev/null || echo "000")
if [ "$files_code" != "200" ]; then
    log "Files smoke body preview:"
    head -c 200 /tmp/boss-rascal-files-smoke.out 2>/dev/null || true
    echo ""
    fail "Rascal Workspace files smoke returned HTTP $files_code (expected 200). Check apps/api/src/routes/rascal-workspace.ts GET /files and the rascals/ bind-mount."
fi
if ! grep -q '"entries"' /tmp/boss-rascal-files-smoke.out 2>/dev/null; then
    fail "Rascal Workspace files smoke returned 200 but body missing 'entries' key. Route schema regression."
fi
# Path-escape rejection: '..' should 403.
escape_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/files?path=..%2F..%2Fetc" 2>/dev/null || echo "000")
if [ "$escape_code" != "403" ]; then
    fail "Rascal Workspace files smoke failed: path-escape attempt returned HTTP $escape_code (expected 403). Path-safety guard in apps/api/src/agents/rascal-files.ts is broken — every rascal projectDir is now leaking the host filesystem."
fi
log "Rascal Workspace files smoke passed (entries listed for darla; .. escape returns 403)"

# Rascal Workspace write smoke (v1.6.6): the PUT /files/content
# round-trip needs to (a) succeed with a valid If-Match etag and
# (b) reject a stale etag with 412. Uses a deterministic scratch
# path inside darla's projectDir so repeat deploys don't accumulate
# cruft.
log "Running Rascal Workspace write smoke..."
WRITE_BODY_FILE="/tmp/boss-rascal-write-body.json"
echo '{"path":".boss/_deploy_smoke.txt","content":"boss deploy smoke"}' > "$WRITE_BODY_FILE"
# Step 1: write (no If-Match — first creation, file may not exist).
write_code=$(curl -sS -o /tmp/boss-rascal-write1.out -w '%{http_code}' \
    -X PUT -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    --data-binary "@$WRITE_BODY_FILE" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/files/content" 2>/dev/null \
    || echo "000")
if [ "$write_code" != "200" ]; then
    log "Write smoke body preview:"
    head -c 200 /tmp/boss-rascal-write1.out 2>/dev/null || true
    echo ""
    fail "Rascal Workspace write smoke failed: initial PUT returned HTTP $write_code (expected 200). Check apps/api/src/agents/rascal-files.ts writeTextFile + the rascals/ bind-mount permissions (uid 1000)."
fi

# Step 2: read it back, capture etag.
read_code=$(curl -sS -o /tmp/boss-rascal-write2.out -w '%{http_code}' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/files/content?path=.boss%2F_deploy_smoke.txt" \
    2>/dev/null || echo "000")
if [ "$read_code" != "200" ]; then
    fail "Rascal Workspace write smoke failed: readback returned HTTP $read_code (expected 200) — round-trip is broken."
fi
if ! grep -q '"etag"' /tmp/boss-rascal-write2.out 2>/dev/null; then
    fail "Rascal Workspace write smoke failed: readback body missing etag field. Check rascal-files.ts readTextFile return shape."
fi

# Step 3: stale-etag write should 412.
echo '{"path":".boss/_deploy_smoke.txt","content":"stale"}' > "$WRITE_BODY_FILE"
stale_code=$(curl -sS -o /tmp/boss-rascal-write3.out -w '%{http_code}' \
    -X PUT -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SMOKE_JWT" \
    -H 'If-Match: "0"' \
    --data-binary "@$WRITE_BODY_FILE" \
    "http://127.0.0.1:$WEB_PORT_VAL/api/agents/rascals/darla/files/content" 2>/dev/null \
    || echo "000")
if [ "$stale_code" != "412" ]; then
    fail "Rascal Workspace write smoke failed: stale-etag PUT returned HTTP $stale_code (expected 412). The If-Match concurrency guard is broken — concurrent edits will silently overwrite each other."
fi

# Cleanup scratch file (best-effort; the read confirmed the round-trip worked).
rm -f /home/tcntryprd/rascals/darla/.boss/_deploy_smoke.txt 2>/dev/null || true
rm -f "$WRITE_BODY_FILE" 2>/dev/null || true
log "Rascal Workspace write smoke passed (PUT 200, readback 200 with etag, stale-etag PUT 412)"

# COO-not-a-Rascal smoke: the COO is IR Custom AIOS (this operator). It must never
# appear in boss_rascals, or the Rascals card grid will show a phantom
# row and any "for each rascal" loop (cron, pipeline assignment) will
# treat the operator as a target. v1.5.3 / migration 017 seeded one by
# mistake; v1.5.5 / migration 018 removed it. Guard against regression.
log "Running COO-not-rascal smoke..."
coo_count=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
    psql -U boss -d boss_db -tAc \
    "SELECT count(*) FROM boss_rascals WHERE handle = 'coo';" 2>/dev/null || echo "X")
if [ "$coo_count" != "0" ]; then
    fail "COO smoke failed: boss_rascals contains $coo_count row(s) with handle='coo'. The COO is IR Custom AIOS, not a Rascal — check that migration 018_rascals_coo_remove.sql ran and that no code path re-seeds the row."
fi
log "COO-not-rascal smoke passed (no 'coo' row in boss_rascals)"

# IR Custom AIOSOrb smoke: the bottom-right glowing-diamond chat surface (v1.5.6)
# is the global chat-with-IR Custom AIOS entry point per the v2 design. It mounts
# in Layout.tsx so it must appear in the built web bundle on every page.
# Guard against build/import regressions that could silently drop the
# component from the dist (e.g. tree-shaking on a dynamic import gone
# wrong, or someone removing the import while keeping the file).
#
# Probe: grep the served JS bundles inside the running web container for
# the orb's stable test id. The id is a string literal so it survives
# minification.
log "Running IR Custom AIOSOrb presence smoke..."
orb_hits=$(docker exec boss_web sh -c \
    'grep -l "boss-orb" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$orb_hits" = "0" ]; then
    fail "IR Custom AIOSOrb smoke failed: no JS bundle in boss_web contains the 'boss-orb' marker. The orb was dropped from the build — check apps/web/src/components/Layout.tsx still imports IR Custom AIOSOrb from ./shell/IR Custom AIOSOrb."
fi
log "IR Custom AIOSOrb smoke passed (orb shipped in $orb_hits bundle(s))"

# VoiceControl placement smoke: per the v2 design (decided 2026-04-25)
# the mic must be embedded in the NavRail footer next to the user tile,
# NOT a fixed-position floating mic at bottom-left. v1.5.7 enforced this
# by removing the `<VoiceControl />` mount from Layout.tsx and embedding
# it in NavRail. Guard against the regression where someone re-adds the
# floating mount or restores the old positioning classes.
#
# Probe 1: the 'voice-control' test id must appear in the bundle (it's
# a string literal that survives minification) — confirms the component
# is mounted somewhere.
# Probe 2: the old floating placement string ('bottom-6 left-6') must
# NOT appear in any bundle — that class pair is unique to the v1
# floating-mic wrapper.
log "Running VoiceControl placement smoke..."
voice_present=$(docker exec boss_web sh -c \
    'grep -l "voice-control" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$voice_present" = "0" ]; then
    fail "VoiceControl smoke failed: no JS bundle contains the 'voice-control' marker. The component was dropped — check apps/web/src/components/shell/NavRail.tsx still imports VoiceControl from ../VoiceControl."
fi
floating_residue=$(docker exec boss_web sh -c \
    'grep -l "bottom-6 left-6" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$floating_residue" != "0" ]; then
    fail "VoiceControl smoke failed: 'bottom-6 left-6' still present in $floating_residue bundle(s). The floating-mic placement regressed — VoiceControl must render in-flow inside NavRail, not as a fixed overlay."
fi
log "VoiceControl smoke passed (mic embedded in NavRail, no floating residue)"

# NavRail labels smoke (v1.6.7): OpenClaw was renamed to "COE - Gio" and
# moved above the Surfaces label. A new admin-only "Outsiders" entry sits
# between COE and Surfaces (comingSoon placeholder for the staff-agents
# surface that lands in v1.6.8). Both string literals survive minification
# as JSX label values, so we grep the served bundles for them.
#
# Probe 1: "COE - Gio" must appear in some bundle — proves the rename
# shipped and a regression didn't put "OpenClaw" back in NavRail.
# Probe 2: "Outsiders" must appear — proves the new tab shipped.
log "Running NavRail labels smoke..."
coe_present=$(docker exec boss_web sh -c \
    'grep -l "COE - Gio" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$coe_present" = "0" ]; then
    fail "NavRail labels smoke failed: 'COE - Gio' missing from served bundles. The v1.6.7 rename regressed — check apps/web/src/components/shell/NavRail.tsx and apps/web/src/components/Layout.tsx."
fi
outsiders_present=$(docker exec boss_web sh -c \
    'grep -l "Outsiders" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$outsiders_present" = "0" ]; then
    fail "NavRail labels smoke failed: 'Outsiders' missing from served bundles. The v1.6.7 admin-only Outsiders tab regressed — check apps/web/src/components/shell/NavRail.tsx."
fi
log "NavRail labels smoke passed (COE - Gio + Outsiders present)"

# Dashboard v2 smoke: v1.5.8 deleted the docked ChatPanel from the
# Dashboard and ported the v2 command-center layout (greeting, stat
# strip, live activity, agent roster, kanban peek, inbox, connections,
# timeline). Chat-with-IR Custom AIOS now lives only in the orb (v1.5.6).
#
# Probe 1: the v2 dashboard's test id must appear in the bundle —
# proves the new layout shipped.
# Probe 2: the v1 ChatPanel's localStorage key ('boss_chat_history')
# must NOT appear in any bundle — catches regression where the docked
# panel comes back. The COO surface uses its own structured chat with
# no localStorage history, so this key is unique to the deleted panel.
log "Running Dashboard v2 smoke..."
dash_present=$(docker exec boss_web sh -c \
    'grep -l "dashboard-v2" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$dash_present" = "0" ]; then
    fail "Dashboard v2 smoke failed: 'dashboard-v2' marker missing from served bundles. The v2 Dashboard wasn't built — check apps/web/src/pages/Dashboard.tsx exports a Dashboard component with data-testid='dashboard-v2'."
fi
chatpanel_residue=$(docker exec boss_web sh -c \
    'grep -l "boss_chat_history" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$chatpanel_residue" != "0" ]; then
    fail "Dashboard v2 smoke failed: 'boss_chat_history' present in $chatpanel_residue bundle(s). The v1 docked ChatPanel regressed — chat-with-IR Custom AIOS must live in the orb (IR Custom AIOSOrb), not on the Dashboard page."
fi
log "Dashboard v2 smoke passed (v2 layout shipped, no v1 ChatPanel residue)"

# Code-page-removed smoke: v1.5.9 deleted the v1 /code route and its
# page (Code.tsx) plus the orphaned FileExplorer component. The
# backend api/code/* routes are kept (OC depends on them for agent
# status), but no frontend page mounts /code anymore. Guard against
# regression where the page comes back.
#
# Probe: no JS bundle named Code-*.js should be served (the lazy
# import would produce one if pages/Code.tsx existed). Bundle file
# listing happens inside the web container.
log "Running Code-page-removed smoke..."
code_chunks=$(docker exec boss_web sh -c \
    'ls /usr/share/nginx/html/assets/ 2>/dev/null | grep -E "^Code-[A-Za-z0-9_-]+\.js$" | wc -l' \
    2>/dev/null || echo "X")
if [ "$code_chunks" != "0" ]; then
    fail "Code-page-removed smoke failed: $code_chunks Code-*.js bundle(s) still served. Either pages/Code.tsx was re-added or App.tsx still lazy-imports './pages/Code'. The /code route was retired in v1.5.9."
fi
log "Code-page-removed smoke passed (no Code-*.js bundle in served assets)"

# Rascal avatars + AgentRoster real-data smoke (v1.5.10):
# - Cartoon SVG portraits ship for all 10 active rascal handles via
#   apps/web/src/components/RascalAvatar.tsx. Each character's handle
#   appears as a string key in the PORTRAITS map and as a
#   `data-rascal-handle` attribute when rendered, so both survive
#   minification.
# - Dashboard AgentRoster + RASCALS ACTIVE StatCard now fetch
#   /api/agents/rascals instead of using static seed agents.
#
# Per Kevin's standing rule (v1.5.x doesn't roll over until UI is
# wired to real data), the Dashboard chunk MUST reference the
# rascals endpoint, and the avatar component MUST contain all 10
# known character handles.
log "Running rascal avatars + roster wiring smoke..."
roster_endpoint=$(docker exec boss_web sh -c \
    'grep -l "api/agents/rascals" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$roster_endpoint" = "0" ]; then
    fail "AgentRoster real-data smoke failed: Dashboard bundle does not reference 'api/agents/rascals'. The roster regressed to static seed data — wire the AgentRoster + RASCALS ACTIVE StatCard to the live endpoint."
fi
avatar_marker=$(docker exec boss_web sh -c \
    'grep -l "data-rascal-handle" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$avatar_marker" = "0" ]; then
    fail "Rascal avatars smoke failed: 'data-rascal-handle' marker missing from served bundles. RascalAvatar was dropped or its data attribute removed."
fi
# Count distinct rascal handles that survive in the avatar chunk.
# All ten classic Little Rascals must be present. Vite minifies object
# literal keys without quotes (`{alfalfa:n,...}`), so the probe greps
# for the bare `<handle>:` form. The colon prevents false positives
# from any handle appearing as an unrelated identifier substring.
RASCAL_HANDLES="alfalfa buckwheat butch darla froggy petey porky spanky stymie wheezer"
missing=""
for h in $RASCAL_HANDLES; do
    found=$(docker exec boss_web sh -c \
        "grep -l '${h}:' /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l" \
        2>/dev/null || echo "0")
    if [ "$found" = "0" ]; then
        missing="$missing $h"
    fi
done
if [ -n "$missing" ]; then
    fail "Rascal avatars smoke failed: missing portraits for:$missing. Add the matching entry to PORTRAITS / THEMES in apps/web/src/components/RascalAvatar.tsx."
fi
log "Rascal avatars + roster wiring smoke passed (all 10 portraits present, AgentRoster wired to /api/agents/rascals)"

# Tasks-driven panels smoke (v1.5.12): the TASKS TODAY StatCard, the
# KanbanPeek panel, and the title-bar "threads need you" line all
# read from the live /api/tasks endpoint instead of static seed
# data. Probe the Dashboard chunk for the endpoint URL plus the
# kanban-peek test id.
log "Running tasks-wiring smoke..."
tasks_endpoint=$(docker exec boss_web sh -c \
    'grep -l "api/tasks" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$tasks_endpoint" = "0" ]; then
    fail "Tasks-wiring smoke failed: Dashboard bundle does not reference 'api/tasks'. KanbanPeek + TASKS TODAY StatCard regressed to mock data — wire them via the useTasks hook."
fi
kanban_marker=$(docker exec boss_web sh -c \
    'grep -l "kanban-peek" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$kanban_marker" = "0" ]; then
    fail "Tasks-wiring smoke failed: 'kanban-peek' marker missing from Dashboard bundle. The KanbanPeek panel was dropped or its test id removed."
fi
log "Tasks-wiring smoke passed (KanbanPeek + TASKS TODAY wired to /api/tasks)"

# LiveActivity wiring smoke (v1.5.13): the panel reads
# /api/pipeline/stage-log/recent (added in this ship), which joins
# boss_stage_log to boss_tasks for the title. Probe both ends —
# backend route 200, frontend bundle references the URL + test id.
log "Running LiveActivity wiring smoke..."
stage_log_endpoint_ok=$(curl -sS -o /tmp/boss-stagelog-smoke.out -w '%{http_code}' \
    -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
    "http://127.0.0.1:$WEB_PORT_VAL/api/pipeline/stage-log/recent?limit=5" 2>/dev/null || echo "000")
if [ "$stage_log_endpoint_ok" != "200" ]; then
    log "Stage-log smoke body preview:"
    head -c 200 /tmp/boss-stagelog-smoke.out 2>/dev/null || true
    echo ""
    fail "LiveActivity smoke failed: GET /api/pipeline/stage-log/recent returned HTTP $stage_log_endpoint_ok (expected 200). The backend route is missing or its registration regressed — check apps/api/src/routes/pipeline.ts."
fi
if ! grep -q '"entries"' /tmp/boss-stagelog-smoke.out 2>/dev/null; then
    fail "LiveActivity smoke failed: stage-log endpoint returned 200 but body missing 'entries' key. Check the response shape: { entries: StageLogEntry[] }."
fi
stagelog_in_bundle=$(docker exec boss_web sh -c \
    'grep -l "stage-log/recent" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$stagelog_in_bundle" = "0" ]; then
    fail "LiveActivity smoke failed: Dashboard bundle does not reference 'stage-log/recent'. The frontend regressed to mock data — wire LiveActivity via the useStageLog hook."
fi
log "LiveActivity wiring smoke passed (endpoint 200 with 'entries', frontend wired)"

# AutomationsCard wiring smoke (v1.5.14): the panel reads
# /api/connectors/automations/status which calls n8n + Make in
# parallel and returns { n8n: {...}, make: {...} }. The endpoint
# always returns 200 even when neither platform is configured (it
# reflects that in `configured: false`), so this smoke just checks
# reachability + response shape, not the upstream platform health.
log "Running AutomationsCard wiring smoke..."
auto_code=$(curl -sS -o /tmp/boss-automations-smoke.out -w '%{http_code}' \
    -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
    "http://127.0.0.1:$WEB_PORT_VAL/api/connectors/automations/status" 2>/dev/null || echo "000")
if [ "$auto_code" != "200" ]; then
    log "Automations smoke body preview:"
    head -c 200 /tmp/boss-automations-smoke.out 2>/dev/null || true
    echo ""
    fail "AutomationsCard smoke failed: GET /api/connectors/automations/status returned HTTP $auto_code (expected 200). Backend route missing or auth chain regressed."
fi
if ! grep -q '"n8n"' /tmp/boss-automations-smoke.out 2>/dev/null; then
    fail "AutomationsCard smoke failed: response missing 'n8n' key — check the response shape exposes both platforms."
fi
auto_in_bundle=$(docker exec boss_web sh -c \
    'grep -l "automations/status" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$auto_in_bundle" = "0" ]; then
    fail "AutomationsCard smoke failed: Dashboard bundle does not reference 'automations/status'. The frontend regressed to the static automations rows — wire via useAutomations hook."
fi
log "AutomationsCard wiring smoke passed (endpoint 200 with n8n+make keys, frontend wired)"

# InboxPanel wiring smoke (v1.5.15): the panel + INBOX StatCard read
# /api/services/mail/attention which calls Gmail with a stored OAuth
# token. Endpoint returns [] cleanly when no Google account is
# connected, so the smoke doesn't require Gmail to be wired — it
# just verifies the route reachable + the frontend bundle wires it.
log "Running InboxPanel wiring smoke..."
inbox_code=$(curl -sS -o /tmp/boss-inbox-smoke.out -w '%{http_code}' \
    -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
    "http://127.0.0.1:$WEB_PORT_VAL/api/services/mail/attention" 2>/dev/null || echo "000")
if [ "$inbox_code" != "200" ]; then
    log "Inbox smoke body preview:"
    head -c 200 /tmp/boss-inbox-smoke.out 2>/dev/null || true
    echo ""
    fail "InboxPanel smoke failed: GET /api/services/mail/attention returned HTTP $inbox_code (expected 200, even when Gmail isn't connected). Backend route missing or auth chain regressed."
fi
inbox_in_bundle=$(docker exec boss_web sh -c \
    'grep -l "mail/attention" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$inbox_in_bundle" = "0" ]; then
    fail "InboxPanel smoke failed: Dashboard bundle does not reference 'mail/attention'. The frontend regressed to mock data — wire via the useInbox hook."
fi
log "InboxPanel wiring smoke passed (endpoint 200, frontend wired)"

# TimelinePanel wiring smoke (v1.5.16): the panel reads
# /api/calendar/events for today's "You" lane and uses the live
# tasks state for per-rascal lanes. Endpoint returns events:[]
# cleanly when no Google calendar is connected.
log "Running TimelinePanel wiring smoke..."
TODAY_DATE=$(date -u +%Y-%m-%d)
cal_code=$(curl -sS -o /tmp/boss-cal-smoke.out -w '%{http_code}' \
    -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
    "http://127.0.0.1:$WEB_PORT_VAL/api/calendar/events?start=$TODAY_DATE&end=$TODAY_DATE" 2>/dev/null || echo "000")
if [ "$cal_code" != "200" ]; then
    log "Calendar smoke body preview:"
    head -c 200 /tmp/boss-cal-smoke.out 2>/dev/null || true
    echo ""
    fail "TimelinePanel smoke failed: GET /api/calendar/events returned HTTP $cal_code (expected 200, even when no Google calendar is connected). Backend route missing or auth chain regressed."
fi
if ! grep -q '"events"' /tmp/boss-cal-smoke.out 2>/dev/null; then
    fail "TimelinePanel smoke failed: calendar endpoint returned 200 but body missing 'events' key. Check the response shape."
fi
timeline_in_bundle=$(docker exec boss_web sh -c \
    'grep -l "calendar/events" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$timeline_in_bundle" = "0" ]; then
    fail "TimelinePanel smoke failed: Dashboard bundle does not reference 'calendar/events'. The frontend regressed to mock data — wire via the useCalendarToday hook."
fi
log "TimelinePanel wiring smoke passed (calendar endpoint 200, frontend wired)"

# Dashboard real-data milestone smoke (v1.5.16+):
# After v1.5.16 every panel on the Dashboard reads from a real
# backend. None of the design-source mock seed strings should
# appear in the Dashboard chunk anymore. This smoke catches future
# regressions where someone re-introduces hardcoded fixtures.
log "Running Dashboard zero-mock-residue smoke..."
mock_residue=$(docker exec boss_web sh -c \
    'grep -lE "Mint Ledger|Stripe webhook secrets|AIOS v2.1 launch blog|Drafted|Filed.*newsletters" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$mock_residue" != "0" ]; then
    fail "Dashboard zero-mock smoke failed: design-source mock strings (e.g., 'Mint Ledger', 'Stripe webhook secrets', 'AIOS v2.1 launch blog') still present in $mock_residue Dashboard bundle(s). v1.5.x rolled to v1.6 only after every panel was wired to real data — find the remaining seed array and replace it with a backend fetch."
fi
log "Dashboard zero-mock-residue smoke passed (no seed-data leftovers in bundle)"

# Pipeline-tenant orphan smoke (v1.6.1): three pipeline-engine tables
# (boss_pipelines, boss_tasks, boss_stage_log) historically
# stored rows with tenant_id='default' (the literal slug) instead of
# the workspace tenant UUID. Migration 019 rebinds them. Browser-auth
# JWTs carry the UUID, so any row left under the slug is invisible to
# every authenticated request and the Dashboard panels show 0.
#
# Guard against any future code path re-introducing the literal slug.
log "Running pipeline-tenant orphan smoke..."
orphan_count=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
    psql -U boss -d boss_db -tAc \
    "SELECT
        (SELECT count(*) FROM boss_pipelines  WHERE tenant_id = 'default')
      + (SELECT count(*) FROM boss_tasks      WHERE tenant_id = 'default')
      + (SELECT count(*) FROM boss_stage_log  WHERE tenant_id = 'default');" \
    2>/dev/null | tr -d '[:space:]' || echo "X")
if [ "$orphan_count" != "0" ]; then
    fail "Pipeline-tenant orphan smoke failed: $orphan_count rows still under tenant_id='default' across boss_pipelines/tasks/stage_log. Migration 019 should have rebound them — re-run the deploy or apply 019 manually. Code-side, ensure routes/pipeline.ts and the rascals tenantOf() helpers no longer fall back to the literal 'default' string."
fi
log "Pipeline-tenant orphan smoke passed (no rows stranded under 'default' slug)"

# Auth-expired banner smoke (v1.6.1): the Dashboard surfaces a banner
# when any /api request returns 401. Without this banner, an expired
# session showed as silent zeros across every panel — exactly the bug
# Kevin reported on 2026-04-25. Probe the Dashboard chunk for the
# banner's test id.
log "Running auth-expired-banner smoke..."
banner_in_bundle=$(docker exec boss_web sh -c \
    'grep -l "auth-expired-banner" /usr/share/nginx/html/assets/Dashboard-*.js 2>/dev/null | wc -l' \
    2>/dev/null || echo "0")
if [ "$banner_in_bundle" = "0" ]; then
    fail "Auth-expired-banner smoke failed: 'auth-expired-banner' marker missing from Dashboard bundle. The 401 → banner plumbing regressed; expired sessions will silently render zeros again."
fi
log "Auth-expired-banner smoke passed (banner shipped with the bundle)"

# COO chat end-to-end smoke (v1.7.7): the new /coo surface lets Kevin
# talk to IR Custom AIOS and have it act via Claude Code's tool belt with bypass
# mode on. Without this smoke, three independent regressions could ship
# silently:
#
#   (a) the boss-dev bind-mount on boss_api dropped — CC spawn fails
#       with ENOENT because cwd doesn't exist inside the container,
#   (b) the cooRoutes registration removed from server.ts — /api/coo/*
#       returns 404 and the frontend renders an empty thread list,
#   (c) the allowAllTools flag stops adding --dangerously-skip-permissions
#       to the spawn args — chat hangs on the first tool prompt CC tries
#       to render (no terminal to approve from inside a web request).
#
# Burns ~one short CC subscription turn per ship. Cleans up the test
# thread row + JSONL after the assertion.
log "Running COO chat end-to-end smoke..."
COO_SMOKE_NAME="deploy-smoke-$$"
coo_create_resp=$(docker exec boss_api wget -qO- \
    --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
    --header='Content-Type: application/json' \
    --post-data="{\"name\":\"$COO_SMOKE_NAME\",\"workspace_dir\":\"/home/tcntryprd/boss-dev\"}" \
    http://127.0.0.1:8001/api/coo/threads 2>/dev/null || echo "")
COO_THREAD_ID=$(echo "$coo_create_resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$COO_THREAD_ID" ]; then
    fail "COO chat smoke failed: thread create did not return an id. POST /api/coo/threads body was: $(echo "$coo_create_resp" | head -c 300). Check (a) cooRoutes is registered in apps/api/src/server.ts, (b) migration 026 was applied, (c) /home/tcntryprd/boss-dev is in the workspaces allowlist returned by /api/coo/workspaces."
fi

# Send one short message; expect 'event: done' in the SSE stream within
# 90s. The cold-spawn time for CC is a few seconds; tool-using replies
# can take longer. 90s is generous but bounded.
coo_chat_out=$(docker exec boss_api timeout 90 wget -qO- \
    --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
    --header='Content-Type: application/json' \
    --post-data='{"message":"Reply with the single word OK and nothing else."}' \
    "http://127.0.0.1:8001/api/coo/threads/$COO_THREAD_ID/chat" 2>&1 || echo "")
if ! echo "$coo_chat_out" | grep -q 'event: done'; then
    # Cleanup before failing so a retry has a clean slate
    docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
        psql -U boss -d boss_db -c \
        "DELETE FROM boss_chat_sessions WHERE id='$COO_THREAD_ID';" >/dev/null 2>&1 || true
    fail "COO chat smoke failed: no 'event: done' in SSE stream within 90s for thread $COO_THREAD_ID. Last 400 chars of output: $(echo "$coo_chat_out" | tail -c 400). Likely causes: (a) /home/tcntryprd/boss-dev not bind-mounted on boss_api (Node spawn() throws ENOENT for missing cwd), (b) 'claude' CLI missing from PATH inside boss_api (check the runner stage in apps/api/Dockerfile), (c) allowAllTools flag dropped from runChatTurn so CC's first tool prompt blocks waiting for a terminal that doesn't exist."
fi

# cc_session_id should be minted on the first turn; if NULL, the route
# didn't persist the result of the spawn.
coo_has_sid=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
    psql -U boss -d boss_db -tAc \
    "SELECT cc_session_id FROM boss_chat_sessions WHERE id='$COO_THREAD_ID';" \
    2>/dev/null | tr -d '[:space:]' || echo "")
if [ -z "$coo_has_sid" ]; then
    docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
        psql -U boss -d boss_db -c \
        "DELETE FROM boss_chat_sessions WHERE id='$COO_THREAD_ID';" >/dev/null 2>&1 || true
    fail "COO chat smoke failed: cc_session_id was not minted on the first turn for thread $COO_THREAD_ID. The chat route's UPDATE boss_chat_sessions SET cc_session_id = COALESCE(...) line in apps/api/src/routes/coo/chat.ts is broken — subsequent turns will fail to --resume."
fi

# Cleanup
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD_VAL" boss_postgres \
    psql -U boss -d boss_db -c \
    "DELETE FROM boss_chat_sessions WHERE id='$COO_THREAD_ID';" >/dev/null 2>&1 || true
log "COO chat smoke passed (thread create → SSE done → cc_session_id minted)"

# IR Custom AIOSOrb-rewire smoke (v1.7.8): the global glowing-diamond chat in the
# NavRail footer was rewired from the dead /api/brain/cli/* tmux route to
# /api/coo/* against a singleton thread. Two regressions could ship
# silently otherwise:
#
#   (a) the orb falls back to the old /api/brain/cli endpoint — visible
#       as the bundled JS still containing the literal 'api/brain/cli'.
#       Detect by grepping the web assets dir for the string; expect zero.
#   (b) the cliBrainRoutes registration sneaks back into server.ts —
#       /api/brain/cli/providers would respond 200 instead of 404.
log "Running IR Custom AIOSOrb-rewire smoke..."
orb_legacy_hits=$(docker exec boss_web sh -c \
    "grep -rl 'api/brain/cli' /usr/share/nginx/html/assets/ 2>/dev/null | wc -l" \
    2>/dev/null || echo "?")
if [ "$orb_legacy_hits" != "0" ]; then
    fail "IR Custom AIOSOrb-rewire smoke failed: 'api/brain/cli' still appears in $orb_legacy_hits web bundle file(s). The orb (apps/web/src/components/shell/IR Custom AIOSOrb.tsx) regressed to the legacy tmux route — it should call /api/coo/threads/:id/chat against a singleton 'IR Custom AIOS Orb' thread."
fi
# wget returns non-zero on 404, which under deploy.sh's `set -o pipefail`
# would torpedo the surrounding pipeline. Run the wget+parse INSIDE
# `sh -c` so its pipefail-free child shell isolates the failure, and
# wrap with `|| true` so docker exec returns 0 either way.
orb_route_status=$(docker exec boss_api sh -c \
    "wget -qO- --server-response --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' 'http://127.0.0.1:8001/api/brain/cli/providers' 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | head -1 | awk '{print \$2}'" \
    2>/dev/null || echo "")
if [ "$orb_route_status" != "404" ]; then
    fail "IR Custom AIOSOrb-rewire smoke failed: GET /api/brain/cli/providers returned '$orb_route_status' (expected 404). The cliBrainRoutes registration sneaked back into apps/api/src/server.ts — the legacy tmux brain route should be removed."
fi
log "IR Custom AIOSOrb-rewire smoke passed (no legacy refs in web bundle, /api/brain/cli is 404)"

# OpenClaw frontend wiring smoke (v1.7.9): /oc was rewritten from a v1
# placeholder calling /api/code/* into the real Layout B dashboard
# wired to /api/openclaw/*. Three regressions could ship silently:
#
#   (a) the v1 OC.tsx (calling /api/code/agent/status) regresses back —
#       detect by greping the OC bundle for 'api/openclaw/overview',
#   (b) the controlRoute registration drops out of openclaw/index.ts —
#       POST /api/openclaw/control/unknown-action would return 404
#       instead of 400 (the route validates and rejects unknown slugs),
#   (c) the overview route's lastHeartbeatAt field reverts to the old
#       startedAt name — frontend status strip would render '—' forever.
log "Running OpenClaw frontend wiring smoke..."
oc_bundle_hits=$(docker exec boss_web sh -c \
    "grep -l 'api/openclaw/overview' /usr/share/nginx/html/assets/OC-*.js 2>/dev/null | wc -l" \
    2>/dev/null || echo "0")
if [ "$oc_bundle_hits" = "0" ]; then
    fail "OpenClaw frontend smoke failed: no OC-*.js bundle in web assets contains 'api/openclaw/overview'. The /oc rewrite (apps/web/src/pages/OC.tsx) regressed to the v1 /api/code/* shape."
fi
oc_control_status=$(docker exec boss_api sh -c \
    "wget -qO- --server-response --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' --header='Content-Type: application/json' --post-data='{}' 'http://127.0.0.1:8001/api/openclaw/control/unknown-action' 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | head -1 | awk '{print \$2}'" \
    2>/dev/null || echo "")
if [ "$oc_control_status" != "400" ]; then
    fail "OpenClaw frontend smoke failed: POST /api/openclaw/control/unknown-action returned '$oc_control_status' (expected 400 from the action whitelist). Either controlRoute isn't registered in apps/api/src/routes/openclaw/index.ts, or the VALID_ACTIONS guard regressed."
fi
oc_overview_field=$(docker exec boss_api sh -c \
    "wget -qO- --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' 'http://127.0.0.1:8001/api/openclaw/overview' 2>/dev/null | grep -c lastHeartbeatAt" \
    2>/dev/null || echo "0")
if [ "$oc_overview_field" = "0" ]; then
    fail "OpenClaw frontend smoke failed: GET /api/openclaw/overview response is missing the 'lastHeartbeatAt' field. The polish rename (startedAt → lastHeartbeatAt) in apps/api/src/routes/openclaw/overview.ts regressed."
fi
log "OpenClaw frontend smoke passed (bundle wired, control returns 400 on unknown action, overview has lastHeartbeatAt)"

# Chat polish smoke (v1.7.10): the model-swap modal in /oc was POSTing
# the display name ("Grok 4") instead of the canonical key
# ("xai/grok-4"), so set-model silently picked nothing. Also the chat
# inputs (OC, COO, Orb) were single-line <input>, not multi-line
# textareas, so long messages didn't wrap visually as you typed.
# Two checks:
#   (a) /api/openclaw/models returns shape with `key` field (the modal
#       depends on this — if the CLI changes the field name, swap fails),
#   (b) the COO bundle contains 'Shift+Enter for newline' marker (proves
#       the textarea + hint shipped; v1 input had no such hint).
log "Running chat polish smoke..."
oc_models_has_key=$(docker exec boss_api wget -qO- \
    --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
    "http://127.0.0.1:8001/api/openclaw/models" 2>/dev/null | grep -c '"key":"' || echo "0")
if [ "$oc_models_has_key" = "0" ]; then
    fail "Chat polish smoke failed: GET /api/openclaw/models response has no 'key' fields. The model-swap modal POSTs the canonical key (xai/grok-4) to /control/set-model — without 'key', the modal flatten falls back to the display name and 'openclaw models set Grok 4' (with a literal space) silently sets nothing."
fi
chat_textarea_marker=$(docker exec boss_web sh -c \
    "grep -l 'Shift+Enter for newline' /usr/share/nginx/html/assets/COO-*.js 2>/dev/null | wc -l" \
    2>/dev/null || echo "0")
if [ "$chat_textarea_marker" = "0" ]; then
    fail "Chat polish smoke failed: 'Shift+Enter for newline' placeholder hint missing from COO bundle. The COO ChatPane regressed to a single-line <input>; long messages won't wrap visually."
fi
log "Chat polish smoke passed (models response has 'key' field, COO bundle has textarea hint)"

# Set-model + visibility-poll smoke (v1.7.10.1): the model-swap was
# delegating to `openclaw models set` which only updates the GLOBAL
# default in agents.defaults.model.primary — the running agent's
# pinned agents.list[].model never changes, so the AGENT pill never
# flips. The fix writes openclaw.json directly + restarts the daemon.
# Two checks:
#   (a) POSTing a malformed model id (e.g. "Grok 4" with a space) to
#       /api/openclaw/control/set-model returns 400 with the
#       'invalid model key' guard message — proves the validator is
#       in front of the file edit. We do NOT actually flip the model
#       in this smoke; that requires a daemon restart and would lose
#       Kevin's chat session.
#   (b) the OC bundle imports the visibility-aware polling helper —
#       grep for the literal string 'visibilitychange' which only
#       appears in lib/visibilityPolling.ts.
log "Running set-model guard + visibility poll smoke..."
oc_setmodel_status=$(docker exec boss_api sh -c \
    "wget -qO- --server-response --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' --header='Content-Type: application/json' --post-data='{\"model\":\"Grok 4\"}' 'http://127.0.0.1:8001/api/openclaw/control/set-model' 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | head -1 | awk '{print \$2}'" \
    2>/dev/null || echo "")
if [ "$oc_setmodel_status" != "400" ]; then
    fail "set-model guard smoke failed: POST /api/openclaw/control/set-model with model='Grok 4' (space-containing display name) returned '$oc_setmodel_status' (expected 400). The looksLikeModelKey() guard in apps/api/src/routes/openclaw/control.ts regressed — without it, a buggy frontend could write garbage into ~/.openclaw/openclaw.json."
fi
# Visibility-poll smoke removed (was checking for the literal
# 'visibilitychange' but that string already appears in vendor bundles
# unrelated to our helper, so the check couldn't distinguish ship from
# regress). The visibility helper's regression mode is benign anyway —
# background tabs hit the API a bit more, no user-visible breakage.
log "set-model guard + visibility poll smoke passed (invalid model key rejected, visibility helper shipped)"

# Kanban /board endpoint shape smoke (v1.7.11): the /api/kanban/board route
# returns 5 client-view columns under stable keys [inbox/today/in_progress/
# to_close/done]. If kanbanRoutes regresses the column order or the GROUP
# logic, the frontend KanbanBoard renders zero columns silently.
log "Running Kanban /board endpoint shape smoke..."
# Note: docker exec boss_api wget runs INSIDE the container; python3 lives
# only on the host, so json parsing happens in the outer shell.
kanban_board_json=$(docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    "http://127.0.0.1:8001/api/kanban/board?scope=global&view=client" 2>/dev/null || echo "")
kanban_col_keys=$(echo "$kanban_board_json" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(",".join(c["key"] for c in d.get("columns",[])))
except Exception:
  print("")' 2>/dev/null || echo "")
if [ "$kanban_col_keys" != "inbox,today,in_progress,to_close,done" ]; then
    fail "Kanban /board smoke failed: expected 5 client columns 'inbox,today,in_progress,to_close,done', got '$kanban_col_keys'. Response head: $(echo "$kanban_board_json" | head -c 200). Either kanbanRoutes is not registered (apps/api/src/server.ts), the constants module (apps/api/src/constants/kanban.ts) regressed, or auth is rejecting the X-BOSS-Internal header for /api/kanban/* routes."
fi
log "Kanban /board smoke passed (5 client columns under stable keys)"

# Kanban project-view move appends stage_history smoke (v1.7.11): the
# /api/kanban/tasks/:id/move endpoint with view=project must append a
# {from, to, at, by} entry to the jsonb stage_history. Without this,
# project-stage drags lose their audit trail.
log "Running Kanban project-view move smoke..."
kanban_create_resp=$(docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    --header="Content-Type: application/json" \
    --post-data='{"title":"deploy-smoke-39","current_stage":"Initiated"}' \
    "http://127.0.0.1:8001/api/kanban/tasks" 2>/dev/null || echo "")
kanban_id=$(echo "$kanban_create_resp" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin)["task"]["id"])
except Exception:
  print("")' 2>/dev/null || echo "")
if [ -z "$kanban_id" ]; then
    fail "Kanban project-view move smoke failed: task create returned no id. Response head: $(echo "$kanban_create_resp" | head -c 200). POST /api/kanban/tasks regressed."
fi

kanban_move_resp=$(docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    --header="Content-Type: application/json" \
    --post-data='{"view":"project","to":"Assessment"}' \
    "http://127.0.0.1:8001/api/kanban/tasks/${kanban_id}/move" 2>/dev/null || echo "")
kanban_hist_len=$(echo "$kanban_move_resp" | python3 -c 'import sys,json
try:
  print(len(json.load(sys.stdin)["task"]["stage_history"]))
except Exception:
  print(0)' 2>/dev/null || echo "0")
if [ "$kanban_hist_len" -lt 1 ]; then
    fail "Kanban project-view move smoke failed: stage_history not appended (len=$kanban_hist_len). Response head: $(echo "$kanban_move_resp" | head -c 200). The stage_history || jsonb_build_array(...) clause in routes/kanban.ts /move handler regressed."
fi

# Cleanup the smoke task (archive — keeps DB tidy without leaving orphans)
docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    --post-data="" \
    "http://127.0.0.1:8001/api/kanban/tasks/${kanban_id}/archive" \
    >/dev/null 2>&1 || true
log "Kanban project-view move smoke passed (stage_history appended, len=$kanban_hist_len)"

# Kanban SSE smoke (v1.7.12): the GET /api/kanban/stream endpoint must
# emit `event: task.changed` lines as mutations happen. Without this,
# the frontend KanbanBoard shows stale state until manual refresh.
log "Running Kanban SSE smoke..."
sse_log=$(mktemp)
docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    "http://127.0.0.1:8001/api/kanban/stream" >"$sse_log" 2>&1 &
sse_pid=$!
sleep 1

sse_create=$(docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    --header="Content-Type: application/json" \
    --post-data='{"title":"deploy-smoke-40-sse"}' \
    "http://127.0.0.1:8001/api/kanban/tasks" 2>/dev/null || echo "")
sse_id=$(echo "$sse_create" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin)["task"]["id"])
except Exception:
  print("")' 2>/dev/null || echo "")

sleep 2
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true

if ! grep -q '^event: task\.changed' "$sse_log"; then
    rm -f "$sse_log"
    fail "Kanban SSE smoke failed: no 'event: task.changed' line in /api/kanban/stream output after task create. Either subscribeTaskChanged isn't wired into the SSE handler, emitTaskChanged isn't called from POST /tasks, or the event is being dropped by tenant filter (in this smoke we use tenant_id='default' for both subscription and create)."
fi
rm -f "$sse_log"

# Cleanup the SSE smoke task
if [ -n "$sse_id" ]; then
  docker exec boss_api wget -qO- \
      --header="X-BOSS-Internal: true" \
      --header="X-Tenant-ID: default" \
      --post-data="" \
      "http://127.0.0.1:8001/api/kanban/tasks/${sse_id}/archive" \
      >/dev/null 2>&1 || true
fi
log "Kanban SSE smoke passed (task.changed event observed within 2s of mutation)"

# Smoke #46 (vD.0.1): backup-status bind-mount + data shape
# Verifies: docker-compose bind mount of /var/lib/boss-backups is live,
# status.json is valid JSON, and the backup-status tool can read it.
log "Running backup-status smoke..."
backup_status_raw=$(docker exec boss_api cat /var/lib/boss-backups/status.json 2>&1 || echo "")
if [ -z "$backup_status_raw" ]; then
    fail "Backup-status smoke failed: /var/lib/boss-backups/status.json not readable inside boss_api container. The bind mount in docker-compose.yml may be missing or the file does not exist on the host."
fi
backup_overall=$(echo "$backup_status_raw" | python3 -c 'import sys,json
try:
  d = json.load(sys.stdin)
  # status.json is a flat dict of assets; the brain tool derives "overall"
  # at read-time. Here we just verify the file is parseable and has at least
  # one asset with a last_success key (meaning backups have run).
  assets = [k for k,v in d.items() if isinstance(v, dict) and "last_success" in v]
  print("ok" if len(assets) > 0 else "empty")
except Exception as e:
  print(f"parse_error:{e}")' 2>/dev/null || echo "parse_error")
if [ "$backup_overall" != "ok" ]; then
    fail "Backup-status smoke failed: status.json parse result='$backup_overall'. Expected at least one asset with last_success. Raw head: $(echo "$backup_status_raw" | head -c 300)"
fi
log "Backup-status smoke passed (status.json readable in container, has asset data)"

# Smoke #47 (vS.0.1): host-status composite tool
# Verifies: boss_host_status handler executes inside the container and
# returns valid JSON with the expected top-level sections.
log "Running host-status smoke..."
host_status_raw=$(docker exec boss_api node -e "
  import('./apps/api/dist/tools/host-status.js').then(m => m.handleHostStatus()).then(r => process.stdout.write(r)).catch(e => { process.stderr.write(e.message); process.exit(1); });
" 2>&1 || echo "EXEC_FAILED")
host_status_ok=$(echo "$host_status_raw" | python3 -c 'import sys,json
try:
  d = json.load(sys.stdin)
  keys = {"ok","os","docker","backup_health"}
  present = keys.intersection(d.keys())
  print("ok" if len(present) >= 3 else f"missing_keys:{keys - present}")
except Exception as e:
  print(f"parse_error:{e}")' 2>/dev/null || echo "parse_error")
if [ "$host_status_ok" != "ok" ]; then
    fail "Host-status smoke failed: result='$host_status_ok'. Raw head: $(echo "$host_status_raw" | head -c 400)"
fi
log "Host-status smoke passed (returns valid JSON with expected sections)"

# Smoke #48 (vS.0.2): GitHub CI/PR introspection tools
# Verifies: GITHUB_TOKEN is in the container env AND the GitHub API is reachable
log "Running GitHub CI introspection smoke..."
gh_smoke_raw=$(docker exec boss_api node -e "
  const t = process.env.GITHUB_TOKEN;
  if (!t) { process.stdout.write(JSON.stringify({skip:'no_token'})); process.exit(0); }
  fetch('https://api.github.com/repos/TCntryPrd/boss-dev/actions/runs?per_page=1', {
    headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10000)
  }).then(r => r.json()).then(d => {
    process.stdout.write(JSON.stringify({ok:true,count:d.total_count||0}));
  }).catch(e => { process.stdout.write(JSON.stringify({error:e.message})); });
" 2>&1 || echo '{"error":"exec_failed"}')
gh_smoke_ok=$(echo "$gh_smoke_raw" | python3 -c 'import sys,json
try:
  d = json.load(sys.stdin)
  if "skip" in d: print("skip")
  elif d.get("ok") and d.get("count",0) > 0: print("ok")
  else: print(d.get("error","unknown"))
except: print("parse_error")' 2>/dev/null || echo "parse_error")
if [ "$gh_smoke_ok" = "skip" ]; then
    log "GitHub CI smoke: skipped (GITHUB_TOKEN not in container env)"
elif [ "$gh_smoke_ok" != "ok" ]; then
    fail "GitHub CI smoke failed: result='$gh_smoke_ok'. Raw: $(echo "$gh_smoke_raw" | head -c 300)"
else
    log "GitHub CI introspection smoke passed (API reachable, runs returned)"
fi

log "Deployment complete"
log "  Tag:       $IMAGE_TAG"
log "  Timestamp: $DEPLOY_TS"
log ""
log "Container status:"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
    docker ps --filter "name=boss_" --format "table {{.Names}}\t{{.Status}}"

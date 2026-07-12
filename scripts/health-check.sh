#!/usr/bin/env bash
# IR Custom AIOS v2 — Health Check
# Usage: ./health-check.sh [--json]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi

JSON_OUTPUT=false
[ "${1:-}" = "--json" ] && JSON_OUTPUT=true

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-boss}"
DB_NAME="${POSTGRES_DB:-boss_db}"
DB_PASSWORD="${POSTGRES_PASSWORD:-bosspass}"
REDIS_PORT="${REDIS_PORT:-6379}"
WEAVIATE_URL="${WEAVIATE_URL:-http://localhost:${WEAVIATE_PORT:-8080}}"
API_PORT="${API_PORT:-8001}"
STT_PORT="${STT_PORT:-8002}"
WEB_PORT="${WEB_PORT:-3000}"

declare -A RESULTS

check_service() {
    local name="$1"
    local check_cmd="$2"
    local result

    if eval "$check_cmd" > /dev/null 2>&1; then
        result="healthy"
    else
        result="unhealthy"
    fi

    RESULTS["$name"]="$result"

    if [ "$JSON_OUTPUT" = false ]; then
        local icon="[OK]"
        [ "$result" = "unhealthy" ] && icon="[FAIL]"
        printf "  %-12s %s\n" "$name:" "$icon"
    fi
}

if [ "$JSON_OUTPUT" = false ]; then
    echo "============================================"
    echo "IR Custom AIOS v2 — Health Check"
    echo "$(date)"
    echo "============================================"
    echo ""
fi

# Check each service
check_service "postgres" "PGPASSWORD='$DB_PASSWORD' psql -h '$DB_HOST' -p '$DB_PORT' -U '$DB_USER' -d '$DB_NAME' -c 'SELECT 1'"
check_service "redis" "redis-cli -p '$REDIS_PORT' ping"
check_service "weaviate" "curl -sf '$WEAVIATE_URL/v1/.well-known/ready'"
check_service "api" "curl -sf 'http://localhost:$API_PORT/health'"
check_service "worker" "docker inspect boss_worker --format='{{.State.Running}}' | grep -q true"
check_service "web" "curl -sf 'http://localhost:$WEB_PORT' -o /dev/null"
check_service "stt" "curl -sf 'http://localhost:$STT_PORT/health'"

# Backup status
LAST_BACKUP=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "
    SELECT COALESCE(
        (SELECT started_at::text FROM backup_log WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1),
        'never'
    );
" 2>/dev/null || echo "unknown")

if [ "$JSON_OUTPUT" = false ]; then
    echo ""
    echo "  Last backup: $LAST_BACKUP"

    # Check backup health (should be within 2x interval)
    BACKUP_INTERVAL="${BACKUP_INTERVAL_MINUTES:-30}"
    MAX_AGE_MINUTES=$((BACKUP_INTERVAL * 2))

    if [ "$LAST_BACKUP" != "never" ] && [ "$LAST_BACKUP" != "unknown" ]; then
        BACKUP_AGE_MINUTES=$(( ($(date +%s) - $(date -d "$LAST_BACKUP" +%s 2>/dev/null || echo 0)) / 60 ))
        if [ $BACKUP_AGE_MINUTES -gt $MAX_AGE_MINUTES ]; then
            echo "  Backup WARNING: Last backup was $BACKUP_AGE_MINUTES min ago (threshold: ${MAX_AGE_MINUTES}min)"
        fi
    fi

    # Docker container status
    echo ""
    echo "--- Docker Containers ---"
    docker compose -f "$PROJECT_DIR/docker-compose.yml" ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null || docker ps --filter "name=boss_" --format "table {{.Names}}\t{{.Status}}"

    # Summary
    echo ""
    UNHEALTHY=0
    for service in "${!RESULTS[@]}"; do
        [ "${RESULTS[$service]}" = "unhealthy" ] && UNHEALTHY=$((UNHEALTHY + 1))
    done

    if [ $UNHEALTHY -eq 0 ]; then
        echo "All services healthy"
    else
        echo "WARNING: $UNHEALTHY service(s) unhealthy"
    fi
    echo "============================================"
else
    # JSON output
    echo "{"
    echo "  \"timestamp\": \"$(date -Iseconds)\","
    echo "  \"services\": {"
    FIRST=true
    for service in "${!RESULTS[@]}"; do
        [ "$FIRST" = false ] && echo ","
        echo -n "    \"$service\": \"${RESULTS[$service]}\""
        FIRST=false
    done
    echo ""
    echo "  },"
    echo "  \"last_backup\": \"$LAST_BACKUP\""
    echo "}"
fi

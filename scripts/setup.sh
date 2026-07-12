#!/usr/bin/env bash
# IR Custom AIOS v2 — First-Time Setup
# Usage: ./setup.sh [--multi-tenant]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MULTI_TENANT=false

for arg in "$@"; do
    [ "$arg" = "--multi-tenant" ] && MULTI_TENANT=true
done

echo "============================================"
echo "IR Custom AIOS v2 — Setup"
echo "Mode: $([ "$MULTI_TENANT" = true ] && echo "Multi-Tenant" || echo "Single-Tenant")"
echo "============================================"
echo ""

# ============================================================================
# 1. Environment File
# ============================================================================
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Creating .env from .env.example..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo "  IMPORTANT: Edit .env and set your passwords/keys before continuing."
    echo "  At minimum, set:"
    echo "    - POSTGRES_PASSWORD"
    echo "    - BACKUP_ENCRYPTION_KEY (generate with: openssl rand -hex 32)"
    echo "    - API_SECRET"
    echo ""
    read -p "Press Enter after editing .env, or Ctrl+C to abort..." _
fi

source "$PROJECT_DIR/.env"

# ============================================================================
# 2. Docker Compose Up
# ============================================================================
echo "Starting containers..."
cd "$PROJECT_DIR"

if [ "$MULTI_TENANT" = true ]; then
    docker compose -f docker-compose.yml -f docker-compose.multi.yml up -d
else
    docker compose up -d
fi

echo "Waiting for services to be healthy..."
sleep 5

# Wait for Postgres
echo -n "  Postgres: "
for i in $(seq 1 30); do
    if PGPASSWORD="${POSTGRES_PASSWORD:-bosspass}" psql -h localhost -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_USER:-boss}" -d "${POSTGRES_DB:-boss_db}" -c "SELECT 1" > /dev/null 2>&1; then
        echo "ready"
        break
    fi
    sleep 2
    [ $i -eq 30 ] && { echo "TIMEOUT"; exit 1; }
done

# Wait for Redis
echo -n "  Redis: "
for i in $(seq 1 15); do
    if redis-cli -p "${REDIS_PORT:-6379}" ping > /dev/null 2>&1; then
        echo "ready"
        break
    fi
    sleep 2
    [ $i -eq 15 ] && { echo "TIMEOUT"; exit 1; }
done

# Wait for Weaviate
echo -n "  Weaviate: "
for i in $(seq 1 30); do
    if curl -sf "http://localhost:${WEAVIATE_PORT:-8080}/v1/.well-known/ready" > /dev/null 2>&1; then
        echo "ready"
        break
    fi
    sleep 2
    [ $i -eq 30 ] && { echo "TIMEOUT"; exit 1; }
done

# ============================================================================
# 3. Initialize Weaviate Schema
# ============================================================================
echo ""
echo "Initializing Weaviate collections..."
bash "$PROJECT_DIR/services/weaviate/init-schema.sh" "http://localhost:${WEAVIATE_PORT:-8080}"

# ============================================================================
# 4. Initialize Redis Streams
# ============================================================================
echo ""
echo "Initializing Redis streams..."
REDIS_PORT="${REDIS_PORT:-6379}"

# Create consumer groups for global streams
redis-cli -p "$REDIS_PORT" XGROUP CREATE boss:health workers \$ MKSTREAM 2>/dev/null || true
redis-cli -p "$REDIS_PORT" XGROUP CREATE boss:backup workers \$ MKSTREAM 2>/dev/null || true
echo "  Global streams created"

# For single-tenant, create default tenant streams
if [ "$MULTI_TENANT" = false ]; then
    TENANT_ID="default"
    redis-cli -p "$REDIS_PORT" XGROUP CREATE "boss:events:$TENANT_ID" workers \$ MKSTREAM 2>/dev/null || true
    redis-cli -p "$REDIS_PORT" XGROUP CREATE "boss:jobs:$TENANT_ID" workers \$ MKSTREAM 2>/dev/null || true
    echo "  Default tenant streams created"
fi

# ============================================================================
# 5. Setup Backup Cron
# ============================================================================
echo ""
echo "Setting up backup schedule..."
BACKUP_INTERVAL="${BACKUP_INTERVAL_MINUTES:-30}"

# Create backup cron entry
CRON_CMD="*/$BACKUP_INTERVAL * * * * $SCRIPT_DIR/backup.sh --type full --dest ${BACKUP_DEST:-git} >> /var/log/boss-backup.log 2>&1"

# Check if already exists
if crontab -l 2>/dev/null | grep -q "boss.*backup"; then
    echo "  Backup cron already exists"
else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "  Backup cron installed: every $BACKUP_INTERVAL minutes"
fi

# ============================================================================
# 6. Final Status
# ============================================================================
echo ""
echo "============================================"
echo "Setup complete!"
echo ""
echo "Services:"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || docker compose ps
echo ""
echo "Next steps:"
echo "  1. Configure your brain provider in .env"
echo "  2. Set up OAuth for Google/Microsoft in .env"
echo "  3. Run: ./scripts/health-check.sh"
[ "$MULTI_TENANT" = true ] && echo "  4. Add tenants: ./scripts/onboard-tenant.sh <slug> <name>"
echo "============================================"

#!/usr/bin/env bash
# IR Custom AIOS v2 — Onboard New Tenant (multi-tenant mode)
# Usage: ./onboard-tenant.sh <tenant-slug> <tenant-name>
# Example: ./onboard-tenant.sh acme-corp "Acme Corporation"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi

TENANT_SLUG="${1:-}"
TENANT_NAME="${2:-}"

if [ -z "$TENANT_SLUG" ] || [ -z "$TENANT_NAME" ]; then
    echo "Usage: $0 <tenant-slug> <tenant-name>"
    echo "Example: $0 acme-corp \"Acme Corporation\""
    exit 1
fi

# Validate slug format
if ! echo "$TENANT_SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'; then
    echo "ERROR: Tenant slug must be 3-63 chars, lowercase alphanumeric with hyphens"
    exit 1
fi

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-boss}"
DB_NAME="${POSTGRES_DB:-boss_db}"
DB_PASSWORD="${POSTGRES_PASSWORD:-bosspass}"
WEAVIATE_URL="${WEAVIATE_URL:-http://localhost:${WEAVIATE_PORT:-8080}}"
REDIS_PORT="${REDIS_PORT:-6379}"

echo "============================================"
echo "Onboarding tenant: $TENANT_SLUG ($TENANT_NAME)"
echo "============================================"

# ============================================================================
# 1. Create tenant record in Postgres
# ============================================================================
echo ""
echo "--- Postgres ---"

TENANT_ID=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "
    INSERT INTO tenants (slug, name, status, config)
    VALUES ('$TENANT_SLUG', '$TENANT_NAME', 'onboarding', '{\"mode\": \"multi\"}')
    ON CONFLICT (slug) DO UPDATE SET name = '$TENANT_NAME'
    RETURNING id;
")

echo "  Tenant ID: $TENANT_ID"

# Create tenant-specific schema
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
    SELECT create_tenant_schema('$TENANT_SLUG');
"
echo "  Schema tenant_${TENANT_SLUG//-/_} created"

# ============================================================================
# 2. Create Weaviate collections (tenant-prefixed)
# ============================================================================
echo ""
echo "--- Weaviate ---"
TENANT_PREFIX="${TENANT_SLUG//-/_}"
bash "$PROJECT_DIR/services/weaviate/init-schema.sh" "$WEAVIATE_URL" "$TENANT_PREFIX"

# ============================================================================
# 3. Create Redis streams (tenant-prefixed)
# ============================================================================
echo ""
echo "--- Redis ---"
redis-cli -p "$REDIS_PORT" XGROUP CREATE "boss:events:$TENANT_SLUG" workers \$ MKSTREAM 2>/dev/null || true
redis-cli -p "$REDIS_PORT" XGROUP CREATE "boss:jobs:$TENANT_SLUG" workers \$ MKSTREAM 2>/dev/null || true
echo "  Streams created for tenant: $TENANT_SLUG"

# ============================================================================
# 4. Activate tenant
# ============================================================================
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
    UPDATE tenants SET status = 'active', updated_at = NOW() WHERE slug = '$TENANT_SLUG';
"

echo ""
echo "============================================"
echo "Tenant onboarded: $TENANT_SLUG"
echo "  ID: $TENANT_ID"
echo "  Postgres schema: tenant_${TENANT_SLUG//-/_}"
echo "  Weaviate prefix: ${TENANT_PREFIX}_"
echo "  Redis prefix: boss:*:$TENANT_SLUG"
echo ""
echo "Next: Configure brain + OAuth for this tenant"
echo "============================================"

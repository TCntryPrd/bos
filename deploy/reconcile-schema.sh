#!/bin/sh
# =============================================================================
# BOS — bulletproof schema reconcile. Runs as a one-shot INIT service on EVERY
# `docker compose up` (api/web depend on it completing). Idempotent + ADDITIVE:
#   • CREATE TABLE IF NOT EXISTS  → creates any missing table (all 85)
#   • ADD COLUMN IF NOT EXISTS    → adds any missing column to existing tables
# Works on fresh installs, rebuilds, AND repairs already-broken/partial installs.
# NEVER drops anything. This replaces the fragile postgres initdb hook (which only
# ran on an empty volume, so rebuilds/updates silently kept a stale/partial schema
# → the recurring "still no schema" failure).
# =============================================================================
set -u
PGHOST="${POSTGRES_HOST:-postgres}"
PGUSER="${POSTGRES_USER:-boss}"
PGDB="${POSTGRES_DB:-boss_ir}"
EXPECTED_TABLES="${BOS_EXPECTED_TABLES:-85}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PSQL="psql -h $PGHOST -U $PGUSER -d $PGDB -v ON_ERROR_STOP=0 -qtA"

echo "[reconcile] waiting for postgres at $PGHOST ..."
i=0; while [ "$i" -lt 90 ]; do
  pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 && break
  i=$((i+1)); sleep 2
done

echo "[reconcile] ensuring tables (CREATE TABLE IF NOT EXISTS) ..."
$PSQL -f "$DIR/schema-idempotent.sql" >/dev/null 2>&1

echo "[reconcile] ensuring columns (ADD COLUMN IF NOT EXISTS) ..."
$PSQL -f "$DIR/schema-columns.sql" >/dev/null 2>&1

COUNT="$($PSQL -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
echo "[reconcile] public tables present: ${COUNT:-0} (expected >= $EXPECTED_TABLES)"

if [ "${COUNT:-0}" -lt "$EXPECTED_TABLES" ]; then
  echo "[reconcile] !!! FAILED — schema incomplete (${COUNT:-0}/$EXPECTED_TABLES). Refusing to continue." >&2
  exit 1
fi
echo "[reconcile] OK — schema complete (${COUNT} tables)."

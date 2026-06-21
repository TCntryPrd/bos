#!/usr/bin/env bash
# deploy/migrate.sh — idempotent schema setup + numbered migrations.
#
# WS-3: replaces the old `psql < schema.sql` one-shot. Re-runnable (0 changes on a
# current DB). Idempotency comes from the LEDGER (_bos_migrate_log), NOT from
# `IF NOT EXISTS` DDL guards (which silently mask drift).
#
# Run from the compose project dir AFTER postgres is healthy:
#   bash deploy/migrate.sh
#
# Greenfield (empty DB)  -> applies deploy/schema.sql as the baseline.
# Existing schema (live) -> records the baseline MARKER without re-applying.
# Then applies any deploy/migrations/NNN_*.sql not yet in the ledger, in order,
# each inside its own transaction.
#
# Concurrency note: the installer runs this exactly once before the app accepts
# connections (compose depends_on ordering), so single-instance installs are safe.
# True multi-replica advisory-lock migration = the node-pg-migrate upgrade (Phase 6).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PGUSER="${POSTGRES_USER:-boss}"; PGDB="${POSTGRES_DB:-boss_ir}"

# PG_EXEC defaults to the compose postgres service; override for tests/other contexts
# (e.g. PG_EXEC="docker exec -i my-pg").
PSQL() { ${PG_EXEC:-docker compose exec -T postgres} psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 "$@"; }
Q() { PSQL -qtA -c "$1" | tr -d '[:space:]'; }
applied() { [ "$(Q "SELECT 1 FROM _bos_migrate_log WHERE id='$1' LIMIT 1;")" = "1" ]; }
record()  { PSQL -qtA -c "INSERT INTO _bos_migrate_log (id) VALUES ('$1') ON CONFLICT DO NOTHING;" >/dev/null; }

PSQL -qtA -c "CREATE TABLE IF NOT EXISTS _bos_migrate_log (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null
echo "[migrate] ledger ready."

# --- baseline ---
if applied "000_baseline"; then
  echo "[migrate] 000_baseline already applied — skipping."
else
  HAS_SCHEMA="$(Q "SELECT (to_regclass('public.tenants') IS NOT NULL)::text;")"
  if [ "$HAS_SCHEMA" = "t" ]; then
    echo "[migrate] existing schema detected -> recording baseline MARKER (no re-apply)."
  else
    echo "[migrate] empty DB -> applying baseline deploy/schema.sql ..."
    PSQL < "$DIR/schema.sql"
  fi
  record "000_baseline"
  echo "[migrate] 000_baseline OK."
fi

# --- numbered forward migrations ---
shopt -s nullglob
for f in "$DIR"/migrations/*.sql; do
  id="$(basename "$f" .sql)"
  if applied "$id"; then continue; fi
  echo "[migrate] applying $id ..."
  PSQL -1 < "$f"
  record "$id"
  echo "[migrate] $id OK."
done

echo "[migrate] done — ledger has $(Q "SELECT count(*) FROM _bos_migrate_log;") entries."

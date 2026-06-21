# Schema migrations (WS-3)

Forward-only, numbered SQL migrations applied by `../migrate.sh` after the
`000_baseline` (which is `../schema.sql`). Idempotency is enforced by the
`schema_migrations` ledger, **not** by `IF NOT EXISTS` guards.

## Rules
- Name files `NNN_short_description.sql` (e.g. `001_add_outbox.sql`), zero-padded, monotonically increasing.
- Each file is applied **once**, inside a single transaction (`psql -1`). Keep them transactional (no `CREATE INDEX CONCURRENTLY`).
- **Never edit an applied migration.** Fix forward with a new file.
- Record a one-line rollback note at the top of each migration.
- The baseline (`schema.sql`) is the full current schema; on an existing DB the runner records a marker without re-applying.

## What belongs here (forward fixes the plan calls out)
- `server.ts` inline DDL (boss_oauth_tokens / boss_oauth_state / invites / runtime_config / boss_email_log / boss_memory) folded into a numbered migration once removed from `server.ts`.
- Ghost-tenant backfill (only needed when upgrading a live DB that has data on a random-uuid tenant).
- Duplicate-table consolidation (oauth_tokens, users) — deprecate via migration.

(Empty on a greenfield install — the baseline + seed are sufficient.)

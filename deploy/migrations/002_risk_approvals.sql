-- 002_risk_approvals.sql  (P1 — Fusion CoS risk/approval spine)
-- Rollback: DROP TABLE boss_approvals, boss_autonomy_policy;
--
-- Adds the human-in-the-loop approval lifecycle. `risk` is an axis ORTHOGONAL to the
-- existing trust tiers (trust = who may call a tool; risk = how dangerous the action is).
-- A tool whose effective risk tier exceeds the tenant's autonomy ceiling is NOT executed —
-- a pending approval row is created and surfaced in the "Needs Your OK" dashboard tile.

CREATE TABLE boss_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  user_id         TEXT,
  conversation_id TEXT,
  agent_name      TEXT,
  tool_name       TEXT NOT NULL,
  tool_args       JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_tier       SMALLINT NOT NULL,
  commit_message  TEXT NOT NULL,                 -- human-readable "I am about to ..."
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied|expired|executed|failed
  result          TEXT,                          -- tool result once executed
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX idx_boss_approvals_pending
  ON boss_approvals (tenant_id, created_at DESC)
  WHERE status = 'pending';

-- Standing autonomy policy: the ceiling below which tools auto-execute.
-- max_auto_risk_tier 1 (default) = read(0) + internal-write(1) auto; external-comms(2)
-- and irreversible/financial(3) require approval.
CREATE TABLE boss_autonomy_policy (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   TEXT NOT NULL,
  scope                       TEXT NOT NULL DEFAULT 'default',
  max_auto_risk_tier          SMALLINT NOT NULL DEFAULT 1,
  daily_spend_cap_usd         NUMERIC(10,2),
  require_approval_over_amount NUMERIC(12,2),
  quiet_hours                 JSONB,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope)
);

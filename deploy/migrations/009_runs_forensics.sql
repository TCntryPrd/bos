-- 009_runs_forensics.sql  (P1 — Fusion CoS)
-- Rollback: DROP TRIGGER boss_cos_audit_immutable ON boss_cos_audit; DROP FUNCTION boss_cos_audit_no_mutate();
--           DROP TABLE boss_cos_audit, boss_tool_invocations;
--
-- Forensic ledger of every risk-bearing tool call, plus an append-only audit log.

CREATE TABLE boss_tool_invocations (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  user_id         TEXT,
  conversation_id TEXT,
  agent_name      TEXT,
  tool_name       TEXT NOT NULL,
  risk_tier       SMALLINT NOT NULL,
  status          TEXT NOT NULL,        -- executed|pending_approval|denied|failed
  approval_id     UUID,
  latency_ms      INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_boss_tool_invocations_recent
  ON boss_tool_invocations (tenant_id, created_at DESC);

-- Append-only audit. Immutability is enforced by a trigger (works even for the table
-- owner, unlike a plain REVOKE), so approvals/denials/sensitive executions cannot be
-- silently rewritten.
CREATE TABLE boss_cos_audit (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  actor      TEXT,                       -- user id / agent name / 'system'
  action     TEXT NOT NULL,              -- e.g. approval.created, approval.approved, tool.executed
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION boss_cos_audit_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'boss_cos_audit is append-only (no UPDATE/DELETE)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER boss_cos_audit_immutable
  BEFORE UPDATE OR DELETE ON boss_cos_audit
  FOR EACH ROW EXECUTE FUNCTION boss_cos_audit_no_mutate();

-- IR Custom AIOS v3 — token ledger (the token-conscious spine).
-- Every model call (runtime AND build) lands one row. Budgets read from this.
CREATE TABLE IF NOT EXISTS token_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     text NOT NULL DEFAULT 'default',
  ts            timestamptz NOT NULL DEFAULT now(),
  agent_kind    text NOT NULL,              -- rascal|outsider|manager|orchestrator|build
  agent_handle  text,                       -- e.g. darla
  session_id    uuid,                        -- boss_chat_sessions.id when applicable
  task_class    text,                        -- triage|work|heavy|extract|route|...
  provider      text NOT NULL,               -- anthropic|google|openai|xai
  model         text NOT NULL,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  cached_in     integer NOT NULL DEFAULT 0,  -- prompt-cache read tokens
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms    integer,
  escalated     boolean NOT NULL DEFAULT false,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_token_ledger_ts       ON token_ledger (ts DESC);
CREATE INDEX IF NOT EXISTS idx_token_ledger_agent    ON token_ledger (agent_kind, agent_handle, ts DESC);
CREATE INDEX IF NOT EXISTS idx_token_ledger_provider ON token_ledger (provider, model, ts DESC);

-- per-agent/day rollup for budget checks + dashboards
CREATE OR REPLACE VIEW token_ledger_daily AS
SELECT date_trunc('day', ts) AS day, agent_kind, agent_handle, provider, model,
       sum(tokens_in) AS tin, sum(tokens_out) AS tout, sum(cached_in) AS cached,
       round(sum(cost_usd),4) AS cost_usd, count(*) AS calls
FROM token_ledger GROUP BY 1,2,3,4,5;

-- per-agent/day budget caps (NULL = no cap). Enforced in app; escalate on breach.
CREATE TABLE IF NOT EXISTS token_budget (
  tenant_id    text NOT NULL DEFAULT 'default',
  agent_kind   text NOT NULL,
  agent_handle text NOT NULL DEFAULT '*',    -- '*' = applies to all of kind
  daily_usd_cap numeric(10,2),
  hard_stop    boolean NOT NULL DEFAULT false, -- true=block, false=warn+escalate
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_kind, agent_handle)
);

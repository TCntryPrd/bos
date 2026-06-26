-- 004_model_routes_budgets.sql  (P2 — Fusion CoS model routing + spend discipline)
-- Rollback: DROP TABLE boss_model_routes, boss_budgets;
--
-- Model-route LABELS let an agent's `model` be a capability label (e.g. 'reasoning',
-- 'cheap', 'voice') that resolves to a concrete provider/model with fallback ordering —
-- swap the model behind a label without editing every agent. boss_budgets adds a spend
-- cap on top of the existing cost ledger (boss_agent_runs.cost_usd). Both keyed by tenant;
-- empty = pass-through (agents keep their explicit models; no cap enforced).

CREATE TABLE boss_model_routes (
  tenant_id  TEXT NOT NULL,
  label      TEXT NOT NULL,           -- reasoning | cheap | voice | draft | cos_brain | ...
  provider   TEXT,                    -- openrouter | nim | ... (NULL = derive from model id)
  model      TEXT NOT NULL,           -- concrete model id
  priority   SMALLINT NOT NULL DEFAULT 1,  -- lower = preferred (fallback order)
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, label, model)
);

CREATE TABLE boss_budgets (
  tenant_id  TEXT NOT NULL,
  period     TEXT NOT NULL DEFAULT 'monthly',  -- monthly | daily
  cap_usd    NUMERIC(10,2) NOT NULL,
  alert_pct  SMALLINT NOT NULL DEFAULT 80,
  hard_stop  BOOLEAN NOT NULL DEFAULT false,   -- true = skip costly (paid) agents once over cap
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

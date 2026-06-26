-- 006_dashboard_of_life.sql  (P3 — Fusion CoS "Dashboard of Life")
-- Rollback: DROP TABLE boss_life_metrics, boss_personas;
--
-- The life-domain ontology behind the "Dashboard of Life" tile. Objective domains
-- (wealth/business/pipeline/projects/operations) are computed live from existing
-- snapshots; subjective domains (focus/energy) + any manual override live here.
-- boss_personas backs the Chief-of-Staff persona switcher (config-as-data).

CREATE TABLE boss_life_metrics (
  tenant_id   TEXT NOT NULL,
  domain      TEXT NOT NULL,          -- wealth|business|pipeline|projects|operations|focus|energy|growth
  label       TEXT NOT NULL,
  value       NUMERIC,
  unit        TEXT,                   -- $ | % | score | count | x5
  display     TEXT,                   -- pre-formatted display (overrides value formatting)
  trend       TEXT,                   -- up | down | flat
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',  -- computed | manual
  as_of       TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain)
);

CREATE TABLE boss_personas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  system_addendum TEXT,               -- appended to the CoS prompt when active
  model_label     TEXT,               -- optional capability label (P2 model-router)
  active          BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

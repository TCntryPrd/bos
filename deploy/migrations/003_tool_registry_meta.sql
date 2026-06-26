-- 003_tool_registry_meta.sql  (P1 — Fusion CoS)
-- Rollback: DROP TABLE boss_tool_meta;
--
-- Optional per-tool risk overrides. The in-code TOOL_RISK map (tools/risk.ts) is the
-- source of truth; a row here overrides it at runtime (e.g. raise a tool's tier without
-- a redeploy). Unknown tools fail-safe to tier 2 in code regardless.

CREATE TABLE boss_tool_meta (
  tool_name   TEXT PRIMARY KEY,
  risk_tier   SMALLINT,            -- NULL = use code default
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

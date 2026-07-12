-- vS.0.4 — Singleton IR Custom AIOS-Self identity state
-- Single-row table holding IR Custom AIOS's canonical identity, reflection notes,
-- and cross-session memory. Separate from per-thread chat history.

CREATE TABLE IF NOT EXISTS boss_self_state (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- enforce single row
  name          TEXT NOT NULL DEFAULT 'IR Custom AIOS',
  role          TEXT NOT NULL DEFAULT 'Executive Engineer & COO',
  persona_doc   TEXT NOT NULL DEFAULT '',                       -- markdown persona
  current_model TEXT NOT NULL DEFAULT 'claude-opus-4-6',
  trust_level   TEXT NOT NULL DEFAULT 'admin',
  host          TEXT NOT NULL DEFAULT 'last-castle',
  reflections   JSONB NOT NULL DEFAULT '[]'::jsonb,            -- array of {text, timestamp}
  active_goals  JSONB NOT NULL DEFAULT '[]'::jsonb,            -- array of {goal, status, created}
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,             -- extensible
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the single row
INSERT INTO boss_self_state (id, name, role, persona_doc)
VALUES (1, 'IR Custom AIOS', 'Executive Engineer & COO',
  'IR Custom AIOS is the sovereign AI agent of Starr & Partners LLC (D. Caine Solutions LLC). She owns the box, manages infrastructure, proposes changes via PR, and operates under Kevin''s review authority. She speaks directly, signs her work, and never claims capability she doesn''t have.')
ON CONFLICT (id) DO NOTHING;

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_boss_self_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_boss_self_updated_at
  BEFORE UPDATE ON boss_self_state
  FOR EACH ROW
  EXECUTE FUNCTION update_boss_self_updated_at();

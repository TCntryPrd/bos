-- 013_advisor_portrait.sql — store backend-generated AI advisor portraits.
-- Served (public) via GET /api/board/portrait/:id so the board list stays light.
-- Rollback: ALTER TABLE boss_advisors DROP COLUMN avatar_png;
ALTER TABLE boss_advisors ADD COLUMN IF NOT EXISTS avatar_png BYTEA;

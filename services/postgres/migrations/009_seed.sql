-- =============================================================================
-- IR Custom AIOS v2 — Migration 009: Production-safe baseline seed
-- Purpose: keep a fresh install branded and usable without creating demo
--          tenants, fake users, or placeholder connected accounts.
-- =============================================================================

UPDATE tenants
SET
    name       = 'IR Custom AIOS Workspace',
    brain_type = 'claude',
    suite_type = 'google',
    status     = 'active',
    plan       = 'single',
    timezone   = COALESCE(timezone, 'America/Chicago')
WHERE slug = 'default';

-- =============================================================================
-- IR Custom AIOS v2 — Migration 003: Brain
-- Tables: brain_config
-- Supports capability-based Brain Router with primary + fallback brains.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BRAIN_CONFIG
-- Configuration for each brain adapter registered to a tenant.
-- A tenant can have multiple brain configs: one primary, one fallback.
-- The Brain Router reads capabilities_json to decide how to route each request.
-- api_key_encrypted is AES-256 ciphertext — decryption key outside the DB.
-- ---------------------------------------------------------------------------
CREATE TABLE brain_config (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    brain_type          VARCHAR(50) NOT NULL
                            CHECK (brain_type IN ('claude', 'openai', 'gemini', 'openclaw', 'custom')),
    label               VARCHAR(100) NOT NULL DEFAULT 'primary',   -- human label: 'primary', 'fallback', 'vision'
    endpoint            TEXT,                                       -- NULL = use provider default
    model               VARCHAR(100),                              -- e.g. 'claude-3-5-sonnet-20241022'
    api_key_encrypted   BYTEA,                                     -- NULL = use env var
    capabilities_json   JSONB       NOT NULL DEFAULT '{}',
    -- Capability flags mirroring BrainCapabilities interface in types.ts:
    -- { canChat, canStream, canUseTools, canAccessMCP, canExecuteCode,
    --   canSpawnAgents, canMaintainMemory, canProcessVoice,
    --   canProcessImages, canProcessDocuments }
    is_primary          BOOLEAN     NOT NULL DEFAULT false,
    is_fallback         BOOLEAN     NOT NULL DEFAULT false,
    is_active           BOOLEAN     NOT NULL DEFAULT true,
    priority            INTEGER     NOT NULL DEFAULT 100,           -- lower = preferred when routing
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, label)
);

COMMENT ON TABLE brain_config IS
    'Brain adapter configuration for the Brain Router. '
    'A tenant may register multiple brains; is_primary=true is the default. '
    'is_fallback=true is used if the primary fails (fallback.ts middleware). '
    'capabilities_json is read by the router to decide whether to use tool-calling, '
    'MCP, or plain-prompt mode for each request.';

COMMENT ON COLUMN brain_config.capabilities_json IS
    'JSON object with boolean capability flags. See BrainCapabilities interface in packages/brain/types.ts.';

COMMENT ON COLUMN brain_config.priority IS
    'Routing priority when multiple brains could serve a request. Lower integer = higher priority.';

CREATE INDEX idx_brain_config_tenant_id ON brain_config(tenant_id);
CREATE INDEX idx_brain_config_primary ON brain_config(tenant_id) WHERE is_primary = true;
CREATE INDEX idx_brain_config_active ON brain_config(tenant_id, is_active) WHERE is_active = true;

CREATE TRIGGER trg_brain_config_updated_at
    BEFORE UPDATE ON brain_config
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- =============================================================================
-- IR Custom AIOS v2 — Migration 002: Connectors
-- Tables: oauth_tokens, connected_accounts
-- Supports AES-256 encrypted token storage for M365 and Google Workspace.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- OAUTH_TOKENS
-- Stores encrypted OAuth2 access and refresh tokens for business suite
-- connectors. One row per provider-account combination per tenant.
-- access_token_encrypted and refresh_token_encrypted are AES-256 ciphertext
-- stored as bytea; decryption key lives outside the database.
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_tokens (
    id                          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id                     UUID        REFERENCES users(id) ON DELETE CASCADE,   -- NULL = tenant-level token
    provider                    VARCHAR(50) NOT NULL
                                    CHECK (provider IN ('google', 'microsoft', 'slack', 'stripe', 'custom')),
    account_label               VARCHAR(100) NOT NULL DEFAULT 'primary',   -- 'work', 'personal', etc.
    service                     VARCHAR(100) NOT NULL DEFAULT 'all',        -- 'gmail', 'calendar', 'drive', 'all'
    access_token_encrypted      BYTEA       NOT NULL,
    refresh_token_encrypted     BYTEA,                                      -- not all providers issue refresh tokens
    expires_at                  TIMESTAMPTZ,
    scopes                      TEXT[]      NOT NULL DEFAULT '{}',
    status                      VARCHAR(20) NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'expired', 'revoked', 'error')),
    last_refresh_at             TIMESTAMPTZ,
    refresh_error               TEXT,                                       -- last error message from refresh attempt
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, provider, account_label, service)
);

COMMENT ON TABLE oauth_tokens IS
    'Encrypted OAuth2 tokens for external service connections. '
    'Tokens are AES-256 encrypted before storage; the encryption key is never stored here. '
    'The connector layer calls token-store.ts to decrypt on demand. '
    'status=expired triggers auto-refresh; status=revoked requires user re-auth.';

COMMENT ON COLUMN oauth_tokens.service IS
    'Which service this token covers. May be ''all'' if a single OAuth grant covers all services for a provider, '
    'or specific (''gmail'', ''calendar'') if the user did a scoped grant.';

COMMENT ON COLUMN oauth_tokens.account_label IS
    'Human label for this account (work, personal, client). Supports multi-account per provider.';

CREATE INDEX idx_oauth_tokens_tenant_id ON oauth_tokens(tenant_id);
CREATE INDEX idx_oauth_tokens_user_id ON oauth_tokens(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_oauth_tokens_provider ON oauth_tokens(tenant_id, provider);
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at) WHERE status = 'active';  -- refresh sweep

CREATE TRIGGER trg_oauth_tokens_updated_at
    BEFORE UPDATE ON oauth_tokens
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- CONNECTED_ACCOUNTS
-- High-level registry of which external accounts a tenant has connected.
-- Companion to oauth_tokens — this is the "what" (human-readable account
-- metadata), while oauth_tokens is the "how" (credentials).
-- ---------------------------------------------------------------------------
CREATE TABLE connected_accounts (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID        REFERENCES users(id) ON DELETE CASCADE,
    provider        VARCHAR(50) NOT NULL
                        CHECK (provider IN ('google', 'microsoft', 'slack', 'stripe', 'custom')),
    account_email   VARCHAR(320),
    account_name    VARCHAR(255),
    account_label   VARCHAR(100) NOT NULL DEFAULT 'primary',
    services_json   JSONB        NOT NULL DEFAULT '[]',  -- array of service names active for this account
    is_primary      BOOLEAN      NOT NULL DEFAULT false,
    connected_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    disconnected_at TIMESTAMPTZ,                         -- NULL = still connected
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, provider, account_label)
);

COMMENT ON TABLE connected_accounts IS
    'Human-readable registry of external accounts a tenant has connected. '
    'services_json lists which capabilities are active, e.g. ["gmail","calendar","drive"]. '
    'disconnected_at is set (not deleted) when an account is removed so history is preserved.';

COMMENT ON COLUMN connected_accounts.services_json IS
    'Array of service strings active for this account. '
    'Example: ["gmail", "calendar", "drive", "contacts"]';

CREATE INDEX idx_connected_accounts_tenant_id ON connected_accounts(tenant_id);
CREATE INDEX idx_connected_accounts_provider ON connected_accounts(tenant_id, provider);
CREATE INDEX idx_connected_accounts_active ON connected_accounts(tenant_id)
    WHERE disconnected_at IS NULL;

-- =============================================================================
-- IR Custom AIOS v2 — Migration 001: Foundation
-- Tables: tenants, users, sessions
-- Supports: single-tenant (one row in tenants) and multi-tenant (schema-per-tenant)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- updated_at trigger function (reused by all tables)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION boss_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- TENANTS
-- Represents an isolated deployment unit.
-- Single-tenant mode: exactly one row with slug = 'default'.
-- Multi-tenant mode: one row per customer, each gets a dedicated Postgres
-- schema (tenant_{slug}), a Weaviate collection prefix, and a Redis key prefix.
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255)    NOT NULL,
    slug            VARCHAR(63)     NOT NULL UNIQUE,   -- used for schema name, subdomain, Redis prefix
    brain_type      VARCHAR(50)     NOT NULL DEFAULT 'claude'
                        CHECK (brain_type IN ('claude', 'openai', 'gemini', 'openclaw', 'custom')),
    brain_config    JSONB           NOT NULL DEFAULT '{}',  -- endpoint, model, extra params
    suite_type      VARCHAR(20)     NOT NULL DEFAULT 'google'
                        CHECK (suite_type IN ('google', 'microsoft', 'both')),
    status          VARCHAR(20)     NOT NULL DEFAULT 'onboarding'
                        CHECK (status IN ('onboarding', 'active', 'suspended', 'archived')),
    plan            VARCHAR(50)     NOT NULL DEFAULT 'single',  -- single, pro, enterprise
    timezone        VARCHAR(100)    NOT NULL DEFAULT 'UTC',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS
    'Top-level isolation unit. In single-tenant mode this has exactly one row. '
    'In multi-tenant mode each customer is a row and gets a dedicated schema named tenant_{slug}.';

COMMENT ON COLUMN tenants.brain_type IS 'Which AI brain provider this tenant uses. Drives Brain Router configuration.';
COMMENT ON COLUMN tenants.brain_config IS 'Brain-specific config: endpoint URL, model name, capability overrides.';
COMMENT ON COLUMN tenants.suite_type IS 'Which business suite the tenant uses. Drives connector routing.';

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_status ON tenants(status);

CREATE TRIGGER trg_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- Single-tenant default row — always present regardless of mode.
INSERT INTO tenants (name, slug, brain_type, suite_type, status, plan)
VALUES ('Default', 'default', 'claude', 'google', 'active', 'single');

-- ---------------------------------------------------------------------------
-- USERS
-- Individual accounts within a tenant.
-- In single-tenant mode all users belong to the 'default' tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username        VARCHAR(100)    NOT NULL,
    email           VARCHAR(320)    NOT NULL,
    password_hash   TEXT,                          -- NULL for OAuth-only accounts
    role            VARCHAR(50)     NOT NULL DEFAULT 'user'
                        CHECK (role IN ('owner', 'admin', 'user', 'viewer')),
    display_name    VARCHAR(255),
    avatar_url      TEXT,
    settings        JSONB           NOT NULL DEFAULT '{}',
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, email),
    UNIQUE (tenant_id, username)
);

COMMENT ON TABLE users IS
    'User accounts scoped to a tenant. password_hash is NULL for SSO/OAuth-only users.';

COMMENT ON COLUMN users.role IS 'owner = full control; admin = manage users/config; user = standard; viewer = read-only.';

CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_tenant_role ON users(tenant_id, role);

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- SESSIONS
-- Short-lived auth tokens. Expired rows are pruned by the worker process.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    token       TEXT        NOT NULL UNIQUE,    -- opaque bearer token or JWT ID
    device_hint VARCHAR(255),                   -- 'Chrome/Windows', 'iPhone', etc.
    ip_address  INET,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sessions IS
    'Active auth sessions. Token is an opaque value stored as a hash in production. '
    'Expired rows should be purged by the background worker on a regular schedule.';

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);   -- for purge queries

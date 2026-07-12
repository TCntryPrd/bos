-- =============================================================================
-- IR Custom AIOS v2 — Migration 002b: Multi-Tenant Schema Functions
-- Provides: create_tenant_schema(), drop_tenant_schema(), list_tenant_schemas()
-- Depends on: 001_foundation.sql (boss_set_updated_at trigger function)
--
-- Schema-per-tenant isolation model:
--   In single-tenant mode all tables live in `public`.
--   In multi-tenant mode each tenant gets a dedicated schema named `tenant_{slug}`.
--   Within that schema, tables carry no tenant_id FK (tenant is implicit in the schema).
--   The global `tenants` table in `public` remains the registry for all tenants.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CREATE TENANT SCHEMA
-- Provisions a full isolated schema for one tenant.
-- Call this immediately after inserting a row into public.tenants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_tenant_schema(p_tenant_slug VARCHAR)
RETURNS VOID AS $$
DECLARE
    schema_name TEXT := 'tenant_' || replace(p_tenant_slug, '-', '_');
BEGIN
    -- Validate slug to prevent SQL injection (alphanumeric + hyphen/underscore only)
    IF p_tenant_slug !~ '^[a-zA-Z0-9_-]+$' THEN
        RAISE EXCEPTION 'Invalid tenant slug: %. Only alphanumeric, hyphen, and underscore are allowed.', p_tenant_slug;
    END IF;

    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', schema_name);

    -- -------------------------------------------------------------------------
    -- USERS (per-tenant copy — no tenant_id FK; tenant is implicit in schema)
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.users (
            id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
            username        VARCHAR(100)    NOT NULL UNIQUE,
            email           VARCHAR(320)    NOT NULL UNIQUE,
            password_hash   TEXT,
            role            VARCHAR(50)     NOT NULL DEFAULT 'user'
                                CHECK (role IN ('owner', 'admin', 'user', 'viewer')),
            display_name    VARCHAR(255),
            avatar_url      TEXT,
            settings        JSONB           NOT NULL DEFAULT '{}',
            last_active_at  TIMESTAMPTZ,
            created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name);

    EXECUTE format($tbl$
        CREATE TRIGGER trg_users_updated_at
            BEFORE UPDATE ON %I.users
            FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at()
    $tbl$, schema_name);

    -- -------------------------------------------------------------------------
    -- SESSIONS
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.sessions (
            id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id     UUID        NOT NULL REFERENCES %I.users(id) ON DELETE CASCADE,
            token       TEXT        NOT NULL UNIQUE,
            device_hint VARCHAR(255),
            ip_address  INET,
            expires_at  TIMESTAMPTZ NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($idx$
        CREATE INDEX ON %I.sessions(user_id);
        CREATE INDEX ON %I.sessions(expires_at)
    $idx$, schema_name, schema_name);

    -- -------------------------------------------------------------------------
    -- PREFERENCES
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.preferences (
            id          UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id     UUID            REFERENCES %I.users(id) ON DELETE CASCADE,
            rule        TEXT            NOT NULL,
            category    VARCHAR(100)    NOT NULL DEFAULT 'general',
            weight      REAL            NOT NULL DEFAULT 1.0 CHECK (weight BETWEEN 0 AND 10),
            source      VARCHAR(50)     NOT NULL DEFAULT 'explicit'
                            CHECK (source IN ('explicit', 'learned', 'onboarding', 'suggested')),
            is_active   BOOLEAN         NOT NULL DEFAULT true,
            context     JSONB           NOT NULL DEFAULT '{}',
            created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($tbl$
        CREATE INDEX ON %I.preferences(user_id) WHERE user_id IS NOT NULL;
        CREATE INDEX ON %I.preferences(category) WHERE is_active = true
    $tbl$, schema_name, schema_name);

    EXECUTE format($tbl$
        CREATE TRIGGER trg_preferences_updated_at
            BEFORE UPDATE ON %I.preferences
            FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at()
    $tbl$, schema_name);

    -- -------------------------------------------------------------------------
    -- BEHAVIORAL_PATTERNS
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.behavioral_patterns (
            id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id             UUID        REFERENCES %I.users(id) ON DELETE CASCADE,
            pattern_type        VARCHAR(100) NOT NULL,
            pattern_data        JSONB       NOT NULL DEFAULT '{}',
            description         TEXT,
            confidence          REAL        NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
            observation_count   INTEGER     NOT NULL DEFAULT 1,
            first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($idx$
        CREATE INDEX ON %I.behavioral_patterns(user_id, pattern_type);
        CREATE INDEX ON %I.behavioral_patterns(confidence DESC)
    $idx$, schema_name, schema_name);

    EXECUTE format($tbl$
        CREATE TRIGGER trg_behavioral_patterns_updated_at
            BEFORE UPDATE ON %I.behavioral_patterns
            FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at()
    $tbl$, schema_name);

    -- -------------------------------------------------------------------------
    -- LEARNING_PROFILES
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.learning_profiles (
            id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id                 UUID        NOT NULL UNIQUE REFERENCES %I.users(id) ON DELETE CASCADE,
            profile_json            JSONB       NOT NULL DEFAULT '{}',
            communication_style     VARCHAR(100) NOT NULL DEFAULT 'unknown'
                                        CHECK (communication_style IN
                                            ('formal', 'professional-direct', 'casual', 'technical', 'concise', 'unknown')),
            onboarding_complete     BOOLEAN     NOT NULL DEFAULT false,
            profile_version         INTEGER     NOT NULL DEFAULT 1,
            last_synthesized_at     TIMESTAMPTZ,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($tbl$
        CREATE TRIGGER trg_learning_profiles_updated_at
            BEFORE UPDATE ON %I.learning_profiles
            FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at()
    $tbl$, schema_name);

    -- -------------------------------------------------------------------------
    -- ONBOARDING_PROGRESS
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.onboarding_progress (
            id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id         UUID        NOT NULL REFERENCES %I.users(id) ON DELETE CASCADE,
            platform        VARCHAR(50) NOT NULL,
            status          VARCHAR(20) NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
            items_processed INTEGER     NOT NULL DEFAULT 0,
            total_items     INTEGER     NOT NULL DEFAULT 0,
            error_message   TEXT,
            metadata        JSONB       NOT NULL DEFAULT '{}',
            started_at      TIMESTAMPTZ,
            completed_at    TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, platform)
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($idx$
        CREATE INDEX ON %I.onboarding_progress(user_id);
        CREATE INDEX ON %I.onboarding_progress(status)
    $idx$, schema_name, schema_name);

    -- -------------------------------------------------------------------------
    -- VOICE_DEVICES
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.voice_devices (
            id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            device_id           VARCHAR(100) NOT NULL UNIQUE,
            name                VARCHAR(255) NOT NULL,
            room                VARCHAR(100) NOT NULL,
            status              VARCHAR(20) NOT NULL DEFAULT 'online'
                                    CHECK (status IN ('online', 'offline', 'error')),
            last_seen_at        TIMESTAMPTZ,
            firmware_version    VARCHAR(50),
            config              JSONB       NOT NULL DEFAULT '{}',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name);

    EXECUTE format($tbl$
        CREATE TRIGGER trg_voice_devices_updated_at
            BEFORE UPDATE ON %I.voice_devices
            FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at()
    $tbl$, schema_name);

    -- -------------------------------------------------------------------------
    -- EVENTS
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.events (
            id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id         UUID        REFERENCES %I.users(id) ON DELETE SET NULL,
            event_type      VARCHAR(100) NOT NULL,
            source          VARCHAR(50) NOT NULL DEFAULT 'system',
            payload         JSONB       NOT NULL DEFAULT '{}',
            processed       BOOLEAN     NOT NULL DEFAULT false,
            processed_at    TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($idx$
        CREATE INDEX ON %I.events(event_type, created_at DESC);
        CREATE INDEX ON %I.events(processed, created_at) WHERE processed = false
    $idx$, schema_name, schema_name);

    -- -------------------------------------------------------------------------
    -- EVENT_RULES
    -- -------------------------------------------------------------------------
    EXECUTE format($tbl$
        CREATE TABLE %I.event_rules (
            id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id         UUID        REFERENCES %I.users(id) ON DELETE CASCADE,
            name            VARCHAR(255) NOT NULL,
            event_type      VARCHAR(100) NOT NULL,
            conditions      JSONB       NOT NULL DEFAULT '{}',
            actions         JSONB       NOT NULL DEFAULT '[]',
            is_active       BOOLEAN     NOT NULL DEFAULT true,
            priority        INTEGER     NOT NULL DEFAULT 100,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    $tbl$, schema_name, schema_name);

    EXECUTE format($idx$
        CREATE INDEX ON %I.event_rules(event_type) WHERE is_active = true;
        CREATE INDEX ON %I.event_rules(user_id) WHERE user_id IS NOT NULL
    $idx$, schema_name, schema_name);

    EXECUTE format($tbl$
        CREATE TRIGGER trg_event_rules_updated_at
            BEFORE UPDATE ON %I.event_rules
            FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at()
    $tbl$, schema_name);

    RAISE NOTICE 'Tenant schema % created successfully', schema_name;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_tenant_schema(VARCHAR) IS
    'Provisions a complete isolated schema for one tenant in multi-tenant mode. '
    'Call after inserting a row into public.tenants. '
    'Schema name format: tenant_{slug} (hyphens replaced with underscores).';

-- ---------------------------------------------------------------------------
-- DROP TENANT SCHEMA
-- Permanently destroys all data for one tenant. Use with explicit confirmation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION drop_tenant_schema(p_tenant_slug VARCHAR)
RETURNS VOID AS $$
DECLARE
    schema_name TEXT := 'tenant_' || replace(p_tenant_slug, '-', '_');
BEGIN
    IF p_tenant_slug !~ '^[a-zA-Z0-9_-]+$' THEN
        RAISE EXCEPTION 'Invalid tenant slug: %', p_tenant_slug;
    END IF;

    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_name);
    RAISE NOTICE 'Tenant schema % dropped', schema_name;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION drop_tenant_schema(VARCHAR) IS
    'Permanently drops the tenant schema and all data within it. Irreversible. '
    'Does not delete the row in public.tenants — caller must do that separately if desired.';

-- ---------------------------------------------------------------------------
-- LIST TENANT SCHEMAS
-- Returns all active tenant schemas currently provisioned in this database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_tenant_schemas()
RETURNS TABLE(schema_name TEXT, tenant_slug TEXT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.schema_name::TEXT,
        replace(replace(s.schema_name::TEXT, 'tenant_', ''), '_', '-') AS tenant_slug
    FROM information_schema.schemata s
    WHERE s.schema_name LIKE 'tenant_%'
    ORDER BY s.schema_name;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION list_tenant_schemas() IS
    'Returns (schema_name, tenant_slug) for every provisioned tenant schema. '
    'Used by admin tooling and health checks to enumerate active tenants.';

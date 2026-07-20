--
-- PostgreSQL database dump
--

\restrict EJp2pm4LR22y0NVAnMFgxazcdiPxGIAtHUXnyvSlRitpx6jExnibEX6y9NaCh0O

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: create_tenant_schema(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_tenant_schema(p_tenant_slug character varying) RETURNS void
    LANGUAGE plpgsql
    AS $_$
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
            FOR EACH ROW EXECUTE FUNCTION ircaios_set_updated_at()
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
            FOR EACH ROW EXECUTE FUNCTION ircaios_set_updated_at()
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
            FOR EACH ROW EXECUTE FUNCTION ircaios_set_updated_at()
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
            FOR EACH ROW EXECUTE FUNCTION ircaios_set_updated_at()
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
            FOR EACH ROW EXECUTE FUNCTION ircaios_set_updated_at()
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
            FOR EACH ROW EXECUTE FUNCTION ircaios_set_updated_at()
    $tbl$, schema_name);

    RAISE NOTICE 'Tenant schema % created successfully', schema_name;
END;
$_$;


--
-- Name: FUNCTION create_tenant_schema(p_tenant_slug character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_tenant_schema(p_tenant_slug character varying) IS 'Provisions a complete isolated schema for one tenant in multi-tenant mode. Call after inserting a row into public.tenants. Schema name format: tenant_{slug} (hyphens replaced with underscores).';


--
-- Name: drop_tenant_schema(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.drop_tenant_schema(p_tenant_slug character varying) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE
    schema_name TEXT := 'tenant_' || replace(p_tenant_slug, '-', '_');
BEGIN
    IF p_tenant_slug !~ '^[a-zA-Z0-9_-]+$' THEN
        RAISE EXCEPTION 'Invalid tenant slug: %', p_tenant_slug;
    END IF;

    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_name);
    RAISE NOTICE 'Tenant schema % dropped', schema_name;
END;
$_$;


--
-- Name: FUNCTION drop_tenant_schema(p_tenant_slug character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.drop_tenant_schema(p_tenant_slug character varying) IS 'Permanently drops the tenant schema and all data within it. Irreversible. Does not delete the row in public.tenants — caller must do that separately if desired.';


--
-- Name: ircaios_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ircaios_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: list_tenant_schemas(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_tenant_schemas() RETURNS TABLE(schema_name text, tenant_slug text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.schema_name::TEXT,
        replace(replace(s.schema_name::TEXT, 'tenant_', ''), '_', '-') AS tenant_slug
    FROM information_schema.schemata s
    WHERE s.schema_name LIKE 'tenant_%'
    ORDER BY s.schema_name;
END;
$$;


--
-- Name: FUNCTION list_tenant_schemas(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.list_tenant_schemas() IS 'Returns (schema_name, tenant_slug) for every provisioned tenant schema. Used by admin tooling and health checks to enumerate active tenants.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: backup_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    backup_type character varying(20) NOT NULL,
    destination character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'running'::character varying NOT NULL,
    file_size_bytes bigint,
    file_path text,
    checksum character varying(128),
    encryption_key_id character varying(100),
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_log_backup_type_check CHECK (((backup_type)::text = ANY ((ARRAY['postgres'::character varying, 'weaviate'::character varying, 'config'::character varying, 'full'::character varying])::text[]))),
    CONSTRAINT backup_log_destination_check CHECK (((destination)::text = ANY ((ARRAY['git'::character varying, 's3'::character varying, 'local'::character varying, 'both'::character varying])::text[]))),
    CONSTRAINT backup_log_status_check CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: TABLE backup_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.backup_log IS 'Audit trail for all backup operations. The backup worker inserts a row with status=running before starting, then updates to completed or failed on finish. expires_at is set by the worker based on tenant retention policy (default 30 days). A cleanup job deletes rows and associated files after expires_at passes. checksum enables integrity verification before restore.';


--
-- Name: COLUMN backup_log.backup_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.backup_log.backup_type IS 'postgres: pg_dump of the relational database. weaviate: export of all vector collections. config: workflow/env config snapshot only. full: postgres + weaviate + config in one archive.';


--
-- Name: COLUMN backup_log.encryption_key_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.backup_log.encryption_key_id IS 'Identifier of the encryption key used, not the key material itself. Used to look up the key from the external key management service at restore time.';


--
-- Name: behavioral_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.behavioral_patterns (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    pattern_type character varying(100) NOT NULL,
    pattern_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    confidence real DEFAULT 0.5 NOT NULL,
    observation_count integer DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT behavioral_patterns_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
);


--
-- Name: TABLE behavioral_patterns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.behavioral_patterns IS 'Passively learned patterns from historical ingest and ongoing observation. confidence approaches 1.0 as observation_count grows. Low-confidence patterns (< 0.3) are suggestions only; high-confidence (> 0.8) are treated as facts. Embeddings for semantic retrieval live in Weaviate with this row id as metadata.';


--
-- Name: COLUMN behavioral_patterns.pattern_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.behavioral_patterns.pattern_data IS 'Structured data describing the pattern. Schema varies by pattern_type. Example for communication_timing: { peakHours: [9,10,14,15], avgResponseMinutes: 12, weekdayOnly: true }';


--
-- Name: COLUMN behavioral_patterns.confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.behavioral_patterns.confidence IS 'Value 0-1. Starts at 0.5 on first observation. Approaches 1.0 with repeated confirmation. Drops when contradicting evidence is observed.';


--
-- Name: boss_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    tokens_in integer,
    tokens_out integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ircaios_chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


--
-- Name: boss_chat_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_chat_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    rascal_handle text NOT NULL,
    name text NOT NULL,
    model text DEFAULT 'claude-sonnet-4-5'::text NOT NULL,
    system_prompt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    cc_session_id text,
    agent_kind text DEFAULT 'rascal'::text NOT NULL,
    workspace_dir text,
    CONSTRAINT ircaios_chat_sessions_agent_kind_ck CHECK ((agent_kind = ANY (ARRAY['rascal'::text, 'outsider'::text, 'coo'::text, 'gio'::text])))
);


--
-- Name: boss_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_conversations (
    conversation_id text NOT NULL,
    user_id text DEFAULT 'anonymous'::text NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: boss_email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_email_log (
    id text NOT NULL,
    message_id text NOT NULL,
    account_email text NOT NULL,
    sender text NOT NULL,
    subject text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    category text NOT NULL,
    needs_attention boolean DEFAULT false NOT NULL,
    action_taken text,
    draft_content text,
    golden_nugget text,
    invoice_amount numeric,
    invoice_due_date date,
    ircaios_notes text,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT ircaios_email_log_action_taken_check CHECK ((action_taken = ANY (ARRAY['archived'::text, 'draft_created'::text, 'auto_responded'::text, 'forwarded_to_brain'::text, 'compiled'::text]))),
    CONSTRAINT ircaios_email_log_category_check CHECK ((category = ANY (ARRAY['newsletter'::text, 'invoice'::text, 'personal'::text, 'client'::text, 'marketing'::text, 'other'::text])))
);


--
-- Name: boss_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_memory (
    id bigint NOT NULL,
    category text DEFAULT 'fact'::text NOT NULL,
    content text NOT NULL,
    source text,
    confidence real DEFAULT 0.8 NOT NULL,
    conversation_id text,
    access_count integer DEFAULT 0 NOT NULL,
    last_accessed timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: boss_memory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.boss_memory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: boss_memory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.boss_memory_id_seq OWNED BY public.boss_memory.id;


--
-- Name: boss_oauth_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_oauth_state (
    state text NOT NULL,
    provider text NOT NULL,
    services text[] NOT NULL,
    code_verifier text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: boss_oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_oauth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id text NOT NULL,
    provider text NOT NULL,
    email text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ircaios_oauth_tokens_provider_check CHECK ((provider = ANY (ARRAY['google'::text, 'microsoft'::text])))
);


--
-- Name: boss_outsiders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_outsiders (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    handle text NOT NULL,
    display_name text NOT NULL,
    cli text NOT NULL,
    client text NOT NULL,
    project_dir text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model text DEFAULT 'claude-sonnet-4-6'::text NOT NULL,
    CONSTRAINT boss_outsiders_cli_ck CHECK ((cli = ANY (ARRAY['claude'::text, 'ollama'::text]))),
    CONSTRAINT boss_outsiders_handle_ck CHECK ((handle ~ '^[a-z]{2,24}$'::text))
);


--
-- Name: boss_pending_passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_pending_passkeys (
    email character varying(320) NOT NULL,
    passkey_hash character varying(64) NOT NULL,
    created_by text DEFAULT 'ircaios-internal'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + make_interval(days => 7)) NOT NULL
);


--
-- Name: boss_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    description text,
    stages jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: boss_rascals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_rascals (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    handle text NOT NULL,
    display_name text NOT NULL,
    cli text NOT NULL,
    client text NOT NULL,
    project_dir text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model text DEFAULT 'claude-sonnet-4-6'::text NOT NULL,
    CONSTRAINT boss_rascals_cli_ck CHECK ((cli = ANY (ARRAY['claude'::text, 'ollama'::text]))),
    CONSTRAINT boss_rascals_handle_ck CHECK ((handle ~ '^[a-z]{2,24}$'::text))
);


--
-- Name: boss_stage_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_stage_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    task_id uuid NOT NULL,
    stage text NOT NULL,
    agent text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    output text,
    output_files text[] DEFAULT ARRAY[]::text[] NOT NULL,
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT boss_stage_log_status_ck CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'skipped'::text, 'failed'::text, 'blocked'::text])))
);


--
-- Name: boss_task_frequency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_task_frequency (
    domain text NOT NULL,
    count integer DEFAULT 0,
    last_seen timestamp with time zone DEFAULT now()
);


--
-- Name: boss_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    pipeline_id uuid,
    title text NOT NULL,
    current_stage text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    assigned_agent text,
    assigned_client text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    stage_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    priority integer DEFAULT 5 NOT NULL,
    view_column text DEFAULT 'inbox'::text NOT NULL,
    due_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    bucket text,
    gate_at timestamp with time zone,
    picked_at timestamp with time zone,
    kind text DEFAULT 'task'::text NOT NULL,
    CONSTRAINT boss_tasks_bucket_ck CHECK (((bucket IS NULL) OR (bucket = ANY (ARRAY['today'::text, 'tomorrow'::text, 'this_week'::text, 'next_week'::text])))),
    CONSTRAINT boss_tasks_kind_ck CHECK ((kind = ANY (ARRAY['task'::text, 'response'::text]))),
    CONSTRAINT boss_tasks_priority_ck CHECK (((priority >= 1) AND (priority <= 10))),
    CONSTRAINT boss_tasks_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'blocked'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT boss_tasks_view_column_ck CHECK ((view_column = ANY (ARRAY['inbox'::text, 'today'::text, 'in_progress'::text, 'to_close'::text, 'done'::text])))
);


--
-- Name: boss_whatsapp_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_whatsapp_contacts (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    contact_id text NOT NULL,
    display_name text,
    phone text,
    push_name text,
    verified_name text,
    is_my_contact boolean,
    is_blocked boolean,
    is_group boolean DEFAULT false NOT NULL,
    source_payload jsonb,
    last_seen_at timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: boss_whatsapp_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_whatsapp_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    chat_id text NOT NULL,
    body text NOT NULL,
    authored_by text NOT NULL,
    reply_to_wa_message_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    reasoning text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    sent_wa_message_id text,
    CONSTRAINT boss_whatsapp_drafts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'discarded'::text])))
);


--
-- Name: boss_whatsapp_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_whatsapp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    chat_id text NOT NULL,
    wa_message_id text,
    direction text NOT NULL,
    from_me boolean NOT NULL,
    author text,
    body text,
    message_type text DEFAULT 'text'::text NOT NULL,
    media_url text,
    reply_to_wa_message_id text,
    ack_status text,
    sent_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    sender_name text,
    CONSTRAINT boss_whatsapp_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);


--
-- Name: boss_whatsapp_monitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_whatsapp_monitors (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    chat_id text NOT NULL,
    agent_handle text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    confidence_threshold real DEFAULT 0.85,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE boss_whatsapp_monitors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.boss_whatsapp_monitors IS 'WhatsApp chat → agent monitoring assignments';


--
-- Name: boss_whatsapp_scheduled; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_whatsapp_scheduled (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    chat_id text NOT NULL,
    message text NOT NULL,
    send_at timestamp with time zone NOT NULL,
    created_by text NOT NULL,
    draft_approved boolean DEFAULT false,
    sent_at timestamp with time zone,
    wa_message_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT boss_whatsapp_scheduled_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'sent'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: TABLE boss_whatsapp_scheduled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.boss_whatsapp_scheduled IS 'Scheduled WhatsApp messages for reminders and follow-ups';


--
-- Name: boss_whatsapp_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boss_whatsapp_threads (
    tenant_id text DEFAULT 'default'::text NOT NULL,
    chat_id text NOT NULL,
    display_name text,
    phone text,
    is_group boolean DEFAULT false NOT NULL,
    last_message_wa_id text,
    last_message_at timestamp with time zone,
    last_message_preview text,
    last_message_from_me boolean,
    unread_count integer DEFAULT 0 NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brain_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_config (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    brain_type character varying(50) NOT NULL,
    label character varying(100) DEFAULT 'primary'::character varying NOT NULL,
    endpoint text,
    model character varying(100),
    api_key_encrypted bytea,
    capabilities_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_fallback boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brain_config_brain_type_check CHECK (((brain_type)::text = ANY ((ARRAY['claude'::character varying, 'openai'::character varying, 'gemini'::character varying, 'openclaw'::character varying, 'custom'::character varying])::text[])))
);


--
-- Name: TABLE brain_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.brain_config IS 'Brain adapter configuration for the Brain Router. A tenant may register multiple brains; is_primary=true is the default. is_fallback=true is used if the primary fails (fallback.ts middleware). capabilities_json is read by the router to decide whether to use tool-calling, MCP, or plain-prompt mode for each request.';


--
-- Name: COLUMN brain_config.capabilities_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.brain_config.capabilities_json IS 'JSON object with boolean capability flags. See BrainCapabilities interface in packages/brain/types.ts.';


--
-- Name: COLUMN brain_config.priority; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.brain_config.priority IS 'Routing priority when multiple brains could serve a request. Lower integer = higher priority.';


--
-- Name: cached_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cached_contacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    contact_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    email text,
    phone text,
    company text,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cached_contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cached_contacts IS 'Local mirror of contacts from Google People API and Microsoft Graph. Synced via syncToken (Google) and delta query (Graph). searchContacts() uses ILIKE on name/email/company for voice lookups.';


--
-- Name: cached_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cached_emails (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    message_id text NOT NULL,
    from_address text DEFAULT ''::text NOT NULL,
    to_addresses text[] DEFAULT '{}'::text[] NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    snippet text DEFAULT ''::text NOT NULL,
    date timestamp with time zone NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cached_emails; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cached_emails IS 'Local mirror of email messages from Gmail and Outlook. Delta-synced every 20 minutes via the background worker. Voice queries read from here; live API only on cache miss or explicit refresh.';


--
-- Name: COLUMN cached_emails.message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cached_emails.message_id IS 'Provider-assigned message ID. Gmail: numeric string. Graph: GUID.';


--
-- Name: COLUMN cached_emails.synced_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cached_emails.synced_at IS 'Time this row was last written by the sync worker. Used to compute staleness.';


--
-- Name: cached_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cached_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    event_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    start timestamp with time zone NOT NULL,
    "end" timestamp with time zone NOT NULL,
    attendees text[] DEFAULT '{}'::text[] NOT NULL,
    location text,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cached_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cached_events IS 'Local mirror of calendar events from Google Calendar and Outlook Calendar. getTodayEvents() reads from here for sub-millisecond voice responses.';


--
-- Name: cached_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cached_files (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    file_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    path text,
    size bigint,
    modified timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cached_files; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cached_files IS 'Local mirror of file metadata from Google Drive and OneDrive. Content is never stored — only metadata needed for search and routing. searchFiles() uses ILIKE on name for voice file-finding.';


--
-- Name: cached_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cached_tasks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    task_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'needsAction'::text NOT NULL,
    due timestamp with time zone,
    list text,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cached_tasks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cached_tasks IS 'Local mirror of tasks from Google Tasks and Microsoft To Do. Full refresh each sync cycle (no incremental API on either platform).';


--
-- Name: cleanup_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleanup_proposals (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(50) NOT NULL,
    file_id character varying(500) NOT NULL,
    file_name text NOT NULL,
    file_path text,
    file_size_bytes bigint,
    last_modified_at timestamp with time zone,
    last_accessed_at timestamp with time zone,
    proposal_type character varying(20) NOT NULL,
    reason text NOT NULL,
    confidence real DEFAULT 0.5 NOT NULL,
    destination text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_at timestamp with time zone,
    executed_at timestamp with time zone,
    error_message text,
    batch_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cleanup_proposals_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT cleanup_proposals_proposal_type_check CHECK (((proposal_type)::text = ANY ((ARRAY['delete'::character varying, 'archive'::character varying, 'move'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT cleanup_proposals_provider_check CHECK (((provider)::text = ANY ((ARRAY['google_drive'::character varying, 'onedrive'::character varying, 'local'::character varying])::text[]))),
    CONSTRAINT cleanup_proposals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'executed'::character varying, 'failed'::character varying, 'expired'::character varying])::text[])))
);


--
-- Name: TABLE cleanup_proposals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cleanup_proposals IS 'AI-generated file cleanup suggestions awaiting user review. The file engine generates proposals; status=pending means not yet reviewed. status=approved triggers execution; status=rejected is logged but no action taken. Proposals expire to status=expired after 30 days if not reviewed (configurable). No destructive file action is taken without user approval (approved or auto-approve rule). batch_id groups proposals generated in a single analysis sweep for bulk review UX.';


--
-- Name: COLUMN cleanup_proposals.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cleanup_proposals.reason IS 'Human-readable AI rationale for the proposal. Examples: "Duplicate of Invoice_2026-03.pdf (98% similarity, same folder)", "Not opened in 847 days and matches archive rule for files > 1 year old"';


--
-- Name: COLUMN cleanup_proposals.confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cleanup_proposals.confidence IS 'AI confidence that this is a safe action (0-1). Proposals with confidence < 0.7 require explicit user confirmation even with auto-approve rules.';


--
-- Name: COLUMN cleanup_proposals.batch_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cleanup_proposals.batch_id IS 'UUID linking all proposals from a single analysis run. Used by the review UI to show a grouped batch for bulk approve/reject.';


--
-- Name: connected_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connected_accounts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    provider character varying(50) NOT NULL,
    account_email character varying(320),
    account_name character varying(255),
    account_label character varying(100) DEFAULT 'primary'::character varying NOT NULL,
    services_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    disconnected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connected_accounts_provider_check CHECK (((provider)::text = ANY ((ARRAY['google'::character varying, 'microsoft'::character varying, 'slack'::character varying, 'stripe'::character varying, 'custom'::character varying])::text[])))
);


--
-- Name: TABLE connected_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.connected_accounts IS 'Human-readable registry of external accounts a tenant has connected. services_json lists which capabilities are active, e.g. ["gmail","calendar","drive"]. disconnected_at is set (not deleted) when an account is removed so history is preserved.';


--
-- Name: COLUMN connected_accounts.services_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connected_accounts.services_json IS 'Array of service strings active for this account. Example: ["gmail", "calendar", "drive", "contacts"]';


--
-- Name: event_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    name character varying(255) NOT NULL,
    description text,
    event_type character varying(100) NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    last_triggered timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE event_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.event_rules IS 'User-defined automation rules evaluated by the event processor. Rules are matched in priority order (lower integer = higher priority). conditions is matched against event.payload using JSONLogic evaluation. actions are executed in array order when all conditions pass. user_id=NULL rules apply to all users in the tenant. is_active=false rules are skipped without deletion (allows temporary disabling).';


--
-- Name: COLUMN event_rules.event_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.event_rules.event_type IS 'Event type to listen for. Exact match or wildcard prefix. Examples: "connector.auth_refresh", "health.*", "brain.error"';


--
-- Name: COLUMN event_rules.conditions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.event_rules.conditions IS 'JSONLogic conditions applied to event.payload. Empty object {} matches all events of this type. Example: {"==":[{"var":"provider"},"google"]} matches only Google connector events.';


--
-- Name: COLUMN event_rules.actions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.event_rules.actions IS 'Ordered action array. Each action: { type: string, params: object }. Execution stops on first error unless params.continue_on_error is true.';


--
-- Name: COLUMN event_rules.priority; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.event_rules.priority IS 'Evaluation order. Lower integer = evaluated first. Default 100. Critical rules should use 1-10. User convenience rules use 100-999.';


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    event_type character varying(100) NOT NULL,
    source character varying(50) DEFAULT 'system'::character varying NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_id uuid,
    processed boolean DEFAULT false NOT NULL,
    processed_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT events_source_check CHECK (((source)::text = ANY ((ARRAY['system'::character varying, 'user'::character varying, 'connector'::character varying, 'brain'::character varying, 'voice'::character varying, 'learning'::character varying, 'self_healing'::character varying, 'backup'::character varying, 'file'::character varying, 'external'::character varying])::text[])))
);


--
-- Name: TABLE events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.events IS 'Persistent event log for IR Custom AIOS internal event bus. Every significant action writes an event before fan-out to subscribers. event_rules processor reads unprocessed events (processed=false) on a polling loop. Worker prunes rows older than 90 days (configurable per tenant in tenants.config). correlation_id links causally related events for tracing and debugging.';


--
-- Name: COLUMN events.event_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.events.event_type IS 'Dot-notation event identifier. Convention: {domain}.{action}. Examples: brain.request, connector.auth_refresh, learning.pattern_detected, health.incident_opened, file.cleanup_proposed.';


--
-- Name: COLUMN events.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.events.payload IS 'Event-specific data. Schema varies by event_type. Example for connector.auth_refresh: { provider: "google", account_label: "work", user_id: "...", triggered_by: "expiry_check" }';


--
-- Name: COLUMN events.correlation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.events.correlation_id IS 'Groups causally related events. A brain.request event and its brain.response share the same correlation_id. Set by the emitter; NULL for standalone events.';


--
-- Name: file_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    name character varying(255) NOT NULL,
    description text,
    provider character varying(50) DEFAULT 'all'::character varying NOT NULL,
    rule_type character varying(50) NOT NULL,
    match_pattern jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    last_triggered timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT file_rules_provider_check CHECK (((provider)::text = ANY ((ARRAY['google_drive'::character varying, 'onedrive'::character varying, 'all'::character varying])::text[]))),
    CONSTRAINT file_rules_rule_type_check CHECK (((rule_type)::text = ANY ((ARRAY['move'::character varying, 'rename'::character varying, 'tag'::character varying, 'archive'::character varying, 'delete'::character varying, 'notify'::character varying])::text[])))
);


--
-- Name: TABLE file_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.file_rules IS 'User-defined rules for automatic file organization in cloud storage. Evaluated by the file engine when new or modified files are detected via Drive/OneDrive webhooks. Rules are applied in priority order (lower integer = higher priority). rule_type=delete always requires explicit user confirmation unless require_confirmation=false in action_params. user_id=NULL rules are tenant-wide defaults applied to all users.';


--
-- Name: COLUMN file_rules.match_pattern; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.file_rules.match_pattern IS 'JSON conditions for file matching. name_regex: JS-compatible regex. mime_type: exact MIME type string. folder_path: prefix match on file path. min_age_days/max_age_days: file age filter.';


--
-- Name: COLUMN file_rules.action_params; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.file_rules.action_params IS 'Action execution parameters. Schema is specific to rule_type. See file-engine/actions/*.ts for full parameter documentation per action type.';


--
-- Name: health_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_checks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    service character varying(100) NOT NULL,
    status character varying(20) NOT NULL,
    response_time_ms integer,
    error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT health_checks_status_check CHECK (((status)::text = ANY ((ARRAY['healthy'::character varying, 'degraded'::character varying, 'unhealthy'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: TABLE health_checks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.health_checks IS 'Rolling log of 30-second heartbeat check results for every monitored service. monitor.ts writes one row per check per service. Worker prunes rows older than 7 days (configurable). Two consecutive unhealthy results trigger Layer 2 (diagnostic agent). The web dashboard reads the most recent row per service for current status.';


--
-- Name: COLUMN health_checks.service; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.health_checks.service IS 'Monitored service identifier. Values: brain, google_connector, microsoft_connector, voice_{device_id}, postgres, weaviate, redis, backup, stt, tts, worker, api.';


--
-- Name: incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incidents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    service character varying(100) NOT NULL,
    severity character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    error_message text NOT NULL,
    error_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    diagnosis text,
    fix_attempted text,
    fix_result text,
    attempts jsonb DEFAULT '[]'::jsonb NOT NULL,
    playbook_id uuid,
    escalated boolean DEFAULT false NOT NULL,
    escalation_sent_at timestamp with time zone,
    escalation_channel character varying(50),
    resolved_by character varying(50),
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT incidents_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT incidents_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'diagnosing'::character varying, 'fixing'::character varying, 'resolved'::character varying, 'escalated'::character varying])::text[])))
);


--
-- Name: TABLE incidents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.incidents IS 'Full record of every detected system failure. Layer 2 (diagnostic agent) writes attempts as it works through diagnosis. After 3 failed attempts, escalated=true and notification is sent. When resolved, resolved_by and resolved_at are set. If resolved by diagnostic agent with no playbook, builder.ts creates a new playbook row.';


--
-- Name: COLUMN incidents.error_context; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.incidents.error_context IS 'Structured context captured at time of failure: last N log lines, environment state, active connections, memory usage, etc.';


--
-- Name: COLUMN incidents.attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.incidents.attempts IS 'JSON array tracking each fix attempt. Schema: [{ attemptNumber: 1, action: "restart_service", result: "service restarted but error recurred", timestamp: "..." }]';


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    invited_by text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    CONSTRAINT invites_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT invites_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text])))
);


--
-- Name: learning_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learning_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    profile_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    communication_style character varying(100) DEFAULT 'unknown'::character varying NOT NULL,
    onboarding_complete boolean DEFAULT false NOT NULL,
    profile_version integer DEFAULT 1 NOT NULL,
    last_synthesized_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_profiles_communication_style_check CHECK (((communication_style)::text = ANY ((ARRAY['formal'::character varying, 'professional-direct'::character varying, 'casual'::character varying, 'technical'::character varying, 'concise'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: TABLE learning_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.learning_profiles IS 'Master user profile maintained by the Learning Engine. synthesizer.ts rebuilds profile_json after significant learning events. The Brain Router context middleware injects this profile before every brain call. Vector embeddings live in Weaviate; this table holds structured metadata only.';


--
-- Name: COLUMN learning_profiles.profile_json; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.learning_profiles.profile_json IS 'Denormalized profile snapshot. Keys include workHours, communicationTone, topContacts, meetingPreferences, fileConventions, taskPatterns, etc.';


--
-- Name: COLUMN learning_profiles.profile_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.learning_profiles.profile_version IS 'Monotonically incremented each time synthesizer.ts rebuilds the profile. Useful for cache invalidation in the Brain Router.';


--
-- Name: oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    provider character varying(50) NOT NULL,
    account_label character varying(100) DEFAULT 'primary'::character varying NOT NULL,
    service character varying(100) DEFAULT 'all'::character varying NOT NULL,
    access_token_encrypted bytea NOT NULL,
    refresh_token_encrypted bytea,
    expires_at timestamp with time zone,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    last_refresh_at timestamp with time zone,
    refresh_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_tokens_provider_check CHECK (((provider)::text = ANY ((ARRAY['google'::character varying, 'microsoft'::character varying, 'slack'::character varying, 'stripe'::character varying, 'custom'::character varying])::text[]))),
    CONSTRAINT oauth_tokens_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'revoked'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: TABLE oauth_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_tokens IS 'Encrypted OAuth2 tokens for external service connections. Tokens are AES-256 encrypted before storage; the encryption key is never stored here. The connector layer calls token-store.ts to decrypt on demand. status=expired triggers auto-refresh; status=revoked requires user re-auth.';


--
-- Name: COLUMN oauth_tokens.account_label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oauth_tokens.account_label IS 'Human label for this account (work, personal, client). Supports multi-account per provider.';


--
-- Name: COLUMN oauth_tokens.service; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oauth_tokens.service IS 'Which service this token covers. May be ''all'' if a single OAuth grant covers all services for a provider, or specific (''gmail'', ''calendar'') if the user did a scoped grant.';


--
-- Name: onboarding_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_progress (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    platform character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    items_processed integer DEFAULT 0 NOT NULL,
    total_items integer DEFAULT 0 NOT NULL,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT onboarding_progress_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: TABLE onboarding_progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.onboarding_progress IS 'Tracks the historical ingest sprint run when a user first connects their business accounts. Each platform gets one row. progress.ts computes overall % from sum of items_processed / total_items. status=completed rows are kept for audit; the sprint is not re-run unless explicitly reset.';


--
-- Name: COLUMN onboarding_progress.platform; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.onboarding_progress.platform IS 'Which platform this row tracks. One row per platform per user. See src/learning/onboarding/ for the ingest module for each platform.';


--
-- Name: COLUMN onboarding_progress.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.onboarding_progress.metadata IS 'Platform-specific ingest stats. Example for gmail: { emailsAnalyzed: 2847, labelsFound: 12, topSenders: [...] }';


--
-- Name: playbooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbooks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    failure_signature text NOT NULL,
    service character varying(100) NOT NULL,
    severity character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    diagnosis_steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    fix_steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    verification text NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    last_used timestamp with time zone,
    created_from_incident uuid,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbooks_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);


--
-- Name: TABLE playbooks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.playbooks IS 'Immune memory for the self-healing engine. When an incident occurs, matcher.ts searches this table for a matching failure_signature. If found, the playbook fix_steps are executed before attempting blind diagnosis. success_count grows each time a playbook resolves an issue. builder.ts creates new rows from incidents resolved by the diagnostic agent. tenant_id=NULL rows are global playbooks shared across all tenants.';


--
-- Name: COLUMN playbooks.failure_signature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.playbooks.failure_signature IS 'Regex or keyword pattern matched against incident error_message. Example: "token.*expired|401.*Unauthorized"';


--
-- Name: COLUMN playbooks.diagnosis_steps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.playbooks.diagnosis_steps IS 'Ordered JSON array of diagnostic check descriptions. Example: ["Check token expiry in oauth_tokens", "Verify provider endpoint is reachable", "Test refresh with current refresh_token"]';


--
-- Name: COLUMN playbooks.fix_steps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.playbooks.fix_steps IS 'Ordered JSON array of action descriptions executed by actions/*.ts modules. Example: ["Call refresh-auth.ts for provider=google", "Update oauth_tokens.expires_at", "Verify connector health check passes"]';


--
-- Name: COLUMN playbooks.success_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.playbooks.success_count IS 'Number of times this playbook resolved an incident. Primary trust signal. Month 1: mostly 0. Month 6: critical playbooks may have 50+.';


--
-- Name: preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preferences (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    rule text NOT NULL,
    category character varying(100) DEFAULT 'general'::character varying NOT NULL,
    weight real DEFAULT 1.0 NOT NULL,
    source character varying(50) DEFAULT 'explicit'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT preferences_source_check CHECK (((source)::text = ANY ((ARRAY['explicit'::character varying, 'learned'::character varying, 'onboarding'::character varying, 'suggested'::character varying])::text[]))),
    CONSTRAINT preferences_weight_check CHECK (((weight >= (0)::double precision) AND (weight <= (10)::double precision)))
);


--
-- Name: TABLE preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.preferences IS 'Behavioral rules for IR Custom AIOS. Explicit rules (from direct user instruction) override learned rules when they conflict. weight=10 = absolute rule, weight=1 = soft preference. The Brain Router context middleware bundles active preferences into each brain call.';


--
-- Name: COLUMN preferences.rule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.preferences.rule IS 'Natural-language rule as stated or inferred. Example: "Never schedule meetings before 9am." or "When Brad emails, always flag as high priority."';


--
-- Name: COLUMN preferences.weight; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.preferences.weight IS 'Strength of preference on scale 0-10. Explicit=10, learned from repeated behavior=1-5, single observation=0.5. Higher weight wins when rules conflict.';


--
-- Name: runtime_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runtime_config (
    key text NOT NULL,
    value text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    token text NOT NULL,
    device_hint character varying(255),
    ip_address inet,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sessions IS 'Active auth sessions. Token is an opaque value stored as a hash in production. Expired rows should be purged by the background worker on a regular schedule.';


--
-- Name: slack_attention; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_attention (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    flagged_by text NOT NULL,
    source_channel text NOT NULL,
    source_ts text NOT NULL,
    source_user text,
    source_user_name text,
    preview text NOT NULL,
    reason text,
    permalink text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone
);


--
-- Name: sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_state (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    service text NOT NULL,
    last_sync timestamp with time zone,
    next_sync timestamp with time zone,
    status text DEFAULT 'never'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_state_service_check CHECK ((service = ANY (ARRAY['mail'::text, 'calendar'::text, 'tasks'::text, 'drive'::text, 'contacts'::text, 'gmail'::text, 'outlook_mail'::text, 'google_calendar'::text, 'outlook_calendar'::text, 'google_tasks'::text, 'ms_tasks'::text, 'google_drive'::text, 'onedrive'::text, 'google_contacts'::text, 'ms_contacts'::text]))),
    CONSTRAINT sync_state_status_check CHECK ((status = ANY (ARRAY['never'::text, 'idle'::text, 'running'::text, 'error'::text])))
);


--
-- Name: TABLE sync_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sync_state IS 'Scheduler bookkeeping for the background delta-sync worker. last_sync feeds into delta queries (updatedMin, historyId lookups). next_sync drives the priority queue in SyncScheduler.filterDueAccounts(). Cursor tokens (historyId, deltaLink) are stored in Redis, not here — they are too volatile for Postgres and Redis TTL handles expiry cleanly.';


--
-- Name: COLUMN sync_state.service; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_state.service IS 'Granular service identifier. The scheduler tracks mail, calendar, tasks, drive, and contacts separately so one failing service does not block others.';


--
-- Name: COLUMN sync_state.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_state.status IS 'never = no successful sync yet; idle = last sync succeeded; running = sync in progress; error = last sync failed (see error column).';


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(63) NOT NULL,
    brain_type character varying(50) DEFAULT 'claude'::character varying NOT NULL,
    brain_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    suite_type character varying(20) DEFAULT 'google'::character varying NOT NULL,
    status character varying(20) DEFAULT 'onboarding'::character varying NOT NULL,
    plan character varying(50) DEFAULT 'single'::character varying NOT NULL,
    timezone character varying(100) DEFAULT 'UTC'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_brain_type_check CHECK (((brain_type)::text = ANY ((ARRAY['claude'::character varying, 'openai'::character varying, 'gemini'::character varying, 'openclaw'::character varying, 'custom'::character varying])::text[]))),
    CONSTRAINT tenants_status_check CHECK (((status)::text = ANY ((ARRAY['onboarding'::character varying, 'active'::character varying, 'suspended'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT tenants_suite_type_check CHECK (((suite_type)::text = ANY ((ARRAY['google'::character varying, 'microsoft'::character varying, 'both'::character varying])::text[])))
);


--
-- Name: TABLE tenants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tenants IS 'Top-level isolation unit. In single-tenant mode this has exactly one row. In multi-tenant mode each customer is a row and gets a dedicated schema named tenant_{slug}.';


--
-- Name: COLUMN tenants.brain_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenants.brain_type IS 'Which AI brain provider this tenant uses. Drives Brain Router configuration.';


--
-- Name: COLUMN tenants.brain_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenants.brain_config IS 'Brain-specific config: endpoint URL, model name, capability overrides.';


--
-- Name: COLUMN tenants.suite_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenants.suite_type IS 'Which business suite the tenant uses. Drives connector routing.';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    username character varying(100) NOT NULL,
    email character varying(320) NOT NULL,
    password_hash text,
    role character varying(50) DEFAULT 'user'::character varying NOT NULL,
    display_name character varying(255),
    avatar_url text,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_active_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    passkey_hash character varying(64),
    onboarding_wizard_complete boolean DEFAULT false NOT NULL,
    totp_secret text,
    totp_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'user'::character varying, 'viewer'::character varying])::text[])))
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS 'User accounts scoped to a tenant. password_hash is NULL for SSO/OAuth-only users.';


--
-- Name: COLUMN users.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.role IS 'owner = full control; admin = manage users/config; user = standard; viewer = read-only.';


--
-- Name: voice_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_devices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    device_id character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    room character varying(100) NOT NULL,
    device_type character varying(50) DEFAULT 'custom'::character varying NOT NULL,
    status character varying(20) DEFAULT 'online'::character varying NOT NULL,
    wake_word character varying(100) DEFAULT 'hey ircaios'::character varying NOT NULL,
    stt_provider character varying(50) DEFAULT 'whisper'::character varying NOT NULL,
    tts_provider character varying(50) DEFAULT 'elevenlabs'::character varying NOT NULL,
    last_seen_at timestamp with time zone,
    firmware_version character varying(50),
    ip_address inet,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_devices_device_type_check CHECK (((device_type)::text = ANY ((ARRAY['raspberry_pi'::character varying, 'alexa'::character varying, 'google_home'::character varying, 'custom'::character varying])::text[]))),
    CONSTRAINT voice_devices_status_check CHECK (((status)::text = ANY ((ARRAY['online'::character varying, 'offline'::character varying, 'error'::character varying, 'provisioning'::character varying])::text[]))),
    CONSTRAINT voice_devices_stt_provider_check CHECK (((stt_provider)::text = ANY ((ARRAY['whisper'::character varying, 'deepgram'::character varying, 'google'::character varying, 'azure'::character varying, 'custom'::character varying])::text[]))),
    CONSTRAINT voice_devices_tts_provider_check CHECK (((tts_provider)::text = ANY ((ARRAY['elevenlabs'::character varying, 'openai'::character varying, 'google'::character varying, 'azure'::character varying, 'custom'::character varying])::text[])))
);


--
-- Name: TABLE voice_devices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.voice_devices IS 'Registry of physical voice-enabled devices. room is used by the Brain Router context middleware to inject location-aware context. status is updated by the heartbeat monitor every 30 seconds. config.doNotDisturb suppresses voice responses during quiet hours. config.allowedUsers restricts which users this device responds to (empty = all).';


--
-- Name: COLUMN voice_devices.device_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voice_devices.device_id IS 'Hardware identifier assigned at enrollment. Stable across reboots and re-registration. Conversations reference this field by value so records survive device replacement.';


--
-- Name: COLUMN voice_devices.room; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voice_devices.room IS 'Room label injected into brain context for location-aware responses. Examples: kitchen, home_office, living_room, bedroom.';


--
-- Name: COLUMN voice_devices.config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voice_devices.config IS 'Device-level config JSON. Keys: volume (0-100), sensitivity (0-1), doNotDisturb: {start: "22:00", end: "07:00"}, allowedUsers: [uuid, ...]';


--
-- Name: boss_memory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_memory ALTER COLUMN id SET DEFAULT nextval('public.boss_memory_id_seq'::regclass);


--
-- Name: backup_log backup_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_log
    ADD CONSTRAINT backup_log_pkey PRIMARY KEY (id);


--
-- Name: behavioral_patterns behavioral_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_patterns
    ADD CONSTRAINT behavioral_patterns_pkey PRIMARY KEY (id);


--
-- Name: boss_conversations boss_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_conversations
    ADD CONSTRAINT boss_conversations_pkey PRIMARY KEY (conversation_id);


--
-- Name: boss_memory boss_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_memory
    ADD CONSTRAINT boss_memory_pkey PRIMARY KEY (id);


--
-- Name: boss_outsiders boss_outsiders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_outsiders
    ADD CONSTRAINT boss_outsiders_pkey PRIMARY KEY (tenant_id, handle);


--
-- Name: boss_pipelines boss_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_pipelines
    ADD CONSTRAINT boss_pipelines_pkey PRIMARY KEY (id);


--
-- Name: boss_rascals boss_rascals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_rascals
    ADD CONSTRAINT boss_rascals_pkey PRIMARY KEY (tenant_id, handle);


--
-- Name: boss_stage_log boss_stage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_stage_log
    ADD CONSTRAINT boss_stage_log_pkey PRIMARY KEY (id);


--
-- Name: boss_task_frequency boss_task_frequency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_task_frequency
    ADD CONSTRAINT boss_task_frequency_pkey PRIMARY KEY (domain);


--
-- Name: boss_tasks boss_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_tasks
    ADD CONSTRAINT boss_tasks_pkey PRIMARY KEY (id);


--
-- Name: boss_whatsapp_contacts boss_whatsapp_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_contacts
    ADD CONSTRAINT boss_whatsapp_contacts_pkey PRIMARY KEY (tenant_id, contact_id);


--
-- Name: boss_whatsapp_drafts boss_whatsapp_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_drafts
    ADD CONSTRAINT boss_whatsapp_drafts_pkey PRIMARY KEY (id);


--
-- Name: boss_whatsapp_messages boss_whatsapp_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_messages
    ADD CONSTRAINT boss_whatsapp_messages_pkey PRIMARY KEY (id);


--
-- Name: boss_whatsapp_monitors boss_whatsapp_monitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_monitors
    ADD CONSTRAINT boss_whatsapp_monitors_pkey PRIMARY KEY (tenant_id, chat_id, agent_handle);


--
-- Name: boss_whatsapp_scheduled boss_whatsapp_scheduled_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_scheduled
    ADD CONSTRAINT boss_whatsapp_scheduled_pkey PRIMARY KEY (id);


--
-- Name: boss_whatsapp_threads boss_whatsapp_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_threads
    ADD CONSTRAINT boss_whatsapp_threads_pkey PRIMARY KEY (tenant_id, chat_id);


--
-- Name: brain_config brain_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_config
    ADD CONSTRAINT brain_config_pkey PRIMARY KEY (id);


--
-- Name: brain_config brain_config_tenant_id_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_config
    ADD CONSTRAINT brain_config_tenant_id_label_key UNIQUE (tenant_id, label);


--
-- Name: cached_contacts cached_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_contacts
    ADD CONSTRAINT cached_contacts_pkey PRIMARY KEY (id);


--
-- Name: cached_contacts cached_contacts_tenant_id_account_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_contacts
    ADD CONSTRAINT cached_contacts_tenant_id_account_id_contact_id_key UNIQUE (tenant_id, account_id, contact_id);


--
-- Name: cached_emails cached_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_emails
    ADD CONSTRAINT cached_emails_pkey PRIMARY KEY (id);


--
-- Name: cached_emails cached_emails_tenant_id_account_id_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_emails
    ADD CONSTRAINT cached_emails_tenant_id_account_id_message_id_key UNIQUE (tenant_id, account_id, message_id);


--
-- Name: cached_events cached_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_events
    ADD CONSTRAINT cached_events_pkey PRIMARY KEY (id);


--
-- Name: cached_events cached_events_tenant_id_account_id_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_events
    ADD CONSTRAINT cached_events_tenant_id_account_id_event_id_key UNIQUE (tenant_id, account_id, event_id);


--
-- Name: cached_files cached_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_files
    ADD CONSTRAINT cached_files_pkey PRIMARY KEY (id);


--
-- Name: cached_files cached_files_tenant_id_account_id_file_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_files
    ADD CONSTRAINT cached_files_tenant_id_account_id_file_id_key UNIQUE (tenant_id, account_id, file_id);


--
-- Name: cached_tasks cached_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_tasks
    ADD CONSTRAINT cached_tasks_pkey PRIMARY KEY (id);


--
-- Name: cached_tasks cached_tasks_tenant_id_account_id_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_tasks
    ADD CONSTRAINT cached_tasks_tenant_id_account_id_task_id_key UNIQUE (tenant_id, account_id, task_id);


--
-- Name: cleanup_proposals cleanup_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_proposals
    ADD CONSTRAINT cleanup_proposals_pkey PRIMARY KEY (id);


--
-- Name: connected_accounts connected_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_pkey PRIMARY KEY (id);


--
-- Name: connected_accounts connected_accounts_tenant_id_provider_account_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_tenant_id_provider_account_label_key UNIQUE (tenant_id, provider, account_label);


--
-- Name: event_rules event_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rules
    ADD CONSTRAINT event_rules_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: file_rules file_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_rules
    ADD CONSTRAINT file_rules_pkey PRIMARY KEY (id);


--
-- Name: health_checks health_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_checks
    ADD CONSTRAINT health_checks_pkey PRIMARY KEY (id);


--
-- Name: incidents incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: boss_chat_messages ircaios_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_chat_messages
    ADD CONSTRAINT ircaios_chat_messages_pkey PRIMARY KEY (id);


--
-- Name: boss_chat_sessions ircaios_chat_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_chat_sessions
    ADD CONSTRAINT ircaios_chat_sessions_pkey PRIMARY KEY (id);


--
-- Name: boss_email_log ircaios_email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_email_log
    ADD CONSTRAINT ircaios_email_log_pkey PRIMARY KEY (id);


--
-- Name: boss_oauth_state ircaios_oauth_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_oauth_state
    ADD CONSTRAINT ircaios_oauth_state_pkey PRIMARY KEY (state);


--
-- Name: boss_oauth_tokens ircaios_oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_oauth_tokens
    ADD CONSTRAINT ircaios_oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: boss_oauth_tokens ircaios_oauth_tokens_provider_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_oauth_tokens
    ADD CONSTRAINT ircaios_oauth_tokens_provider_email_key UNIQUE (provider, email);


--
-- Name: boss_pending_passkeys ircaios_pending_passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_pending_passkeys
    ADD CONSTRAINT ircaios_pending_passkeys_pkey PRIMARY KEY (email);


--
-- Name: learning_profiles learning_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_profiles
    ADD CONSTRAINT learning_profiles_pkey PRIMARY KEY (id);


--
-- Name: learning_profiles learning_profiles_tenant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_profiles
    ADD CONSTRAINT learning_profiles_tenant_id_user_id_key UNIQUE (tenant_id, user_id);


--
-- Name: oauth_tokens oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_tenant_id_provider_account_label_service_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_tenant_id_provider_account_label_service_key UNIQUE (tenant_id, provider, account_label, service);


--
-- Name: onboarding_progress onboarding_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_pkey PRIMARY KEY (id);


--
-- Name: onboarding_progress onboarding_progress_tenant_id_user_id_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_tenant_id_user_id_platform_key UNIQUE (tenant_id, user_id, platform);


--
-- Name: playbooks playbooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id);


--
-- Name: preferences preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_pkey PRIMARY KEY (id);


--
-- Name: runtime_config runtime_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runtime_config
    ADD CONSTRAINT runtime_config_pkey PRIMARY KEY (key, tenant_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_key UNIQUE (token);


--
-- Name: slack_attention slack_attention_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_attention
    ADD CONSTRAINT slack_attention_pkey PRIMARY KEY (id);


--
-- Name: slack_attention slack_attention_tenant_id_source_channel_source_ts_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_attention
    ADD CONSTRAINT slack_attention_tenant_id_source_channel_source_ts_key UNIQUE (tenant_id, source_channel, source_ts);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_tenant_id_account_id_service_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_tenant_id_account_id_service_key UNIQUE (tenant_id, account_id, service);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_tenant_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_email_key UNIQUE (tenant_id, email);


--
-- Name: users users_tenant_id_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_username_key UNIQUE (tenant_id, username);


--
-- Name: voice_devices voice_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_devices
    ADD CONSTRAINT voice_devices_pkey PRIMARY KEY (id);


--
-- Name: voice_devices voice_devices_tenant_id_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_devices
    ADD CONSTRAINT voice_devices_tenant_id_device_id_key UNIQUE (tenant_id, device_id);


--
-- Name: idx_backup_log_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_log_expires ON public.backup_log USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_backup_log_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_log_started ON public.backup_log USING btree (started_at DESC);


--
-- Name: idx_backup_log_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_log_status ON public.backup_log USING btree (status, started_at DESC);


--
-- Name: idx_backup_log_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_log_tenant_id ON public.backup_log USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_behavioral_patterns_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_behavioral_patterns_confidence ON public.behavioral_patterns USING btree (confidence DESC);


--
-- Name: idx_behavioral_patterns_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_behavioral_patterns_tenant_id ON public.behavioral_patterns USING btree (tenant_id);


--
-- Name: idx_behavioral_patterns_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_behavioral_patterns_type ON public.behavioral_patterns USING btree (tenant_id, pattern_type);


--
-- Name: idx_behavioral_patterns_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_behavioral_patterns_user_id ON public.behavioral_patterns USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_boss_memory_conf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_memory_conf ON public.boss_memory USING btree (confidence DESC, created_at DESC);


--
-- Name: idx_boss_outsiders_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_outsiders_enabled ON public.boss_outsiders USING btree (tenant_id, enabled) WHERE (enabled = true);


--
-- Name: idx_boss_pipelines_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_pipelines_tenant ON public.boss_pipelines USING btree (tenant_id);


--
-- Name: idx_boss_rascals_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_rascals_enabled ON public.boss_rascals USING btree (tenant_id, enabled) WHERE (enabled = true);


--
-- Name: idx_boss_stage_log_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_stage_log_agent ON public.boss_stage_log USING btree (tenant_id, agent, started_at DESC);


--
-- Name: idx_boss_stage_log_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_stage_log_task ON public.boss_stage_log USING btree (task_id, started_at DESC);


--
-- Name: idx_boss_tasks_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_agent ON public.boss_tasks USING btree (tenant_id, assigned_agent) WHERE (status = ANY (ARRAY['pending'::text, 'active'::text, 'blocked'::text]));


--
-- Name: idx_boss_tasks_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_archived ON public.boss_tasks USING btree (tenant_id, archived_at) WHERE (archived_at IS NULL);


--
-- Name: idx_boss_tasks_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_client ON public.boss_tasks USING btree (tenant_id, assigned_client);


--
-- Name: idx_boss_tasks_pending_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_pending_review ON public.boss_tasks USING btree (tenant_id, updated_at) WHERE ((view_column = 'to_close'::text) AND (archived_at IS NULL) AND (kind = 'task'::text));


--
-- Name: idx_boss_tasks_response; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_response ON public.boss_tasks USING btree (tenant_id, assigned_agent, created_at) WHERE ((kind = 'response'::text) AND (view_column = 'inbox'::text) AND (archived_at IS NULL));


--
-- Name: idx_boss_tasks_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_stage ON public.boss_tasks USING btree (tenant_id, current_stage);


--
-- Name: idx_boss_tasks_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_tenant_status ON public.boss_tasks USING btree (tenant_id, status);


--
-- Name: idx_boss_tasks_view_column; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_view_column ON public.boss_tasks USING btree (tenant_id, view_column);


--
-- Name: idx_boss_tasks_wo_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_boss_tasks_wo_heartbeat ON public.boss_tasks USING btree (tenant_id, assigned_agent, gate_at) WHERE ((status = 'pending'::text) AND (bucket IS NOT NULL) AND (picked_at IS NULL));


--
-- Name: idx_brain_config_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_config_active ON public.brain_config USING btree (tenant_id, is_active) WHERE (is_active = true);


--
-- Name: idx_brain_config_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_config_primary ON public.brain_config USING btree (tenant_id) WHERE (is_primary = true);


--
-- Name: idx_brain_config_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_config_tenant_id ON public.brain_config USING btree (tenant_id);


--
-- Name: idx_cached_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_contacts_email ON public.cached_contacts USING btree (tenant_id, email) WHERE (email IS NOT NULL);


--
-- Name: idx_cached_contacts_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_contacts_name ON public.cached_contacts USING btree (tenant_id, name);


--
-- Name: idx_cached_contacts_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_contacts_synced ON public.cached_contacts USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_cached_contacts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_contacts_tenant ON public.cached_contacts USING btree (tenant_id);


--
-- Name: idx_cached_contacts_tenant_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_contacts_tenant_account ON public.cached_contacts USING btree (tenant_id, account_id);


--
-- Name: idx_cached_emails_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_emails_synced ON public.cached_emails USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_cached_emails_tenant_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_emails_tenant_account ON public.cached_emails USING btree (tenant_id, account_id, date DESC);


--
-- Name: idx_cached_emails_tenant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_emails_tenant_date ON public.cached_emails USING btree (tenant_id, date DESC);


--
-- Name: idx_cached_emails_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_emails_unread ON public.cached_emails USING btree (tenant_id, account_id, date DESC) WHERE (is_read = false);


--
-- Name: idx_cached_events_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_events_synced ON public.cached_events USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_cached_events_tenant_account_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_events_tenant_account_start ON public.cached_events USING btree (tenant_id, account_id, start);


--
-- Name: idx_cached_events_tenant_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_events_tenant_start ON public.cached_events USING btree (tenant_id, start);


--
-- Name: idx_cached_files_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_files_name ON public.cached_files USING btree (tenant_id, name);


--
-- Name: idx_cached_files_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_files_synced ON public.cached_files USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_cached_files_tenant_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_files_tenant_account ON public.cached_files USING btree (tenant_id, account_id, modified DESC NULLS LAST);


--
-- Name: idx_cached_files_tenant_modified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_files_tenant_modified ON public.cached_files USING btree (tenant_id, modified DESC NULLS LAST);


--
-- Name: idx_cached_tasks_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_tasks_pending ON public.cached_tasks USING btree (tenant_id, account_id, due) WHERE (status <> 'completed'::text);


--
-- Name: idx_cached_tasks_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_tasks_synced ON public.cached_tasks USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_cached_tasks_tenant_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_tasks_tenant_account ON public.cached_tasks USING btree (tenant_id, account_id, due);


--
-- Name: idx_cached_tasks_tenant_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cached_tasks_tenant_due ON public.cached_tasks USING btree (tenant_id, due);


--
-- Name: idx_chat_messages_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_session ON public.boss_chat_messages USING btree (session_id, created_at);


--
-- Name: idx_chat_sessions_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_sessions_agent ON public.boss_chat_sessions USING btree (tenant_id, agent_kind, rascal_handle, updated_at DESC);


--
-- Name: idx_chat_sessions_coo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_sessions_coo ON public.boss_chat_sessions USING btree (tenant_id, agent_kind, updated_at DESC) WHERE (agent_kind = 'coo'::text);


--
-- Name: idx_chat_sessions_gio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_sessions_gio ON public.boss_chat_sessions USING btree (tenant_id, agent_kind, updated_at DESC) WHERE (agent_kind = 'gio'::text);


--
-- Name: idx_cleanup_proposals_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proposals_batch ON public.cleanup_proposals USING btree (batch_id) WHERE (batch_id IS NOT NULL);


--
-- Name: idx_cleanup_proposals_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proposals_pending ON public.cleanup_proposals USING btree (user_id, created_at DESC) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_cleanup_proposals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proposals_status ON public.cleanup_proposals USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_cleanup_proposals_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proposals_tenant_id ON public.cleanup_proposals USING btree (tenant_id);


--
-- Name: idx_cleanup_proposals_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proposals_user_id ON public.cleanup_proposals USING btree (user_id);


--
-- Name: idx_connected_accounts_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connected_accounts_active ON public.connected_accounts USING btree (tenant_id) WHERE (disconnected_at IS NULL);


--
-- Name: idx_connected_accounts_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connected_accounts_provider ON public.connected_accounts USING btree (tenant_id, provider);


--
-- Name: idx_connected_accounts_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connected_accounts_tenant_id ON public.connected_accounts USING btree (tenant_id);


--
-- Name: idx_email_log_attention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_attention ON public.boss_email_log USING btree (needs_attention, processed_at DESC);


--
-- Name: idx_email_log_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_category ON public.boss_email_log USING btree (category);


--
-- Name: idx_event_rules_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_rules_tenant_id ON public.event_rules USING btree (tenant_id);


--
-- Name: idx_event_rules_type_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_rules_type_active ON public.event_rules USING btree (tenant_id, event_type, priority) WHERE (is_active = true);


--
-- Name: idx_event_rules_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_rules_user_id ON public.event_rules USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_events_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_correlation ON public.events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_created ON public.events USING btree (created_at DESC);


--
-- Name: idx_events_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_tenant_id ON public.events USING btree (tenant_id);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.events USING btree (tenant_id, event_type, created_at DESC);


--
-- Name: idx_events_unprocessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_unprocessed ON public.events USING btree (tenant_id, created_at) WHERE (processed = false);


--
-- Name: idx_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_user_id ON public.events USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_file_rules_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_rules_active ON public.file_rules USING btree (tenant_id, provider, priority) WHERE (is_active = true);


--
-- Name: idx_file_rules_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_rules_tenant_id ON public.file_rules USING btree (tenant_id);


--
-- Name: idx_file_rules_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_rules_user_id ON public.file_rules USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_health_checks_checked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_health_checks_checked_at ON public.health_checks USING btree (checked_at DESC);


--
-- Name: idx_health_checks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_health_checks_status ON public.health_checks USING btree (status, checked_at DESC) WHERE ((status)::text <> 'healthy'::text);


--
-- Name: idx_health_checks_tenant_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_health_checks_tenant_service ON public.health_checks USING btree (tenant_id, service, checked_at DESC);


--
-- Name: idx_incidents_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_created ON public.incidents USING btree (created_at DESC);


--
-- Name: idx_incidents_escalated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_escalated ON public.incidents USING btree (escalated, created_at DESC) WHERE (escalated = true);


--
-- Name: idx_incidents_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_service ON public.incidents USING btree (service, created_at DESC);


--
-- Name: idx_incidents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_status ON public.incidents USING btree (status) WHERE ((status)::text <> 'resolved'::text);


--
-- Name: idx_incidents_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incidents_tenant_id ON public.incidents USING btree (tenant_id);


--
-- Name: idx_invites_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_email ON public.invites USING btree (email);


--
-- Name: idx_invites_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invites_status ON public.invites USING btree (status);


--
-- Name: idx_ircaios_pending_passkeys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ircaios_pending_passkeys_hash ON public.boss_pending_passkeys USING btree (passkey_hash);


--
-- Name: idx_learning_profiles_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_learning_profiles_tenant_id ON public.learning_profiles USING btree (tenant_id);


--
-- Name: idx_learning_profiles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_learning_profiles_user_id ON public.learning_profiles USING btree (user_id);


--
-- Name: idx_oauth_tokens_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_account_id ON public.boss_oauth_tokens USING btree (account_id);


--
-- Name: idx_oauth_tokens_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_expires ON public.oauth_tokens USING btree (expires_at) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_oauth_tokens_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_provider ON public.oauth_tokens USING btree (tenant_id, provider);


--
-- Name: idx_oauth_tokens_provider_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_provider_email ON public.boss_oauth_tokens USING btree (provider, email);


--
-- Name: idx_oauth_tokens_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_tenant_id ON public.oauth_tokens USING btree (tenant_id);


--
-- Name: idx_oauth_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_user_id ON public.oauth_tokens USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_onboarding_progress_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onboarding_progress_status ON public.onboarding_progress USING btree (tenant_id, status);


--
-- Name: idx_onboarding_progress_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onboarding_progress_tenant_id ON public.onboarding_progress USING btree (tenant_id);


--
-- Name: idx_onboarding_progress_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onboarding_progress_user_id ON public.onboarding_progress USING btree (user_id);


--
-- Name: idx_playbooks_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_active ON public.playbooks USING btree (service, is_active) WHERE (is_active = true);


--
-- Name: idx_playbooks_global; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_global ON public.playbooks USING btree (service) WHERE (tenant_id IS NULL);


--
-- Name: idx_playbooks_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_service ON public.playbooks USING btree (service);


--
-- Name: idx_playbooks_signature_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_signature_fts ON public.playbooks USING gin (to_tsvector('english'::regconfig, failure_signature));


--
-- Name: idx_playbooks_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_tenant_id ON public.playbooks USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_preferences_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preferences_category ON public.preferences USING btree (tenant_id, category) WHERE (is_active = true);


--
-- Name: idx_preferences_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preferences_source ON public.preferences USING btree (source, tenant_id);


--
-- Name: idx_preferences_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preferences_tenant_id ON public.preferences USING btree (tenant_id);


--
-- Name: idx_preferences_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preferences_user_id ON public.preferences USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_expires ON public.sessions USING btree (expires_at);


--
-- Name: idx_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_token ON public.sessions USING btree (token);


--
-- Name: idx_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);


--
-- Name: idx_slack_attention_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slack_attention_open ON public.slack_attention USING btree (tenant_id, created_at DESC) WHERE (status = 'open'::text);


--
-- Name: idx_sync_state_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_state_due ON public.sync_state USING btree (tenant_id, next_sync NULLS FIRST) WHERE (status = ANY (ARRAY['idle'::text, 'never'::text, 'error'::text]));


--
-- Name: idx_sync_state_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_state_tenant ON public.sync_state USING btree (tenant_id);


--
-- Name: idx_tenants_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_slug ON public.tenants USING btree (slug);


--
-- Name: idx_tenants_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_status ON public.tenants USING btree (status);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_passkey_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_passkey_hash ON public.users USING btree (passkey_hash) WHERE (passkey_hash IS NOT NULL);


--
-- Name: idx_users_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant_id ON public.users USING btree (tenant_id);


--
-- Name: idx_users_tenant_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant_role ON public.users USING btree (tenant_id, role);


--
-- Name: idx_voice_devices_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_devices_room ON public.voice_devices USING btree (tenant_id, room);


--
-- Name: idx_voice_devices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_devices_status ON public.voice_devices USING btree (tenant_id, status);


--
-- Name: idx_voice_devices_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_devices_tenant_id ON public.voice_devices USING btree (tenant_id);


--
-- Name: idx_wa_contacts_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_contacts_name ON public.boss_whatsapp_contacts USING btree (tenant_id, lower(display_name)) WHERE (display_name IS NOT NULL);


--
-- Name: idx_wa_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_contacts_phone ON public.boss_whatsapp_contacts USING btree (tenant_id, phone) WHERE (phone IS NOT NULL);


--
-- Name: idx_wa_contacts_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_contacts_synced ON public.boss_whatsapp_contacts USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_wa_drafts_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_drafts_pending ON public.boss_whatsapp_drafts USING btree (tenant_id, chat_id) WHERE (status = 'pending'::text);


--
-- Name: idx_wa_messages_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_messages_thread ON public.boss_whatsapp_messages USING btree (tenant_id, chat_id, sent_at DESC);


--
-- Name: idx_wa_messages_wa_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_wa_messages_wa_id ON public.boss_whatsapp_messages USING btree (tenant_id, wa_message_id) WHERE (wa_message_id IS NOT NULL);


--
-- Name: idx_wa_scheduled_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_scheduled_chat ON public.boss_whatsapp_scheduled USING btree (tenant_id, chat_id, created_at DESC);


--
-- Name: idx_wa_scheduled_send_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_scheduled_send_at ON public.boss_whatsapp_scheduled USING btree (tenant_id, send_at) WHERE ((status = 'approved'::text) AND (sent_at IS NULL));


--
-- Name: idx_wa_threads_last; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_threads_last ON public.boss_whatsapp_threads USING btree (tenant_id, last_message_at DESC) WHERE (archived = false);


--
-- Name: idx_whatsapp_monitors_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_monitors_agent ON public.boss_whatsapp_monitors USING btree (tenant_id, agent_handle) WHERE enabled;


--
-- Name: boss_chat_sessions ircaios_chat_sessions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ircaios_chat_sessions_set_updated_at BEFORE UPDATE ON public.boss_chat_sessions FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: behavioral_patterns trg_behavioral_patterns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_behavioral_patterns_updated_at BEFORE UPDATE ON public.behavioral_patterns FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: brain_config trg_brain_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_brain_config_updated_at BEFORE UPDATE ON public.brain_config FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: cleanup_proposals trg_cleanup_proposals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cleanup_proposals_updated_at BEFORE UPDATE ON public.cleanup_proposals FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: event_rules trg_event_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_event_rules_updated_at BEFORE UPDATE ON public.event_rules FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: file_rules trg_file_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_file_rules_updated_at BEFORE UPDATE ON public.file_rules FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: incidents trg_incidents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_incidents_updated_at BEFORE UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: learning_profiles trg_learning_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_learning_profiles_updated_at BEFORE UPDATE ON public.learning_profiles FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: oauth_tokens trg_oauth_tokens_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_oauth_tokens_updated_at BEFORE UPDATE ON public.oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: playbooks trg_playbooks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_playbooks_updated_at BEFORE UPDATE ON public.playbooks FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: preferences trg_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_preferences_updated_at BEFORE UPDATE ON public.preferences FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: sync_state trg_sync_state_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_state_updated_at BEFORE UPDATE ON public.sync_state FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: tenants trg_tenants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: voice_devices trg_voice_devices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_voice_devices_updated_at BEFORE UPDATE ON public.voice_devices FOR EACH ROW EXECUTE FUNCTION public.ircaios_set_updated_at();


--
-- Name: backup_log backup_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_log
    ADD CONSTRAINT backup_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: behavioral_patterns behavioral_patterns_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_patterns
    ADD CONSTRAINT behavioral_patterns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: behavioral_patterns behavioral_patterns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.behavioral_patterns
    ADD CONSTRAINT behavioral_patterns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: boss_stage_log boss_stage_log_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_stage_log
    ADD CONSTRAINT boss_stage_log_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.boss_tasks(id) ON DELETE CASCADE;


--
-- Name: boss_tasks boss_tasks_pipeline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_tasks
    ADD CONSTRAINT boss_tasks_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES public.boss_pipelines(id) ON DELETE SET NULL;


--
-- Name: boss_whatsapp_drafts boss_whatsapp_drafts_tenant_id_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_drafts
    ADD CONSTRAINT boss_whatsapp_drafts_tenant_id_chat_id_fkey FOREIGN KEY (tenant_id, chat_id) REFERENCES public.boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE;


--
-- Name: boss_whatsapp_messages boss_whatsapp_messages_tenant_id_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_messages
    ADD CONSTRAINT boss_whatsapp_messages_tenant_id_chat_id_fkey FOREIGN KEY (tenant_id, chat_id) REFERENCES public.boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE;


--
-- Name: boss_whatsapp_monitors boss_whatsapp_monitors_tenant_id_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_monitors
    ADD CONSTRAINT boss_whatsapp_monitors_tenant_id_chat_id_fkey FOREIGN KEY (tenant_id, chat_id) REFERENCES public.boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE;


--
-- Name: boss_whatsapp_scheduled boss_whatsapp_scheduled_tenant_id_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_whatsapp_scheduled
    ADD CONSTRAINT boss_whatsapp_scheduled_tenant_id_chat_id_fkey FOREIGN KEY (tenant_id, chat_id) REFERENCES public.boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE;


--
-- Name: brain_config brain_config_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_config
    ADD CONSTRAINT brain_config_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cached_contacts cached_contacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_contacts
    ADD CONSTRAINT cached_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cached_emails cached_emails_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_emails
    ADD CONSTRAINT cached_emails_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cached_events cached_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_events
    ADD CONSTRAINT cached_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cached_files cached_files_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_files
    ADD CONSTRAINT cached_files_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cached_tasks cached_tasks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cached_tasks
    ADD CONSTRAINT cached_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cleanup_proposals cleanup_proposals_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_proposals
    ADD CONSTRAINT cleanup_proposals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cleanup_proposals cleanup_proposals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_proposals
    ADD CONSTRAINT cleanup_proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: connected_accounts connected_accounts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: connected_accounts connected_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: event_rules event_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rules
    ADD CONSTRAINT event_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: event_rules event_rules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rules
    ADD CONSTRAINT event_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: events events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: events events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: file_rules file_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_rules
    ADD CONSTRAINT file_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: file_rules file_rules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_rules
    ADD CONSTRAINT file_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: health_checks health_checks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_checks
    ADD CONSTRAINT health_checks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: incidents incidents_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: incidents incidents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: boss_chat_messages ircaios_chat_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boss_chat_messages
    ADD CONSTRAINT ircaios_chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.boss_chat_sessions(id) ON DELETE CASCADE;


--
-- Name: learning_profiles learning_profiles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_profiles
    ADD CONSTRAINT learning_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: learning_profiles learning_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_profiles
    ADD CONSTRAINT learning_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: oauth_tokens oauth_tokens_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: oauth_tokens oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: onboarding_progress onboarding_progress_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: onboarding_progress onboarding_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: playbooks playbooks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: preferences preferences_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: preferences preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sync_state sync_state_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: voice_devices voice_devices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_devices
    ADD CONSTRAINT voice_devices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Permanent agent shell turns. Claude processes are fresh per turn; the tmux
-- shell persists independently and this table is the durable turn ledger.
--

CREATE TABLE IF NOT EXISTS public.boss_agent_turns (
    id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    agent_kind text NOT NULL,
    handle text NOT NULL,
    chat_session_id uuid NOT NULL REFERENCES public.boss_chat_sessions(id) ON DELETE CASCADE,
    assistant_message_id uuid NOT NULL REFERENCES public.boss_chat_messages(id) ON DELETE CASCADE,
    cli_session_id text,
    raw_prompt text NOT NULL,
    enriched_prompt text NOT NULL,
    context_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    response text DEFAULT ''::text NOT NULL,
    recap text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT boss_agent_turns_kind_ck CHECK (agent_kind = ANY (ARRAY['rascal'::text, 'outsider'::text])),
    CONSTRAINT boss_agent_turns_status_ck CHECK (status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'interrupting'::text, 'completed'::text, 'interrupted'::text, 'failed'::text]))
);

CREATE INDEX IF NOT EXISTS idx_boss_agent_turns_handle
    ON public.boss_agent_turns (tenant_id, agent_kind, handle, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_boss_agent_turns_chat_session
    ON public.boss_agent_turns (chat_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_boss_agent_turns_recovery
    ON public.boss_agent_turns (status, started_at)
    WHERE status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'interrupting'::text]);

CREATE UNIQUE INDEX IF NOT EXISTS uq_boss_agent_turns_one_active
    ON public.boss_agent_turns (tenant_id, agent_kind, handle)
    WHERE status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'interrupting'::text]);


--
-- Durable source ledger for guarded, BOS-local Weaviate memory. All object
-- writes still pass through /api/aios/memory so they are redacted, embedded,
-- and deduplicated before this ledger is committed.
--

CREATE TABLE IF NOT EXISTS public.aios_memory_ledger (
    content_hash text PRIMARY KEY,
    weaviate_id uuid NOT NULL,
    device_id text NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    redacted boolean DEFAULT false NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aios_memory_ledger_accepted
    ON public.aios_memory_ledger (accepted_at DESC);

CREATE INDEX IF NOT EXISTS idx_aios_memory_ledger_device
    ON public.aios_memory_ledger (device_id, accepted_at DESC);


--
-- PostgreSQL database dump complete
--

\unrestrict EJp2pm4LR22y0NVAnMFgxazcdiPxGIAtHUXnyvSlRitpx6jExnibEX6y9NaCh0O

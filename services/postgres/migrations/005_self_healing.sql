-- =============================================================================
-- IR Custom AIOS v2 — Migration 005: Self-Healing Engine
-- Tables: playbooks, incidents, health_checks
-- Supports: 3-layer autonomic healing (monitor -> diagnose -> learn).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PLAYBOOKS
-- Immune memory. Built from successful incident resolutions. Matched by
-- failure_signature (regex/pattern) before attempting blind diagnosis.
-- tenant_id = NULL means a global playbook shared across all tenants.
-- success_count is the trust signal — higher = battle-tested.
-- ---------------------------------------------------------------------------
CREATE TABLE playbooks (
    id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID        REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = global
    failure_signature       TEXT        NOT NULL,   -- regex or keyword pattern matched against error messages
    service                 VARCHAR(100) NOT NULL,
    -- Services: brain, google_connector, microsoft_connector, voice_device,
    --           postgres, weaviate, redis, backup, stt, tts, worker, api
    severity                VARCHAR(20) NOT NULL DEFAULT 'medium'
                                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    diagnosis_steps         JSONB       NOT NULL DEFAULT '[]',  -- ordered array of diagnostic check strings
    fix_steps               JSONB       NOT NULL DEFAULT '[]',  -- ordered array of action strings
    verification            TEXT        NOT NULL,               -- how to confirm the fix worked
    success_count           INTEGER     NOT NULL DEFAULT 0,
    failure_count           INTEGER     NOT NULL DEFAULT 0,     -- times this playbook was tried but didn't fix it
    last_used               TIMESTAMPTZ,
    created_from_incident   UUID,                               -- incident.id that produced this playbook
    is_active               BOOLEAN     NOT NULL DEFAULT true,
    notes                   TEXT,                               -- human annotations
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE playbooks IS
    'Immune memory for the self-healing engine. '
    'When an incident occurs, matcher.ts searches this table for a matching failure_signature. '
    'If found, the playbook fix_steps are executed before attempting blind diagnosis. '
    'success_count grows each time a playbook resolves an issue. '
    'builder.ts creates new rows from incidents resolved by the diagnostic agent. '
    'tenant_id=NULL rows are global playbooks shared across all tenants.';

COMMENT ON COLUMN playbooks.failure_signature IS
    'Regex or keyword pattern matched against incident error_message. '
    'Example: "token.*expired|401.*Unauthorized"';

COMMENT ON COLUMN playbooks.diagnosis_steps IS
    'Ordered JSON array of diagnostic check descriptions. '
    'Example: ["Check token expiry in oauth_tokens", "Verify provider endpoint is reachable", '
    '"Test refresh with current refresh_token"]';

COMMENT ON COLUMN playbooks.fix_steps IS
    'Ordered JSON array of action descriptions executed by actions/*.ts modules. '
    'Example: ["Call refresh-auth.ts for provider=google", "Update oauth_tokens.expires_at", '
    '"Verify connector health check passes"]';

COMMENT ON COLUMN playbooks.success_count IS
    'Number of times this playbook resolved an incident. Primary trust signal. '
    'Month 1: mostly 0. Month 6: critical playbooks may have 50+.';

CREATE INDEX idx_playbooks_service ON playbooks(service);
CREATE INDEX idx_playbooks_tenant_id ON playbooks(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_playbooks_global ON playbooks(service) WHERE tenant_id IS NULL;
CREATE INDEX idx_playbooks_active ON playbooks(service, is_active) WHERE is_active = true;
-- Full-text search on failure_signature for the matcher
CREATE INDEX idx_playbooks_signature_fts ON playbooks
    USING gin(to_tsvector('english', failure_signature));

CREATE TRIGGER trg_playbooks_updated_at
    BEFORE UPDATE ON playbooks
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- INCIDENTS
-- Every detected failure is recorded here with the full diagnostic and fix
-- attempt history. Drives escalation decisions and feeds playbook creation.
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        REFERENCES tenants(id) ON DELETE CASCADE,
    service         VARCHAR(100) NOT NULL,
    severity        VARCHAR(20) NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status          VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'diagnosing', 'fixing', 'resolved', 'escalated')),
    error_message   TEXT        NOT NULL,
    error_context   JSONB       NOT NULL DEFAULT '{}',  -- stack trace, request data, env state
    diagnosis       TEXT,                               -- diagnostic agent's conclusion
    fix_attempted   TEXT,                               -- description of fix that was tried
    fix_result      TEXT,                               -- outcome of fix attempt
    attempts        JSONB       NOT NULL DEFAULT '[]',
    -- Array of { attemptNumber, action, result, timestamp, playbook_id? }
    playbook_id     UUID        REFERENCES playbooks(id) ON DELETE SET NULL,
    escalated       BOOLEAN     NOT NULL DEFAULT false,
    escalation_sent_at TIMESTAMPTZ,
    escalation_channel VARCHAR(50),                     -- 'slack', 'push', 'voice', 'email'
    resolved_by     VARCHAR(50),                        -- 'playbook', 'diagnostic', 'human'
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE incidents IS
    'Full record of every detected system failure. '
    'Layer 2 (diagnostic agent) writes attempts as it works through diagnosis. '
    'After 3 failed attempts, escalated=true and notification is sent. '
    'When resolved, resolved_by and resolved_at are set. '
    'If resolved by diagnostic agent with no playbook, builder.ts creates a new playbook row.';

COMMENT ON COLUMN incidents.attempts IS
    'JSON array tracking each fix attempt. '
    'Schema: [{ attemptNumber: 1, action: "restart_service", '
    'result: "service restarted but error recurred", timestamp: "..." }]';

COMMENT ON COLUMN incidents.error_context IS
    'Structured context captured at time of failure: last N log lines, '
    'environment state, active connections, memory usage, etc.';

CREATE INDEX idx_incidents_tenant_id ON incidents(tenant_id);
CREATE INDEX idx_incidents_service ON incidents(service, created_at DESC);
CREATE INDEX idx_incidents_status ON incidents(status) WHERE status NOT IN ('resolved');
CREATE INDEX idx_incidents_escalated ON incidents(escalated, created_at DESC) WHERE escalated = true;
CREATE INDEX idx_incidents_created ON incidents(created_at DESC);

CREATE TRIGGER trg_incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- HEALTH_CHECKS
-- Rolling log of every heartbeat check result. 30-second interval per service.
-- Used by the monitor to detect failures and by the dashboard for status history.
-- Keep last N days only — worker prunes rows older than retention window.
-- ---------------------------------------------------------------------------
CREATE TABLE health_checks (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        REFERENCES tenants(id) ON DELETE CASCADE,
    service         VARCHAR(100) NOT NULL,
    status          VARCHAR(20) NOT NULL
                        CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
    response_time_ms INTEGER,                   -- NULL if check timed out
    error           TEXT,                       -- NULL if healthy
    metadata        JSONB       NOT NULL DEFAULT '{}',  -- e.g. { "tokenExpiresIn": 3600 }
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE health_checks IS
    'Rolling log of 30-second heartbeat check results for every monitored service. '
    'monitor.ts writes one row per check per service. '
    'Worker prunes rows older than 7 days (configurable). '
    'Two consecutive unhealthy results trigger Layer 2 (diagnostic agent). '
    'The web dashboard reads the most recent row per service for current status.';

COMMENT ON COLUMN health_checks.service IS
    'Monitored service identifier. Values: brain, google_connector, microsoft_connector, '
    'voice_{device_id}, postgres, weaviate, redis, backup, stt, tts, worker, api.';

CREATE INDEX idx_health_checks_tenant_service ON health_checks(tenant_id, service, checked_at DESC);
CREATE INDEX idx_health_checks_status ON health_checks(status, checked_at DESC)
    WHERE status != 'healthy';
CREATE INDEX idx_health_checks_checked_at ON health_checks(checked_at DESC);  -- for pruning

-- =============================================================================
-- IR Custom AIOS v2 — Migration 007: Events & Event Rules
-- Tables: events, event_rules
-- Supports: internal event bus persistence, user-defined automation rules
-- Depends on: 001_foundation.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EVENTS
-- Persistent event log for the internal event bus.
-- Every significant system or user event is written here before fan-out.
-- Consumed by event_rules processor, analytics, and audit trail.
-- Worker prunes rows older than retention window (default 90 days).
-- ---------------------------------------------------------------------------
CREATE TABLE events (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID            REFERENCES users(id) ON DELETE SET NULL,   -- NULL = system event
    event_type      VARCHAR(100)    NOT NULL,
    -- System events: brain.request, brain.response, brain.error, brain.fallback
    -- Connector events: connector.sync, connector.auth_refresh, connector.error
    -- User events: user.message, user.voice_command, user.preference_set
    -- Learning events: learning.pattern_detected, learning.profile_updated
    -- Self-healing events: health.check, health.incident_opened, health.incident_resolved
    -- Backup events: backup.started, backup.completed, backup.failed
    -- File events: file.created, file.modified, file.cleanup_proposed
    source          VARCHAR(50)     NOT NULL DEFAULT 'system'
                        CHECK (source IN ('system', 'user', 'connector', 'brain', 'voice',
                                          'learning', 'self_healing', 'backup', 'file', 'external')),
    payload         JSONB           NOT NULL DEFAULT '{}',
    correlation_id  UUID,           -- links related events (e.g. request -> response -> brain call)
    processed       BOOLEAN         NOT NULL DEFAULT false,
    processed_at    TIMESTAMPTZ,
    error           TEXT,           -- set if rule processing failed for this event
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE events IS
    'Persistent event log for IR Custom AIOS internal event bus. '
    'Every significant action writes an event before fan-out to subscribers. '
    'event_rules processor reads unprocessed events (processed=false) on a polling loop. '
    'Worker prunes rows older than 90 days (configurable per tenant in tenants.config). '
    'correlation_id links causally related events for tracing and debugging.';

COMMENT ON COLUMN events.event_type IS
    'Dot-notation event identifier. Convention: {domain}.{action}. '
    'Examples: brain.request, connector.auth_refresh, learning.pattern_detected, '
    'health.incident_opened, file.cleanup_proposed.';

COMMENT ON COLUMN events.payload IS
    'Event-specific data. Schema varies by event_type. '
    'Example for connector.auth_refresh: { provider: "google", account_label: "work", '
    'user_id: "...", triggered_by: "expiry_check" }';

COMMENT ON COLUMN events.correlation_id IS
    'Groups causally related events. A brain.request event and its brain.response share the same '
    'correlation_id. Set by the emitter; NULL for standalone events.';

CREATE INDEX idx_events_tenant_id ON events(tenant_id);
CREATE INDEX idx_events_type ON events(tenant_id, event_type, created_at DESC);
CREATE INDEX idx_events_user_id ON events(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_events_unprocessed ON events(tenant_id, created_at)
    WHERE processed = false;
CREATE INDEX idx_events_correlation ON events(correlation_id)
    WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_events_created ON events(created_at DESC);  -- for prune queries

-- ---------------------------------------------------------------------------
-- EVENT_RULES
-- User-defined automation rules: "when X happens, do Y".
-- Evaluated by the event processor for each unprocessed event.
-- conditions is a JSON filter matched against the event payload.
-- actions is an ordered list of actions to execute when conditions match.
-- ---------------------------------------------------------------------------
CREATE TABLE event_rules (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID            REFERENCES users(id) ON DELETE CASCADE,  -- NULL = tenant-wide rule
    name            VARCHAR(255)    NOT NULL,
    description     TEXT,
    event_type      VARCHAR(100)    NOT NULL,   -- event_type pattern to match (supports '*' wildcard prefix)
    conditions      JSONB           NOT NULL DEFAULT '{}',
    -- JSONLogic or simple key/value conditions matched against event.payload.
    -- Example: { "payload.provider": "google", "payload.status": "expired" }
    actions         JSONB           NOT NULL DEFAULT '[]',
    -- Ordered array of action objects. Each action has: { type, params }.
    -- Types: notify_user, call_webhook, run_playbook, update_preference,
    --        send_brain_prompt, create_task, emit_event
    -- Example: [{ "type": "notify_user", "params": { "channel": "push",
    --             "message": "Google token expired — re-auth needed" } }]
    is_active       BOOLEAN         NOT NULL DEFAULT true,
    priority        INTEGER         NOT NULL DEFAULT 100,  -- lower = evaluated first
    run_count       INTEGER         NOT NULL DEFAULT 0,
    last_triggered  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE event_rules IS
    'User-defined automation rules evaluated by the event processor. '
    'Rules are matched in priority order (lower integer = higher priority). '
    'conditions is matched against event.payload using JSONLogic evaluation. '
    'actions are executed in array order when all conditions pass. '
    'user_id=NULL rules apply to all users in the tenant. '
    'is_active=false rules are skipped without deletion (allows temporary disabling).';

COMMENT ON COLUMN event_rules.event_type IS
    'Event type to listen for. Exact match or wildcard prefix. '
    'Examples: "connector.auth_refresh", "health.*", "brain.error"';

COMMENT ON COLUMN event_rules.conditions IS
    'JSONLogic conditions applied to event.payload. Empty object {} matches all events of this type. '
    'Example: {"==":[{"var":"provider"},"google"]} matches only Google connector events.';

COMMENT ON COLUMN event_rules.actions IS
    'Ordered action array. Each action: { type: string, params: object }. '
    'Execution stops on first error unless params.continue_on_error is true.';

COMMENT ON COLUMN event_rules.priority IS
    'Evaluation order. Lower integer = evaluated first. '
    'Default 100. Critical rules should use 1-10. User convenience rules use 100-999.';

CREATE INDEX idx_event_rules_tenant_id ON event_rules(tenant_id);
CREATE INDEX idx_event_rules_user_id ON event_rules(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_event_rules_type_active ON event_rules(tenant_id, event_type, priority)
    WHERE is_active = true;

CREATE TRIGGER trg_event_rules_updated_at
    BEFORE UPDATE ON event_rules
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

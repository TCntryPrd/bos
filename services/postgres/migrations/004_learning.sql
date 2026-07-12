-- =============================================================================
-- IR Custom AIOS v2 — Migration 004: Learning Engine
-- Tables: learning_profiles, preferences, behavioral_patterns, onboarding_progress
-- Supports: onboarding deep dive, passive pattern learning, explicit preferences.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- LEARNING_PROFILES
-- Master profile for a user, synthesized from all learning sources.
-- profile_json is a denormalized snapshot rebuilt by synthesizer.ts after
-- each significant learning update. The Brain Router context middleware reads
-- this to inject user context into every brain request.
-- ---------------------------------------------------------------------------
CREATE TABLE learning_profiles (
    id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id                 UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_json            JSONB       NOT NULL DEFAULT '{}',
    -- Structured snapshot, e.g.:
    -- { workHours: {start: "09:00", end: "18:00"},
    --   communicationTone: "professional-direct",
    --   topContacts: [...], meetingPreferences: {...},
    --   fileConventions: {...}, taskPatterns: {...} }
    communication_style     VARCHAR(100) NOT NULL DEFAULT 'unknown'
                                CHECK (communication_style IN
                                    ('formal', 'professional-direct', 'casual', 'technical', 'concise', 'unknown')),
    onboarding_complete     BOOLEAN     NOT NULL DEFAULT false,
    profile_version         INTEGER     NOT NULL DEFAULT 1,        -- incremented on each synthesis run
    last_synthesized_at     TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

COMMENT ON TABLE learning_profiles IS
    'Master user profile maintained by the Learning Engine. '
    'synthesizer.ts rebuilds profile_json after significant learning events. '
    'The Brain Router context middleware injects this profile before every brain call. '
    'Vector embeddings live in Weaviate; this table holds structured metadata only.';

COMMENT ON COLUMN learning_profiles.profile_json IS
    'Denormalized profile snapshot. Keys include workHours, communicationTone, '
    'topContacts, meetingPreferences, fileConventions, taskPatterns, etc.';

COMMENT ON COLUMN learning_profiles.profile_version IS
    'Monotonically incremented each time synthesizer.ts rebuilds the profile. '
    'Useful for cache invalidation in the Brain Router.';

CREATE INDEX idx_learning_profiles_tenant_id ON learning_profiles(tenant_id);
CREATE INDEX idx_learning_profiles_user_id ON learning_profiles(user_id);

CREATE TRIGGER trg_learning_profiles_updated_at
    BEFORE UPDATE ON learning_profiles
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- PREFERENCES
-- Explicit and learned rules for how IR Custom AIOS should behave.
-- Explicit preferences (source='explicit') always override learned ones.
-- Higher weight = stronger preference signal.
-- ---------------------------------------------------------------------------
CREATE TABLE preferences (
    id          UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID            REFERENCES users(id) ON DELETE CASCADE,    -- NULL = tenant-wide preference
    rule        TEXT            NOT NULL,          -- natural-language rule: "Never schedule before 9am"
    category    VARCHAR(100)    NOT NULL DEFAULT 'general',
    -- Categories: scheduling, communication, files, tasks, voice, notifications, privacy
    weight      REAL            NOT NULL DEFAULT 1.0 CHECK (weight BETWEEN 0 AND 10),
    source      VARCHAR(50)     NOT NULL DEFAULT 'explicit'
                    CHECK (source IN ('explicit', 'learned', 'onboarding', 'suggested')),
    is_active   BOOLEAN         NOT NULL DEFAULT true,
    context     JSONB           NOT NULL DEFAULT '{}',  -- optional structured context for rule application
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE preferences IS
    'Behavioral rules for IR Custom AIOS. Explicit rules (from direct user instruction) override '
    'learned rules when they conflict. weight=10 = absolute rule, weight=1 = soft preference. '
    'The Brain Router context middleware bundles active preferences into each brain call.';

COMMENT ON COLUMN preferences.rule IS
    'Natural-language rule as stated or inferred. Example: "Never schedule meetings before 9am." '
    'or "When Brad emails, always flag as high priority."';

COMMENT ON COLUMN preferences.weight IS
    'Strength of preference on scale 0-10. Explicit=10, learned from repeated behavior=1-5, '
    'single observation=0.5. Higher weight wins when rules conflict.';

CREATE INDEX idx_preferences_tenant_id ON preferences(tenant_id);
CREATE INDEX idx_preferences_user_id ON preferences(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_preferences_category ON preferences(tenant_id, category) WHERE is_active = true;
CREATE INDEX idx_preferences_source ON preferences(source, tenant_id);

CREATE TRIGGER trg_preferences_updated_at
    BEFORE UPDATE ON preferences
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- BEHAVIORAL_PATTERNS
-- Passively observed patterns built from historical ingest and ongoing monitoring.
-- observation_count and confidence increase as the system sees more data.
-- Pattern embeddings live in Weaviate; structured metadata stays here.
-- ---------------------------------------------------------------------------
CREATE TABLE behavioral_patterns (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id             UUID        REFERENCES users(id) ON DELETE CASCADE,
    pattern_type        VARCHAR(100) NOT NULL,
    -- Types: communication_timing, meeting_behavior, task_completion,
    --        delegation, productivity_peak, file_organization, response_speed,
    --        contact_priority, email_labeling, calendar_blocking
    pattern_data        JSONB       NOT NULL DEFAULT '{}',   -- structured data specific to pattern_type
    description         TEXT,                                -- human-readable summary of the pattern
    confidence          REAL        NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    observation_count   INTEGER     NOT NULL DEFAULT 1,
    first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE behavioral_patterns IS
    'Passively learned patterns from historical ingest and ongoing observation. '
    'confidence approaches 1.0 as observation_count grows. '
    'Low-confidence patterns (< 0.3) are suggestions only; high-confidence (> 0.8) are treated as facts. '
    'Embeddings for semantic retrieval live in Weaviate with this row id as metadata.';

COMMENT ON COLUMN behavioral_patterns.pattern_data IS
    'Structured data describing the pattern. Schema varies by pattern_type. '
    'Example for communication_timing: { peakHours: [9,10,14,15], avgResponseMinutes: 12, '
    'weekdayOnly: true }';

COMMENT ON COLUMN behavioral_patterns.confidence IS
    'Value 0-1. Starts at 0.5 on first observation. Approaches 1.0 with repeated confirmation. '
    'Drops when contradicting evidence is observed.';

CREATE INDEX idx_behavioral_patterns_tenant_id ON behavioral_patterns(tenant_id);
CREATE INDEX idx_behavioral_patterns_user_id ON behavioral_patterns(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_behavioral_patterns_type ON behavioral_patterns(tenant_id, pattern_type);
CREATE INDEX idx_behavioral_patterns_confidence ON behavioral_patterns(confidence DESC);

CREATE TRIGGER trg_behavioral_patterns_updated_at
    BEFORE UPDATE ON behavioral_patterns
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- ONBOARDING_PROGRESS
-- Tracks the deep-dive ingest sprint per platform per user.
-- Surfaced to the user as: "Learning your business... 34% complete"
-- ---------------------------------------------------------------------------
CREATE TABLE onboarding_progress (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform        VARCHAR(50) NOT NULL,
    -- Platforms: gmail, outlook, google_calendar, outlook_calendar,
    --            google_drive, onedrive, google_tasks, microsoft_todo,
    --            slack, teams, stripe, smart_home, desktop_files
    status          VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
    items_processed INTEGER     NOT NULL DEFAULT 0,
    total_items     INTEGER     NOT NULL DEFAULT 0,
    error_message   TEXT,
    metadata        JSONB       NOT NULL DEFAULT '{}',   -- platform-specific ingest stats
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, platform)
);

COMMENT ON TABLE onboarding_progress IS
    'Tracks the historical ingest sprint run when a user first connects their business accounts. '
    'Each platform gets one row. progress.ts computes overall % from sum of items_processed / total_items. '
    'status=completed rows are kept for audit; the sprint is not re-run unless explicitly reset.';

COMMENT ON COLUMN onboarding_progress.platform IS
    'Which platform this row tracks. One row per platform per user. '
    'See src/learning/onboarding/ for the ingest module for each platform.';

COMMENT ON COLUMN onboarding_progress.metadata IS
    'Platform-specific ingest stats. Example for gmail: '
    '{ emailsAnalyzed: 2847, labelsFound: 12, topSenders: [...] }';

CREATE INDEX idx_onboarding_progress_tenant_id ON onboarding_progress(tenant_id);
CREATE INDEX idx_onboarding_progress_user_id ON onboarding_progress(user_id);
CREATE INDEX idx_onboarding_progress_status ON onboarding_progress(tenant_id, status);

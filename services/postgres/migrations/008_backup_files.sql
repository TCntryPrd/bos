-- =============================================================================
-- IR Custom AIOS v2 — Migration 008: Backup & File Management
-- Tables: backup_log, file_rules, cleanup_proposals
-- Supports: automated backup tracking, file organization rules, cleanup suggestions
-- Depends on: 001_foundation.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BACKUP_LOG
-- Audit trail for every backup operation attempted or completed.
-- Written by the backup worker before starting (status=running) and updated
-- on completion or failure. expires_at drives auto-deletion of old backup records.
-- ---------------------------------------------------------------------------
CREATE TABLE backup_log (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID            REFERENCES tenants(id) ON DELETE SET NULL,
    -- NULL = system-level backup not scoped to a tenant (e.g. full postgres dump)
    backup_type         VARCHAR(20)     NOT NULL
                            CHECK (backup_type IN ('postgres', 'weaviate', 'config', 'full')),
    destination         VARCHAR(20)     NOT NULL
                            CHECK (destination IN ('git', 's3', 'local', 'both')),
    status              VARCHAR(20)     NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    file_size_bytes     BIGINT,
    file_path           TEXT,           -- relative path within destination storage
    checksum            VARCHAR(128),   -- SHA-256 hex digest for integrity verification
    encryption_key_id   VARCHAR(100),   -- key identifier (not the key itself) for encrypted backups
    error_message       TEXT,
    metadata            JSONB           NOT NULL DEFAULT '{}',
    -- metadata keys: tablesExported, rowCount, weaviateCollections, compressionRatio
    started_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,    -- NULL = keep forever; set for rolling retention
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE backup_log IS
    'Audit trail for all backup operations. '
    'The backup worker inserts a row with status=running before starting, '
    'then updates to completed or failed on finish. '
    'expires_at is set by the worker based on tenant retention policy (default 30 days). '
    'A cleanup job deletes rows and associated files after expires_at passes. '
    'checksum enables integrity verification before restore.';

COMMENT ON COLUMN backup_log.backup_type IS
    'postgres: pg_dump of the relational database. '
    'weaviate: export of all vector collections. '
    'config: workflow/env config snapshot only. '
    'full: postgres + weaviate + config in one archive.';

COMMENT ON COLUMN backup_log.encryption_key_id IS
    'Identifier of the encryption key used, not the key material itself. '
    'Used to look up the key from the external key management service at restore time.';

CREATE INDEX idx_backup_log_tenant_id ON backup_log(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_backup_log_status ON backup_log(status, started_at DESC);
CREATE INDEX idx_backup_log_expires ON backup_log(expires_at)
    WHERE expires_at IS NOT NULL;  -- for cleanup sweep
CREATE INDEX idx_backup_log_started ON backup_log(started_at DESC);

-- ---------------------------------------------------------------------------
-- FILE_RULES
-- User-defined rules for how IR Custom AIOS should organize, name, and manage files
-- in connected cloud storage (Google Drive, OneDrive).
-- Evaluated by the file organization engine when new files are detected.
-- ---------------------------------------------------------------------------
CREATE TABLE file_rules (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID            REFERENCES users(id) ON DELETE CASCADE,  -- NULL = tenant-wide rule
    name            VARCHAR(255)    NOT NULL,
    description     TEXT,
    provider        VARCHAR(50)     NOT NULL DEFAULT 'all'
                        CHECK (provider IN ('google_drive', 'onedrive', 'all')),
    rule_type       VARCHAR(50)     NOT NULL
                        CHECK (rule_type IN ('move', 'rename', 'tag', 'archive', 'delete', 'notify')),
    match_pattern   JSONB           NOT NULL DEFAULT '{}',
    -- Match conditions for files. Keys: name_regex, mime_type, min_age_days,
    -- max_age_days, folder_path, owner_email, size_bytes_gt, size_bytes_lt
    -- Example: { "name_regex": "^Invoice_", "folder_path": "/Downloads" }
    action_params   JSONB           NOT NULL DEFAULT '{}',
    -- Action parameters. Keys vary by rule_type.
    -- move: { destination_folder: "/Finance/2026/Invoices" }
    -- rename: { template: "{year}-{month}-{original}" }
    -- tag: { labels: ["invoice", "finance"] }
    -- archive: { destination: "s3", prefix: "archive/" }
    -- delete: { require_confirmation: true }
    -- notify: { message: "New invoice in Downloads", channel: "push" }
    is_active       BOOLEAN         NOT NULL DEFAULT true,
    priority        INTEGER         NOT NULL DEFAULT 100,
    run_count       INTEGER         NOT NULL DEFAULT 0,
    last_triggered  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE file_rules IS
    'User-defined rules for automatic file organization in cloud storage. '
    'Evaluated by the file engine when new or modified files are detected via Drive/OneDrive webhooks. '
    'Rules are applied in priority order (lower integer = higher priority). '
    'rule_type=delete always requires explicit user confirmation unless require_confirmation=false in action_params. '
    'user_id=NULL rules are tenant-wide defaults applied to all users.';

COMMENT ON COLUMN file_rules.match_pattern IS
    'JSON conditions for file matching. '
    'name_regex: JS-compatible regex. mime_type: exact MIME type string. '
    'folder_path: prefix match on file path. min_age_days/max_age_days: file age filter.';

COMMENT ON COLUMN file_rules.action_params IS
    'Action execution parameters. Schema is specific to rule_type. '
    'See file-engine/actions/*.ts for full parameter documentation per action type.';

CREATE INDEX idx_file_rules_tenant_id ON file_rules(tenant_id);
CREATE INDEX idx_file_rules_user_id ON file_rules(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_file_rules_active ON file_rules(tenant_id, provider, priority)
    WHERE is_active = true;

CREATE TRIGGER trg_file_rules_updated_at
    BEFORE UPDATE ON file_rules
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- ---------------------------------------------------------------------------
-- CLEANUP_PROPOSALS
-- AI-generated suggestions for files that can be deleted or archived.
-- Proposals are surfaced to the user for approval before any destructive action.
-- status tracks the full lifecycle from proposal through user decision to execution.
-- ---------------------------------------------------------------------------
CREATE TABLE cleanup_proposals (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            VARCHAR(50)     NOT NULL
                            CHECK (provider IN ('google_drive', 'onedrive', 'local')),
    file_id             VARCHAR(500)    NOT NULL,   -- provider-native file ID
    file_name           TEXT            NOT NULL,
    file_path           TEXT,
    file_size_bytes     BIGINT,
    last_modified_at    TIMESTAMPTZ,
    last_accessed_at    TIMESTAMPTZ,
    proposal_type       VARCHAR(20)     NOT NULL
                            CHECK (proposal_type IN ('delete', 'archive', 'move', 'merge')),
    reason              TEXT            NOT NULL,   -- AI-generated human-readable rationale
    confidence          REAL            NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    destination         TEXT,           -- for archive/move proposals: target location
    status              VARCHAR(20)     NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
    reviewed_at         TIMESTAMPTZ,
    executed_at         TIMESTAMPTZ,
    error_message       TEXT,
    batch_id            UUID,           -- groups related proposals from the same analysis run
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE cleanup_proposals IS
    'AI-generated file cleanup suggestions awaiting user review. '
    'The file engine generates proposals; status=pending means not yet reviewed. '
    'status=approved triggers execution; status=rejected is logged but no action taken. '
    'Proposals expire to status=expired after 30 days if not reviewed (configurable). '
    'No destructive file action is taken without user approval (approved or auto-approve rule). '
    'batch_id groups proposals generated in a single analysis sweep for bulk review UX.';

COMMENT ON COLUMN cleanup_proposals.reason IS
    'Human-readable AI rationale for the proposal. '
    'Examples: "Duplicate of Invoice_2026-03.pdf (98% similarity, same folder)", '
    '"Not opened in 847 days and matches archive rule for files > 1 year old"';

COMMENT ON COLUMN cleanup_proposals.confidence IS
    'AI confidence that this is a safe action (0-1). '
    'Proposals with confidence < 0.7 require explicit user confirmation even with auto-approve rules.';

COMMENT ON COLUMN cleanup_proposals.batch_id IS
    'UUID linking all proposals from a single analysis run. '
    'Used by the review UI to show a grouped batch for bulk approve/reject.';

CREATE INDEX idx_cleanup_proposals_tenant_id ON cleanup_proposals(tenant_id);
CREATE INDEX idx_cleanup_proposals_user_id ON cleanup_proposals(user_id);
CREATE INDEX idx_cleanup_proposals_status ON cleanup_proposals(tenant_id, status, created_at DESC);
CREATE INDEX idx_cleanup_proposals_pending ON cleanup_proposals(user_id, created_at DESC)
    WHERE status = 'pending';
CREATE INDEX idx_cleanup_proposals_batch ON cleanup_proposals(batch_id)
    WHERE batch_id IS NOT NULL;

CREATE TRIGGER trg_cleanup_proposals_updated_at
    BEFORE UPDATE ON cleanup_proposals
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

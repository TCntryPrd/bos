-- =============================================================================
-- IR Custom AIOS v2 — Migration 010: Local Sync Cache
--
-- Purpose: Stores a local mirror of data from connected platforms (Gmail,
--          Outlook, Google Calendar, etc.) so the voice pipeline can answer
--          queries instantly without making live API calls.
--
-- Design notes:
--   • All tables share the same (tenant_id, account_id, <platform_id>) unique
--     key so delta-sync upserts are idempotent.
--   • synced_at is set by the application layer (not a DB trigger) so the
--     scheduler can backdate it during historical imports if needed.
--   • Indexes are chosen to support the CacheQuery access patterns:
--       - tenant_id first (partition key equivalent)
--       - date / start / due for time-range queries
--       - is_read, status for filtered queries the voice layer uses most
--   • Text search uses ILIKE in application queries. Add a pg_trgm GIN index
--     on name/subject if the contact/email counts exceed ~100k rows.
--
-- Depends on: 001_foundation.sql through 009_seed.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CACHED_EMAILS
-- ---------------------------------------------------------------------------

CREATE TABLE cached_emails (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID        NOT NULL,
    message_id      TEXT        NOT NULL,       -- provider message ID (immutable)
    from_address    TEXT        NOT NULL DEFAULT '',
    to_addresses    TEXT[]      NOT NULL DEFAULT '{}',
    subject         TEXT        NOT NULL DEFAULT '',
    snippet         TEXT        NOT NULL DEFAULT '',
    date            TIMESTAMPTZ NOT NULL,
    is_read         BOOLEAN     NOT NULL DEFAULT false,
    labels          TEXT[]      NOT NULL DEFAULT '{}',
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, account_id, message_id)
);

COMMENT ON TABLE cached_emails IS
    'Local mirror of email messages from Gmail and Outlook. '
    'Delta-synced every 20 minutes via the background worker. '
    'Voice queries read from here; live API only on cache miss or explicit refresh.';

COMMENT ON COLUMN cached_emails.message_id IS
    'Provider-assigned message ID. Gmail: numeric string. Graph: GUID.';

COMMENT ON COLUMN cached_emails.synced_at IS
    'Time this row was last written by the sync worker. Used to compute staleness.';

CREATE INDEX idx_cached_emails_tenant_date
    ON cached_emails (tenant_id, date DESC);

CREATE INDEX idx_cached_emails_tenant_account
    ON cached_emails (tenant_id, account_id, date DESC);

CREATE INDEX idx_cached_emails_unread
    ON cached_emails (tenant_id, account_id, date DESC)
    WHERE is_read = false;

CREATE INDEX idx_cached_emails_synced
    ON cached_emails (tenant_id, synced_at DESC);

-- ---------------------------------------------------------------------------
-- CACHED_EVENTS
-- ---------------------------------------------------------------------------

CREATE TABLE cached_events (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID        NOT NULL,
    event_id        TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT '',
    start           TIMESTAMPTZ NOT NULL,
    "end"           TIMESTAMPTZ NOT NULL,
    attendees       TEXT[]      NOT NULL DEFAULT '{}',
    location        TEXT,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, account_id, event_id)
);

COMMENT ON TABLE cached_events IS
    'Local mirror of calendar events from Google Calendar and Outlook Calendar. '
    'getTodayEvents() reads from here for sub-millisecond voice responses.';

CREATE INDEX idx_cached_events_tenant_start
    ON cached_events (tenant_id, start);

CREATE INDEX idx_cached_events_tenant_account_start
    ON cached_events (tenant_id, account_id, start);

CREATE INDEX idx_cached_events_synced
    ON cached_events (tenant_id, synced_at DESC);

-- ---------------------------------------------------------------------------
-- CACHED_TASKS
-- ---------------------------------------------------------------------------

CREATE TABLE cached_tasks (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID        NOT NULL,
    task_id         TEXT        NOT NULL,
    title           TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'needsAction',
    due             TIMESTAMPTZ,
    list            TEXT,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, account_id, task_id)
);

COMMENT ON TABLE cached_tasks IS
    'Local mirror of tasks from Google Tasks and Microsoft To Do. '
    'Full refresh each sync cycle (no incremental API on either platform).';

CREATE INDEX idx_cached_tasks_tenant_due
    ON cached_tasks (tenant_id, due ASC NULLS LAST);

CREATE INDEX idx_cached_tasks_tenant_account
    ON cached_tasks (tenant_id, account_id, due ASC NULLS LAST);

CREATE INDEX idx_cached_tasks_pending
    ON cached_tasks (tenant_id, account_id, due ASC NULLS LAST)
    WHERE status NOT IN ('completed');

CREATE INDEX idx_cached_tasks_synced
    ON cached_tasks (tenant_id, synced_at DESC);

-- ---------------------------------------------------------------------------
-- CACHED_CONTACTS
-- ---------------------------------------------------------------------------

CREATE TABLE cached_contacts (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID        NOT NULL,
    contact_id      TEXT        NOT NULL,
    name            TEXT        NOT NULL DEFAULT '',
    email           TEXT,
    phone           TEXT,
    company         TEXT,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, account_id, contact_id)
);

COMMENT ON TABLE cached_contacts IS
    'Local mirror of contacts from Google People API and Microsoft Graph. '
    'Synced via syncToken (Google) and delta query (Graph). '
    'searchContacts() uses ILIKE on name/email/company for voice lookups.';

CREATE INDEX idx_cached_contacts_tenant
    ON cached_contacts (tenant_id);

CREATE INDEX idx_cached_contacts_tenant_account
    ON cached_contacts (tenant_id, account_id);

CREATE INDEX idx_cached_contacts_name
    ON cached_contacts (tenant_id, name);

CREATE INDEX idx_cached_contacts_email
    ON cached_contacts (tenant_id, email)
    WHERE email IS NOT NULL;

CREATE INDEX idx_cached_contacts_synced
    ON cached_contacts (tenant_id, synced_at DESC);

-- ---------------------------------------------------------------------------
-- CACHED_FILES
-- ---------------------------------------------------------------------------

CREATE TABLE cached_files (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID        NOT NULL,
    file_id         TEXT        NOT NULL,
    name            TEXT        NOT NULL DEFAULT '',
    mime_type       TEXT        NOT NULL DEFAULT 'application/octet-stream',
    path            TEXT,
    size            BIGINT,
    modified        TIMESTAMPTZ,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, account_id, file_id)
);

COMMENT ON TABLE cached_files IS
    'Local mirror of file metadata from Google Drive and OneDrive. '
    'Content is never stored — only metadata needed for search and routing. '
    'searchFiles() uses ILIKE on name for voice file-finding.';

CREATE INDEX idx_cached_files_tenant_modified
    ON cached_files (tenant_id, modified DESC NULLS LAST);

CREATE INDEX idx_cached_files_tenant_account
    ON cached_files (tenant_id, account_id, modified DESC NULLS LAST);

CREATE INDEX idx_cached_files_name
    ON cached_files (tenant_id, name);

CREATE INDEX idx_cached_files_synced
    ON cached_files (tenant_id, synced_at DESC);

-- ---------------------------------------------------------------------------
-- SYNC_STATE
-- Tracks per-(tenant, account, service) sync cursor and scheduling metadata.
-- One row per combination — upserted by the worker on every sync cycle.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_state (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id      UUID        NOT NULL,
    service         TEXT        NOT NULL
                        CHECK (service IN (
                            'mail', 'calendar', 'tasks', 'drive', 'contacts',
                            -- provider-qualified variants stored internally
                            'gmail', 'outlook_mail', 'google_calendar',
                            'outlook_calendar', 'google_tasks', 'ms_tasks',
                            'google_drive', 'onedrive', 'google_contacts',
                            'ms_contacts'
                        )),
    last_sync       TIMESTAMPTZ,
    next_sync       TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'never'
                        CHECK (status IN ('never', 'idle', 'running', 'error')),
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, account_id, service)
);

COMMENT ON TABLE sync_state IS
    'Scheduler bookkeeping for the background delta-sync worker. '
    'last_sync feeds into delta queries (updatedMin, historyId lookups). '
    'next_sync drives the priority queue in SyncScheduler.filterDueAccounts(). '
    'Cursor tokens (historyId, deltaLink) are stored in Redis, not here — '
    'they are too volatile for Postgres and Redis TTL handles expiry cleanly.';

COMMENT ON COLUMN sync_state.status IS
    'never = no successful sync yet; idle = last sync succeeded; '
    'running = sync in progress; error = last sync failed (see error column).';

COMMENT ON COLUMN sync_state.service IS
    'Granular service identifier. The scheduler tracks mail, calendar, tasks, '
    'drive, and contacts separately so one failing service does not block others.';

CREATE INDEX idx_sync_state_tenant
    ON sync_state (tenant_id);

CREATE INDEX idx_sync_state_due
    ON sync_state (tenant_id, next_sync ASC NULLS FIRST)
    WHERE status IN ('idle', 'never', 'error');

CREATE TRIGGER trg_sync_state_updated_at
    BEFORE UPDATE ON sync_state
    FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

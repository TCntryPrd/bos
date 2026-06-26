/**
 * CacheStore — CRUD for locally cached platform data in Postgres.
 *
 * All writes are upserts keyed on (tenant_id, account_id, <platform_message_id>)
 * so repeated syncs are idempotent. Every row carries a synced_at timestamp that
 * CacheQuery uses to compute staleness.
 *
 * Design constraint: this module does NOT import the `pg` package directly.
 * It accepts a structural DB interface (same pattern as token-store.ts) so it
 * can be injected with any pg.Pool-compatible client without adding a hard
 * compile-time dependency to the worker package.json.
 */

// ---------------------------------------------------------------------------
// DB interface (compatible with pg.Pool / pg.PoolClient)
// ---------------------------------------------------------------------------

export interface CacheStoreDB {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Row shapes returned from queries
// ---------------------------------------------------------------------------

export interface CachedEmail {
  id: string;
  tenant_id: string;
  account_id: string;
  message_id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  snippet: string;
  date: Date;
  is_read: boolean;
  labels: string[];
  synced_at: Date;
}

export interface CachedEvent {
  id: string;
  tenant_id: string;
  account_id: string;
  event_id: string;
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
  location: string | null;
  synced_at: Date;
}

export interface CachedTask {
  id: string;
  tenant_id: string;
  account_id: string;
  task_id: string;
  title: string;
  status: string;
  due: Date | null;
  list: string | null;
  synced_at: Date;
}

export interface CachedContact {
  id: string;
  tenant_id: string;
  account_id: string;
  contact_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  synced_at: Date;
}

export interface CachedFile {
  id: string;
  tenant_id: string;
  account_id: string;
  file_id: string;
  name: string;
  mime_type: string;
  path: string | null;
  size: number | null;
  modified: Date | null;
  synced_at: Date;
}

export interface SyncState {
  id: string;
  tenant_id: string;
  account_id: string;
  service: string;
  last_sync: Date | null;
  next_sync: Date | null;
  status: 'idle' | 'running' | 'error' | 'never';
  error: string | null;
}

// ---------------------------------------------------------------------------
// Write param shapes (what the sync layer passes in)
// ---------------------------------------------------------------------------

export type UpsertEmailParams = Omit<CachedEmail, 'id' | 'synced_at'>;
export type UpsertEventParams = Omit<CachedEvent, 'id' | 'synced_at'>;
export type UpsertTaskParams = Omit<CachedTask, 'id' | 'synced_at'>;
export type UpsertContactParams = Omit<CachedContact, 'id' | 'synced_at'>;
export type UpsertFileParams = Omit<CachedFile, 'id' | 'synced_at'>;

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

export class CacheStore {
  constructor(private readonly db: CacheStoreDB) {}

  // ── Emails ───────────────────────────────────────────────────────────────

  async upsertEmails(rows: UpsertEmailParams[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO cached_emails
           (tenant_id, account_id, message_id, from_address, to_addresses,
            subject, snippet, date, is_read, labels, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (tenant_id, account_id, message_id)
         DO UPDATE SET
           from_address = EXCLUDED.from_address,
           to_addresses = EXCLUDED.to_addresses,
           subject      = EXCLUDED.subject,
           snippet      = EXCLUDED.snippet,
           date         = EXCLUDED.date,
           is_read      = EXCLUDED.is_read,
           labels       = EXCLUDED.labels,
           synced_at    = NOW()`,
        [
          r.tenant_id, r.account_id, r.message_id,
          r.from_address, r.to_addresses,
          r.subject, r.snippet, r.date, r.is_read, r.labels,
        ],
      );
    }
  }

  async deleteEmail(tenantId: string, accountId: string, messageId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cached_emails
       WHERE tenant_id = $1 AND account_id = $2 AND message_id = $3`,
      [tenantId, accountId, messageId],
    );
  }

  // ── Events ───────────────────────────────────────────────────────────────

  async upsertEvents(rows: UpsertEventParams[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO cached_events
           (tenant_id, account_id, event_id, title, start, "end",
            attendees, location, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
         ON CONFLICT (tenant_id, account_id, event_id)
         DO UPDATE SET
           title      = EXCLUDED.title,
           start      = EXCLUDED.start,
           "end"      = EXCLUDED."end",
           attendees  = EXCLUDED.attendees,
           location   = EXCLUDED.location,
           synced_at  = NOW()`,
        [
          r.tenant_id, r.account_id, r.event_id,
          r.title, r.start, r.end, r.attendees, r.location,
        ],
      );
    }
  }

  async deleteEvent(tenantId: string, accountId: string, eventId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cached_events
       WHERE tenant_id = $1 AND account_id = $2 AND event_id = $3`,
      [tenantId, accountId, eventId],
    );
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  async upsertTasks(rows: UpsertTaskParams[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO cached_tasks
           (tenant_id, account_id, task_id, title, status, due, list, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
         ON CONFLICT (tenant_id, account_id, task_id)
         DO UPDATE SET
           title     = EXCLUDED.title,
           status    = EXCLUDED.status,
           due       = EXCLUDED.due,
           list      = EXCLUDED.list,
           synced_at = NOW()`,
        [r.tenant_id, r.account_id, r.task_id, r.title, r.status, r.due, r.list],
      );
    }
  }

  async deleteTask(tenantId: string, accountId: string, taskId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cached_tasks
       WHERE tenant_id = $1 AND account_id = $2 AND task_id = $3`,
      [tenantId, accountId, taskId],
    );
  }

  // ── Contacts ─────────────────────────────────────────────────────────────

  async upsertContacts(rows: UpsertContactParams[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO cached_contacts
           (tenant_id, account_id, contact_id, name, email, phone, company, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
         ON CONFLICT (tenant_id, account_id, contact_id)
         DO UPDATE SET
           name      = EXCLUDED.name,
           email     = EXCLUDED.email,
           phone     = EXCLUDED.phone,
           company   = EXCLUDED.company,
           synced_at = NOW()`,
        [r.tenant_id, r.account_id, r.contact_id, r.name, r.email, r.phone, r.company],
      );
    }
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  async upsertFiles(rows: UpsertFileParams[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO cached_files
           (tenant_id, account_id, file_id, name, mime_type, path, size, modified, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
         ON CONFLICT (tenant_id, account_id, file_id)
         DO UPDATE SET
           name      = EXCLUDED.name,
           mime_type = EXCLUDED.mime_type,
           path      = EXCLUDED.path,
           size      = EXCLUDED.size,
           modified  = EXCLUDED.modified,
           synced_at = NOW()`,
        [
          r.tenant_id, r.account_id, r.file_id,
          r.name, r.mime_type, r.path, r.size, r.modified,
        ],
      );
    }
  }

  async deleteFile(tenantId: string, accountId: string, fileId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cached_files
       WHERE tenant_id = $1 AND account_id = $2 AND file_id = $3`,
      [tenantId, accountId, fileId],
    );
  }

  // ── Sync State ────────────────────────────────────────────────────────────

  async getSyncState(
    tenantId: string,
    accountId: string,
    service: string,
  ): Promise<SyncState | null> {
    const result = await this.db.query<SyncState>(
      `SELECT id, tenant_id, account_id, service, last_sync, next_sync, status, error
       FROM sync_state
       WHERE tenant_id = $1 AND account_id = $2 AND service = $3`,
      [tenantId, accountId, service],
    );
    return result.rows[0] ?? null;
  }

  async getAllSyncStates(tenantId: string): Promise<SyncState[]> {
    const result = await this.db.query<SyncState>(
      `SELECT id, tenant_id, account_id, service, last_sync, next_sync, status, error
       FROM sync_state
       WHERE tenant_id = $1
       ORDER BY COALESCE(next_sync, '1970-01-01') ASC`,
      [tenantId],
    );
    return result.rows;
  }

  async setSyncRunning(tenantId: string, accountId: string, service: string): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_state (tenant_id, account_id, service, status, last_sync, next_sync, error)
       VALUES ($1, $2, $3, 'running', NULL, NULL, NULL)
       ON CONFLICT (tenant_id, account_id, service)
       DO UPDATE SET status = 'running', error = NULL`,
      [tenantId, accountId, service],
    );
  }

  async setSyncComplete(
    tenantId: string,
    accountId: string,
    service: string,
    nextSyncMs: number,
  ): Promise<void> {
    const nextSync = new Date(Date.now() + nextSyncMs);
    await this.db.query(
      `INSERT INTO sync_state (tenant_id, account_id, service, status, last_sync, next_sync, error)
       VALUES ($1, $2, $3, 'idle', NOW(), $4, NULL)
       ON CONFLICT (tenant_id, account_id, service)
       DO UPDATE SET status = 'idle', last_sync = NOW(), next_sync = $4, error = NULL`,
      [tenantId, accountId, service, nextSync],
    );
  }

  async setSyncError(
    tenantId: string,
    accountId: string,
    service: string,
    error: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_state (tenant_id, account_id, service, status, last_sync, next_sync, error)
       VALUES ($1, $2, $3, 'error', NOW(), NULL, $4)
       ON CONFLICT (tenant_id, account_id, service)
       DO UPDATE SET status = 'error', last_sync = NOW(), error = $4`,
      [tenantId, accountId, service, error],
    );
  }
}

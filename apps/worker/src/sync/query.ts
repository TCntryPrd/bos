/**
 * CacheQuery — fast local reads from the Postgres cache tables.
 *
 * These are the methods the voice pipeline and API layer call instead of hitting
 * live connector APIs. Every result carries a `staleness_ms` field so callers
 * can decide whether to show a "last updated X min ago" hint or fall back to a
 * live call.
 *
 * All queries are index-friendly:
 *   - tenant_id is always the leading predicate (partition key equivalent)
 *   - date range filters use the indexed date / start / due columns
 *   - text search uses ILIKE with a %query% pattern — good enough for local
 *     caches with O(thousands) of rows; replace with pg_trgm if needed
 */

import type { CacheStoreDB } from './cache-store.js';
import type {
  CachedEmail,
  CachedEvent,
  CachedTask,
  CachedContact,
  CachedFile,
} from './cache-store.js';

// ---------------------------------------------------------------------------
// Staleness metadata appended to every result set
// ---------------------------------------------------------------------------

export interface WithStaleness<T> {
  data: T[];
  /** Milliseconds since the most recently synced row in this result set.
   *  null means no rows were found (cache empty). */
  staleness_ms: number | null;
  /** ISO timestamp of the oldest synced_at in the result set */
  oldest_sync: string | null;
}

// ---------------------------------------------------------------------------
// Option bags
// ---------------------------------------------------------------------------

export interface RecentEmailsOptions {
  /** Filter to a specific connected account */
  accountId?: string;
  /** Only unread messages */
  unreadOnly?: boolean;
  /** Max results (default 50) */
  limit?: number;
  /** Return messages newer than this date */
  after?: Date;
}

export interface TodayEventsOptions {
  accountId?: string;
  /** Override "today" window — useful for testing */
  date?: Date;
}

export interface PendingTasksOptions {
  accountId?: string;
  /** Only tasks due on or before this date */
  dueBy?: Date;
  limit?: number;
}

export interface ContactSearchOptions {
  accountId?: string;
  limit?: number;
}

export interface FileSearchOptions {
  accountId?: string;
  mimeType?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// CacheQuery
// ---------------------------------------------------------------------------

export class CacheQuery {
  constructor(private readonly db: CacheStoreDB) {}

  // ── Emails ────────────────────────────────────────────────────────────────

  async getRecentEmails(
    tenantId: string,
    opts: RecentEmailsOptions = {},
  ): Promise<WithStaleness<CachedEmail>> {
    const { accountId, unreadOnly = false, limit = 50, after } = opts;
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (accountId) {
      conditions.push(`account_id = $${idx++}`);
      params.push(accountId);
    }
    if (unreadOnly) {
      conditions.push(`is_read = false`);
    }
    if (after) {
      conditions.push(`date >= $${idx++}`);
      params.push(after);
    }

    params.push(limit);
    const limitPlaceholder = `$${idx}`;

    const sql = `
      SELECT id, tenant_id, account_id, message_id, from_address, to_addresses,
             subject, snippet, date, is_read, labels, synced_at
      FROM cached_emails
      WHERE ${conditions.join(' AND ')}
      ORDER BY date DESC
      LIMIT ${limitPlaceholder}`;

    const result = await this.db.query<CachedEmail>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  // ── Calendar ──────────────────────────────────────────────────────────────

  async getTodayEvents(
    tenantId: string,
    opts: TodayEventsOptions = {},
  ): Promise<WithStaleness<CachedEvent>> {
    const { accountId, date = new Date() } = opts;

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const conditions: string[] = ['tenant_id = $1', 'start >= $2', '"end" <= $3'];
    const params: unknown[] = [tenantId, dayStart, dayEnd];

    if (accountId) {
      conditions.push(`account_id = $4`);
      params.push(accountId);
    }

    const sql = `
      SELECT id, tenant_id, account_id, event_id, title, start, "end",
             attendees, location, synced_at
      FROM cached_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY start ASC`;

    const result = await this.db.query<CachedEvent>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  /** Returns events in a date range — useful for "what's this week" queries. */
  async getEventsInRange(
    tenantId: string,
    start: Date,
    end: Date,
    accountId?: string,
  ): Promise<WithStaleness<CachedEvent>> {
    const conditions = ['tenant_id = $1', 'start >= $2', '"end" <= $3'];
    const params: unknown[] = [tenantId, start, end];

    if (accountId) {
      conditions.push(`account_id = $4`);
      params.push(accountId);
    }

    const sql = `
      SELECT id, tenant_id, account_id, event_id, title, start, "end",
             attendees, location, synced_at
      FROM cached_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY start ASC`;

    const result = await this.db.query<CachedEvent>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  async getPendingTasks(
    tenantId: string,
    opts: PendingTasksOptions = {},
  ): Promise<WithStaleness<CachedTask>> {
    const { accountId, dueBy, limit = 100 } = opts;

    const conditions = [
      'tenant_id = $1',
      "status != 'completed'",
    ];
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (accountId) {
      conditions.push(`account_id = $${idx++}`);
      params.push(accountId);
    }
    if (dueBy) {
      conditions.push(`(due IS NULL OR due <= $${idx++})`);
      params.push(dueBy);
    }

    params.push(limit);
    const limitPlaceholder = `$${idx}`;

    const sql = `
      SELECT id, tenant_id, account_id, task_id, title, status, due, list, synced_at
      FROM cached_tasks
      WHERE ${conditions.join(' AND ')}
      ORDER BY due ASC NULLS LAST, title ASC
      LIMIT ${limitPlaceholder}`;

    const result = await this.db.query<CachedTask>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  /** Overdue tasks (due date in the past and not completed) */
  async getOverdueTasks(
    tenantId: string,
    accountId?: string,
  ): Promise<WithStaleness<CachedTask>> {
    const conditions = [
      'tenant_id = $1',
      'due < NOW()',
      "status NOT IN ('completed')",
    ];
    const params: unknown[] = [tenantId];

    if (accountId) {
      conditions.push(`account_id = $2`);
      params.push(accountId);
    }

    const sql = `
      SELECT id, tenant_id, account_id, task_id, title, status, due, list, synced_at
      FROM cached_tasks
      WHERE ${conditions.join(' AND ')}
      ORDER BY due ASC`;

    const result = await this.db.query<CachedTask>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async searchContacts(
    tenantId: string,
    query: string,
    opts: ContactSearchOptions = {},
  ): Promise<WithStaleness<CachedContact>> {
    const { accountId, limit = 20 } = opts;
    const pattern = `%${query}%`;

    const conditions = [
      'tenant_id = $1',
      '(name ILIKE $2 OR email ILIKE $2 OR company ILIKE $2)',
    ];
    const params: unknown[] = [tenantId, pattern];
    let idx = 3;

    if (accountId) {
      conditions.push(`account_id = $${idx++}`);
      params.push(accountId);
    }

    params.push(limit);
    const limitPlaceholder = `$${idx}`;

    const sql = `
      SELECT id, tenant_id, account_id, contact_id, name, email, phone, company, synced_at
      FROM cached_contacts
      WHERE ${conditions.join(' AND ')}
      ORDER BY name ASC
      LIMIT ${limitPlaceholder}`;

    const result = await this.db.query<CachedContact>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  async searchFiles(
    tenantId: string,
    query: string,
    opts: FileSearchOptions = {},
  ): Promise<WithStaleness<CachedFile>> {
    const { accountId, mimeType, limit = 20 } = opts;
    const pattern = `%${query}%`;

    const conditions = ['tenant_id = $1', 'name ILIKE $2'];
    const params: unknown[] = [tenantId, pattern];
    let idx = 3;

    if (accountId) {
      conditions.push(`account_id = $${idx++}`);
      params.push(accountId);
    }
    if (mimeType) {
      conditions.push(`mime_type = $${idx++}`);
      params.push(mimeType);
    }

    params.push(limit);
    const limitPlaceholder = `$${idx}`;

    const sql = `
      SELECT id, tenant_id, account_id, file_id, name, mime_type, path, size, modified, synced_at
      FROM cached_files
      WHERE ${conditions.join(' AND ')}
      ORDER BY modified DESC NULLS LAST
      LIMIT ${limitPlaceholder}`;

    const result = await this.db.query<CachedFile>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  /** Recently modified files (no query filter) */
  async getRecentFiles(
    tenantId: string,
    accountId?: string,
    limit = 20,
  ): Promise<WithStaleness<CachedFile>> {
    const conditions = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let idx = 2;

    if (accountId) {
      conditions.push(`account_id = $${idx++}`);
      params.push(accountId);
    }

    params.push(limit);
    const limitPlaceholder = `$${idx}`;

    const sql = `
      SELECT id, tenant_id, account_id, file_id, name, mime_type, path, size, modified, synced_at
      FROM cached_files
      WHERE ${conditions.join(' AND ')}
      ORDER BY modified DESC NULLS LAST
      LIMIT ${limitPlaceholder}`;

    const result = await this.db.query<CachedFile>(sql, params);
    return this.withStaleness(result.rows, (r) => r.synced_at);
  }

  // ── Cache health ─────────────────────────────────────────────────────────

  /** Returns true if the cache has been populated for this tenant recently. */
  async isCacheWarm(tenantId: string, maxAgeMs = 30 * 60 * 1000): Promise<boolean> {
    const threshold = new Date(Date.now() - maxAgeMs);
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sync_state
       WHERE tenant_id = $1 AND status = 'idle' AND last_sync >= $2`,
      [tenantId, threshold],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private withStaleness<T>(
    rows: T[],
    getSyncedAt: (row: T) => Date,
  ): WithStaleness<T> {
    if (rows.length === 0) {
      return { data: [], staleness_ms: null, oldest_sync: null };
    }

    const now = Date.now();
    let oldest = Infinity;
    let oldestDate: Date | null = null;

    for (const row of rows) {
      const ts = getSyncedAt(row).getTime();
      if (ts < oldest) {
        oldest = ts;
        oldestDate = getSyncedAt(row);
      }
    }

    return {
      data: rows,
      staleness_ms: now - oldest,
      oldest_sync: oldestDate?.toISOString() ?? null,
    };
  }
}

/**
 * SyncScheduler — drives background delta-syncs for all connected accounts.
 *
 * Design:
 *   - Polls a configurable interval (default 20 min) for accounts that are due.
 *   - Uses Redis to track per-account-per-service cursor state (historyId,
 *     deltaLink). Sync timing metadata lives in Postgres sync_state table so
 *     it survives worker restarts without Redis.
 *   - Priority queue: accounts whose next_sync is farthest in the past run first.
 *   - Concurrency cap: at most MAX_CONCURRENT_SYNCS run simultaneously to avoid
 *     hammering the external APIs during catch-up after downtime.
 *   - Errors are caught per-account; one bad account never blocks others.
 *
 * The scheduler does not import @boss/connectors. Instead it receives factory
 * functions that produce HttpGetClient instances, keeping the compile graph clean.
 */

import { CacheStore } from './cache-store.js';
import { DeltaSync } from './delta-sync.js';
import type { DeltaCursors, HttpGetClient } from './delta-sync.js';

// ---------------------------------------------------------------------------
// Structural Redis interface (compatible with ioredis without importing it)
// ---------------------------------------------------------------------------

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Connected account descriptor (sourced from DB at startup + refresh)
// ---------------------------------------------------------------------------

export type AccountProvider = 'google' | 'microsoft';

export interface AccountDescriptor {
  /** UUID — matches oauth_tokens.id or connected_accounts.id */
  accountId: string;
  tenantId: string;
  provider: AccountProvider;
  /** Which service types this account has tokens for */
  services: ServiceType[];
}

export type ServiceType =
  | 'mail'
  | 'calendar'
  | 'tasks'
  | 'drive'
  | 'contacts';

// ---------------------------------------------------------------------------
// Client factory functions injected at startup
// ---------------------------------------------------------------------------

export interface ClientFactories {
  /** Returns an HTTP client scoped to the given Google account */
  googleClient(accountId: string): HttpGetClient;
  /** Returns an HTTP client scoped to the given Microsoft account */
  microsoftClient(accountId: string): HttpGetClient;
}

// ---------------------------------------------------------------------------
// Scheduler options
// ---------------------------------------------------------------------------

export interface SyncSchedulerOptions {
  /** How often to run the sync sweep (ms). Default: 20 minutes */
  intervalMs?: number;
  /** Max parallel syncs per sweep. Default: 4 */
  maxConcurrent?: number;
  /** How long before a next_sync deadline we consider an account "due" (ms). Default: 60s */
  dueWindowMs?: number;
}

const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;   // 20 min
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_DUE_WINDOW_MS = 60 * 1000;       // 60 s

// ---------------------------------------------------------------------------
// RedisCursors — implements DeltaCursors using Redis
// ---------------------------------------------------------------------------

class RedisCursors implements DeltaCursors {
  constructor(private readonly redis: RedisClient, private readonly prefix: string) {}

  private key(accountId: string, service: string): string {
    return `${this.prefix}:cursor:${accountId}:${service}`;
  }

  async getHistoryId(accountId: string, service: string): Promise<string | null> {
    return this.redis.get(this.key(accountId, service));
  }

  async setHistoryId(accountId: string, service: string, cursor: string): Promise<void> {
    // Cursor survives 7 days of inactivity; prevents stale startHistoryId rejection
    await this.redis.setex(this.key(accountId, service), 7 * 24 * 60 * 60, cursor);
  }

  async getDeltaLink(accountId: string, service: string): Promise<string | null> {
    return this.redis.get(this.key(accountId, service));
  }

  async setDeltaLink(accountId: string, service: string, link: string): Promise<void> {
    await this.redis.setex(this.key(accountId, service), 7 * 24 * 60 * 60, link);
  }
}

// ---------------------------------------------------------------------------
// Logger interface (structural — avoids hard pino dependency in this module)
// ---------------------------------------------------------------------------

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// SyncScheduler
// ---------------------------------------------------------------------------

export class SyncScheduler {
  private readonly store: CacheStore;
  private readonly deltaSync: DeltaSync;
  private readonly cursors: DeltaCursors;
  private readonly intervalMs: number;
  private readonly maxConcurrent: number;
  private readonly dueWindowMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private sweepActive = false;

  constructor(
    private readonly db: ConstructorParameters<typeof CacheStore>[0],
    redis: RedisClient,
    private readonly factories: ClientFactories,
    private readonly getAccounts: () => Promise<AccountDescriptor[]>,
    private readonly log: Logger,
    opts: SyncSchedulerOptions = {},
    redisKeyPrefix = 'boss',
  ) {
    this.store = new CacheStore(db);
    this.cursors = new RedisCursors(redis, redisKeyPrefix);
    this.deltaSync = new DeltaSync(this.store, this.cursors);
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.dueWindowMs = opts.dueWindowMs ?? DEFAULT_DUE_WINDOW_MS;
  }

  /** Start the scheduler. Runs an immediate sweep, then on interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info({ intervalMs: this.intervalMs }, 'SyncScheduler started');
    void this.sweep();
    this.scheduleNext();
  }

  /** Gracefully stop the scheduler. Current sweep finishes; no new ones start. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info({}, 'SyncScheduler stopped');
  }

  /** Force an immediate sweep regardless of schedule. Useful for testing. */
  async triggerSweep(): Promise<void> {
    await this.sweep();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.sweep();
      this.scheduleNext();
    }, this.intervalMs);
  }

  private async sweep(): Promise<void> {
    if (this.sweepActive) {
      this.log.warn({}, 'SyncScheduler sweep already in progress — skipping');
      return;
    }
    this.sweepActive = true;
    const sweepStart = Date.now();

    try {
      const accounts = await this.getAccounts();
      const due = await this.filterDueAccounts(accounts);

      this.log.info(
        { total: accounts.length, due: due.length },
        'SyncScheduler sweep starting',
      );

      // Process in batches of maxConcurrent
      for (let i = 0; i < due.length; i += this.maxConcurrent) {
        const batch = due.slice(i, i + this.maxConcurrent);
        await Promise.allSettled(
          batch.map((a) => this.syncAccount(a)),
        );
      }

      this.log.info(
        { durationMs: Date.now() - sweepStart, synced: due.length },
        'SyncScheduler sweep complete',
      );
    } catch (err) {
      this.log.error({ err }, 'SyncScheduler sweep failed unexpectedly');
    } finally {
      this.sweepActive = false;
    }
  }

  /**
   * Returns accounts sorted by how overdue they are (most stale first).
   * An account is "due" if its next_sync is in the past (within dueWindowMs grace).
   */
  private async filterDueAccounts(
    accounts: AccountDescriptor[],
  ): Promise<AccountDescriptor[]> {
    const now = Date.now();
    const results: Array<{ account: AccountDescriptor; overdueness: number }> = [];

    for (const account of accounts) {
      for (const service of account.services) {
        const state = await this.store.getSyncState(
          account.tenantId,
          account.accountId,
          service,
        );

        if (!state || state.status === 'never' || state.last_sync === null) {
          // Never synced — highest priority
          results.push({ account, overdueness: Infinity });
          break;
        }

        if (state.status === 'running') {
          // Already in flight — skip
          continue;
        }

        const nextSync = state.next_sync ? state.next_sync.getTime() : 0;
        const overdueness = now - (nextSync - this.dueWindowMs);
        if (overdueness > 0) {
          results.push({ account, overdueness });
          break; // one entry per account regardless of service count
        }
      }
    }

    // Sort most overdue first
    results.sort((a, b) => b.overdueness - a.overdueness);
    return results.map((r) => r.account);
  }

  private async syncAccount(account: AccountDescriptor): Promise<void> {
    const { tenantId, accountId, provider, services } = account;

    this.log.info({ tenantId, accountId, provider }, 'Syncing account');

    for (const service of services) {
      await this.store.setSyncRunning(tenantId, accountId, service);
      try {
        await this.syncService(account, service);
        await this.store.setSyncComplete(tenantId, accountId, service, this.intervalMs);
        this.log.info({ tenantId, accountId, service }, 'Service sync complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.store.setSyncError(tenantId, accountId, service, msg);
        this.log.error({ tenantId, accountId, service, err }, 'Service sync failed');
      }
    }
  }

  private async syncService(
    account: AccountDescriptor,
    service: ServiceType,
  ): Promise<void> {
    const { tenantId, accountId, provider } = account;

    // Retrieve last sync time for delta queries that need it
    const state = await this.store.getSyncState(tenantId, accountId, service);
    const lastSyncAt = state?.last_sync ?? null;

    if (provider === 'google') {
      const client = this.factories.googleClient(accountId);
      switch (service) {
        case 'mail':
          await this.deltaSync.syncGmail(tenantId, accountId, client, lastSyncAt);
          break;
        case 'calendar':
          await this.deltaSync.syncGoogleCalendar(tenantId, accountId, client, lastSyncAt);
          break;
        case 'tasks':
          await this.deltaSync.syncGoogleTasks(tenantId, accountId, client);
          break;
        case 'drive':
          await this.deltaSync.syncGoogleDrive(tenantId, accountId, client, lastSyncAt);
          break;
        case 'contacts':
          await this.deltaSync.syncGoogleContacts(tenantId, accountId, client);
          break;
      }
    } else {
      const client = this.factories.microsoftClient(accountId);
      switch (service) {
        case 'mail':
          await this.deltaSync.syncOutlookMail(tenantId, accountId, client);
          break;
        case 'calendar':
          await this.deltaSync.syncOutlookCalendar(tenantId, accountId, client);
          break;
        case 'tasks':
          await this.deltaSync.syncMicrosoftTasks(tenantId, accountId, client);
          break;
        case 'drive':
          await this.deltaSync.syncOneDrive(tenantId, accountId, client);
          break;
        case 'contacts':
          await this.deltaSync.syncMicrosoftContacts(tenantId, accountId, client);
          break;
      }
    }
  }
}

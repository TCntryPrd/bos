/**
 * @boss/worker — Background job processor
 *
 * Manages a shared throttle stack (SystemObserver + ComputeGovernor +
 * ThrottledQueue) that all background work runs through.  This prevents
 * ingest, sync, and learning tasks from saturating the machine when a
 * user is actively working.
 *
 * Task priorities:
 *   critical  — sync operations that must complete for data consistency
 *   normal    — periodic refresh, embedding updates
 *   low       — onboarding ingest, historical analysis
 *
 * The SyncScheduler drives background delta-syncs from connected platforms
 * (Gmail, Outlook, Google Calendar, OneDrive, etc.) into local Postgres cache
 * tables so the voice pipeline can answer queries instantly without live API
 * calls.  Postgres and Redis are injected as structural interfaces so the
 * worker compiles without hard pg / ioredis dependencies. Wire in real clients
 * before running in production (see stubs below).
 */

import {
  SystemObserver,
  ComputeGovernor,
  ThrottledQueue,
  createLogger,
} from '@boss/core';

import { SyncScheduler } from './sync/scheduler.js';
import type {
  AccountDescriptor,
  ClientFactories,
  RedisClient,
} from './sync/scheduler.js';
import type { CacheStoreDB } from './sync/cache-store.js';
import type { HttpGetClient } from './sync/delta-sync.js';

// ── Logger ────────────────────────────────────────────────────────────────────

const log = createLogger('worker');

// ── Throttle stack ────────────────────────────────────────────────────────────

const observer = new SystemObserver({
  mode: 'server',
  activeHours: {
    startHour: 8,
    endHour: 20,
    workDays: [1, 2, 3, 4, 5],
  },
  activityWindowMs: 120_000,
  sampleIntervalMs: 5_000,
});

const governor = new ComputeGovernor(observer, {
  pollIntervalMs: 10_000,
});

const queue = new ThrottledQueue(governor, {
  maxConcurrency: 4,
  tickIntervalMs: 2_000,
});

// ── Observability ─────────────────────────────────────────────────────────────

governor.on('change', ({ previous, current }: { previous: number; current: number }) => {
  log.info('Throttle level changed', { previous, current });
});

queue.on('taskStart', (task: { id: string; priority: string }) => {
  log.debug('Task started', { taskId: task.id, priority: task.priority });
});

queue.on('taskComplete', (result: { taskId: string; durationMs: number }) => {
  log.info('Task completed', { taskId: result.taskId, durationMs: result.durationMs });
});

queue.on('taskError', (result: { taskId: string; error?: string; durationMs: number }) => {
  log.warn('Task failed', {
    taskId: result.taskId,
    err_msg: result.error,
    durationMs: result.durationMs,
  });
});

// ── Postgres stub ─────────────────────────────────────────────────────────────
// Production: replace with `import { Pool } from 'pg'; const db = new Pool()`
// and add `pg` to @boss/worker dependencies.

const db: CacheStoreDB = {
  async query<T = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[],
  ): Promise<{ rows: T[] }> {
    log.warn('Postgres client not configured — sync writes are no-ops', {
      hint: 'Replace db stub with a real pg.Pool in apps/worker/src/index.ts',
    });
    return { rows: [] };
  },
};

// ── Redis stub ────────────────────────────────────────────────────────────────
// Production: replace with `import Redis from 'ioredis'; const redis = new Redis()`
// and add `ioredis` to @boss/worker dependencies.

const redis: RedisClient = {
  async get(_key: string): Promise<string | null> { return null; },
  async set(_key: string, _value: string): Promise<unknown> { return null; },
  async setex(_key: string, _seconds: number, _value: string): Promise<unknown> { return null; },
};

// ── Account loader ────────────────────────────────────────────────────────────
// Production: query `SELECT id, tenant_id, provider, services FROM connected_accounts
// WHERE status = 'active'` and map to AccountDescriptor[].

async function getAccounts(): Promise<AccountDescriptor[]> {
  return [];
}

// ── HTTP client factories ─────────────────────────────────────────────────────
// Production: construct GoogleClient / GraphClient from @boss/connectors
// and return per-accountId instances.

const syncClientFactories: ClientFactories = {
  googleClient(_accountId: string): HttpGetClient {
    throw new Error('GoogleClient factory not configured — wire in @boss/connectors');
  },
  microsoftClient(_accountId: string): HttpGetClient {
    throw new Error('GraphClient factory not configured — wire in @boss/connectors');
  },
};

// ── Scheduler logger adapter ──────────────────────────────────────────────────
// SyncScheduler.Logger takes (obj, msg) order; @boss/core Logger takes (msg, obj).

const schedulerLog = {
  info: (obj: Record<string, unknown>, msg: string) => log.info(msg, obj),
  warn: (obj: Record<string, unknown>, msg: string) => log.warn(msg, obj),
  error: (obj: Record<string, unknown>, msg: string) => log.error(msg, obj),
};

// ── SyncScheduler ─────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = parseInt(process.env['SYNC_INTERVAL_MS'] ?? '1200000', 10); // 20 min

const syncScheduler = new SyncScheduler(
  db,
  redis,
  syncClientFactories,
  getAccounts,
  schedulerLog,
  {
    intervalMs: SYNC_INTERVAL_MS,
    maxConcurrent: 4,
  },
  process.env['REDIS_KEY_PREFIX'] ?? 'boss',
);

// Wrap each SyncScheduler sweep as a critical queue task so it participates in
// the ThrottledQueue's concurrency and observability accounting.
const syncTimer = setInterval(() => {
  queue.enqueue(
    'sync:sweep',
    async () => {
      await syncScheduler.triggerSweep();
    },
    'critical',
  );
}, SYNC_INTERVAL_MS);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info('Shutting down', { signal });
  clearInterval(syncTimer);
  syncScheduler.stop();
  queue.destroy();
  governor.destroy();
  observer.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Boot ──────────────────────────────────────────────────────────────────────

log.info('BOS v2 Worker started', {
  throttleLevel: governor.getThrottleLevel(),
  canRunHeavyTask: governor.canRunHeavyTask(),
});

syncScheduler.start();

// Export the shared queue so future modules (e.g. onboarding route handler)
// can inject it directly rather than creating their own.
export { queue, governor, observer };

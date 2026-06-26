/**
 * db.ts — Postgres Pool singleton
 *
 * Call `initDb(connectionString)` once at startup (server.ts).
 * Call `getPool()` anywhere in the app to get the shared Pool instance.
 */

import pg from 'pg';

const { Pool } = pg;

let _pool: InstanceType<typeof Pool> | null = null;

/**
 * Create (or replace) the shared Pool. Must be called before `getPool()`.
 */
export function initDb(connectionString: string): InstanceType<typeof Pool> {
  _pool = new Pool({ connectionString });
  return _pool;
}

/**
 * Return the shared Pool. Throws if `initDb` has not been called.
 */
export function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    throw new Error('Database pool not initialized — call initDb() first');
  }
  return _pool;
}

/**
 * Close the shared Pool and release the singleton. Safe to call when no pool
 * exists. Primarily used by integration tests to ensure DROP DATABASE can
 * run without active connections blocking it.
 */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

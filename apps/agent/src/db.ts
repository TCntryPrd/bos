/**
 * Database connection — connects to the Postgres container from the host.
 * Uses the exposed port (default 5434) since we're not inside Docker.
 */

import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5434', 10),
      database: process.env.POSTGRES_DB || 'boss_db',
      user: process.env.POSTGRES_USER || 'boss',
      password: process.env.POSTGRES_PASSWORD || 'bosspass',
      max: 10,
    });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  const p = getPool();
  // Verify connection
  const { rows } = await p.query('SELECT 1 as ok');
  if (rows[0]?.ok !== 1) throw new Error('Database connection failed');
  console.log('[db] Connected to Postgres');
}

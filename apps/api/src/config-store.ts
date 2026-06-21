// Persistent config store backed by Postgres runtime_config table.
// Reads populate process.env so existing code that reads env vars still works.

import { getPool } from './db.js';

export async function loadRuntimeConfig(tenantId = 'default'): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT key, value FROM runtime_config WHERE tenant_id = $1',
    [tenantId],
  );
  for (const row of rows) {
    process.env[row.key] = row.value;
  }

  const fallback = await pool.query(
    `SELECT DISTINCT ON (key) key, value
       FROM runtime_config
      WHERE tenant_id <> $1
      ORDER BY key, updated_at DESC`,
    [tenantId],
  );
  for (const row of fallback.rows) {
    if (!process.env[row.key]) process.env[row.key] = row.value;
  }
}

export async function setRuntimeConfig(key: string, value: string, tenantId = 'default'): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO runtime_config (key, value, tenant_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key, tenant_id) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value, tenantId],
  );
  process.env[key] = value;
}

export async function getRuntimeConfig(key: string, tenantId = 'default'): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT value FROM runtime_config WHERE key = $1 AND tenant_id = $2',
    [key, tenantId],
  );
  return rows[0]?.value ?? null;
}

export async function deleteRuntimeConfig(key: string, tenantId = 'default'): Promise<void> {
  const pool = getPool();
  await pool.query(
    'DELETE FROM runtime_config WHERE key = $1 AND tenant_id = $2',
    [key, tenantId],
  );
  delete process.env[key];
}

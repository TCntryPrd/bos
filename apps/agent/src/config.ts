/**
 * Runtime config loader — reads from Postgres runtime_config table.
 * Sets process.env values so tools can access API keys etc.
 */

import { getPool } from './db.js';

export async function loadRuntimeConfig(): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM runtime_config WHERE tenant_id = 'default'`,
    );

    for (const { key, value } of rows) {
      if (value && !process.env[key]) {
        process.env[key] = value;
      }
    }

    console.log(`[config] Loaded ${rows.length} runtime config values from Postgres`);
  } catch (err) {
    console.warn('[config] Failed to load runtime config:', err);
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

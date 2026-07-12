/**
 * Google API registry + usage — the Google Manager's steward backbone.
 *
 * boss_google_registry maps each Google API → how it authenticates (per-account
 * OAuth vs an API key in a specific Cloud project), whether it's enabled, and its
 * cost model. getGoogleApiKey() resolves the CORRECT key for an api_key-based API
 * so tools never hardcode/guess. boss_google_usage logs metered calls for cost.
 */

import { getPool } from '../db.js';

export interface RegistryRow {
  api: string;
  auth_type: string;
  credential: string | null;
  project_id: string | null;
  enabled: boolean;
  cost_model: string | null;
  notes: string | null;
}

/**
 * Resolve the right API key for an api_key-based Google API via the registry → vault.
 * credential format is "vault:<service>/<label>". Returns null for OAuth APIs or
 * if the api is disabled/unknown.
 */
export async function getGoogleApiKey(api: string): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query<RegistryRow>(
    `SELECT * FROM boss_google_registry WHERE api = $1 AND enabled = true`,
    [api],
  );
  const reg = rows[0];
  if (!reg || reg.auth_type !== 'api_key' || !reg.credential) return null;
  const m = reg.credential.match(/^vault:(.+)\/([^/]+)$/);
  if (!m) return null;
  const [, service, label] = m;
  const { rows: vrows } = await pool.query<{ secret: string }>(
    `SELECT secret FROM boss_vault WHERE service = $1 AND label = $2 LIMIT 1`,
    [service, label],
  );
  return vrows[0]?.secret ?? null;
}

/** Append a metered-call record for Google cost tracking. Non-fatal on error. */
export async function logGoogleUsage(api: string, units: number, estCostUsd: number, source: string): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO boss_google_usage (api, units, est_cost_usd, source) VALUES ($1,$2,$3,$4)`,
      [api, units, estCostUsd, source],
    );
  } catch { /* observability only — never break the caller */ }
}

export async function getRegistry(): Promise<RegistryRow[]> {
  const { rows } = await getPool().query<RegistryRow>(
    `SELECT api, auth_type, credential, project_id, enabled, cost_model, notes
       FROM boss_google_registry ORDER BY auth_type, api`,
  );
  return rows;
}

export interface UsageBucket { api: string; units: number; cost: number }
export async function getUsageRollup(): Promise<{ today: UsageBucket[]; last30: UsageBucket[]; total30: number }> {
  const pool = getPool();
  const q = async (where: string): Promise<UsageBucket[]> =>
    (await pool.query<{ api: string; units: number; cost: string }>(
      `SELECT api, sum(units)::int AS units, round(coalesce(sum(est_cost_usd),0)::numeric,4) AS cost
         FROM boss_google_usage WHERE ${where} GROUP BY api ORDER BY cost DESC NULLS LAST`,
    )).rows.map((r) => ({ api: r.api, units: r.units, cost: Number(r.cost) }));
  const today = await q(`created_at::date = current_date`);
  const last30 = await q(`created_at > now() - interval '30 days'`);
  const total30 = last30.reduce((a, b) => a + (b.cost || 0), 0);
  return { today, last30, total30: Number(total30.toFixed(4)) };
}

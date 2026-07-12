/**
 * model-routes.ts — capability-label model routing + spend budgets (Fusion P2).
 *
 * resolveModel() turns an agent's `model` field into a concrete provider/model: if it
 * matches a registered route LABEL (boss_model_routes) it resolves to that model with
 * fallback ordering; otherwise it passes through unchanged (explicit model ids keep
 * working). budgetStatus() reads the existing cost ledger (boss_agent_runs.cost_usd)
 * against boss_budgets. Both are tenant-scoped and degrade to pass-through / no-cap when
 * the tables are empty, so nothing breaks pre-config.
 */
import { getPool } from '../db.js';
import { currentTenantId } from './tenant.js';

export interface ResolvedModel { model: string; provider?: string }

let routeCache: { at: number; map: Map<string, ResolvedModel> } = { at: 0, map: new Map() };
async function loadRoutes(): Promise<Map<string, ResolvedModel>> {
  if (Date.now() - routeCache.at < 60_000) return routeCache.map;
  const map = new Map<string, ResolvedModel>();
  try {
    const { rows } = await getPool().query<{ tenant_id: string; label: string; provider: string | null; model: string }>(
      `SELECT tenant_id, label, provider, model FROM boss_model_routes WHERE enabled = true ORDER BY priority ASC`);
    for (const r of rows) { const k = `${r.tenant_id}::${r.label}`; if (!map.has(k)) map.set(k, { model: r.model, provider: r.provider ?? undefined }); }
  } catch { /* table may not exist yet */ }
  routeCache = { at: Date.now(), map };
  return map;
}

export async function resolveModel(tenantId: string, modelOrLabel: string): Promise<ResolvedModel> {
  const raw = (modelOrLabel || '').trim();
  if (!raw) return { model: raw };
  const label = raw.replace(/^@/, '');
  const t = currentTenantId(tenantId);
  const routes = await loadRoutes();
  const hit = routes.get(`${t}::${label}`) ?? routes.get(`::${label}`);
  if (hit) return hit;
  // pass-through — derive provider the same way the scheduler does
  return { model: raw, provider: raw.includes('/') ? 'openrouter' : undefined };
}

export interface BudgetStatus {
  period: string;
  cap_usd: number | null;
  spent_usd: number;
  pct: number | null;
  status: 'no_budget' | 'ok' | 'warn' | 'over';
  alert_pct: number;
  hard_stop: boolean;
}

function periodStartSql(period: string): string {
  return period === 'daily' ? `date_trunc('day', now())` : `date_trunc('month', now())`;
}

export async function budgetStatus(tenantId: string): Promise<BudgetStatus> {
  const pool = getPool();
  const t = currentTenantId(tenantId);
  let cap: number | null = null, alert = 80, hard = false, period = 'monthly';
  try {
    const { rows } = await pool.query<{ period: string; cap_usd: string; alert_pct: number; hard_stop: boolean }>(
      `SELECT period, cap_usd, alert_pct, hard_stop FROM boss_budgets WHERE tenant_id=$1 ORDER BY (period='monthly') DESC LIMIT 1`, [t]);
    if (rows[0]) { period = rows[0].period; cap = Number(rows[0].cap_usd); alert = rows[0].alert_pct; hard = rows[0].hard_stop; }
  } catch { /* no table */ }
  let spent = 0;
  try {
    const { rows } = await pool.query<{ s: string }>(
      `SELECT coalesce(sum(cost_usd),0) s FROM boss_agent_runs WHERE started_at >= ${periodStartSql(period)}`);
    spent = Number(rows[0]?.s ?? 0);
  } catch { /* no table */ }
  if (cap == null) return { period, cap_usd: null, spent_usd: spent, pct: null, status: 'no_budget', alert_pct: alert, hard_stop: hard };
  const pct = cap > 0 ? Math.round((spent / cap) * 100) : 0;
  const status: BudgetStatus['status'] = pct >= 100 ? 'over' : pct >= alert ? 'warn' : 'ok';
  return { period, cap_usd: cap, spent_usd: spent, pct, status, alert_pct: alert, hard_stop: hard };
}

export async function isHardOverBudget(tenantId: string): Promise<boolean> {
  const b = await budgetStatus(tenantId);
  return b.status === 'over' && b.hard_stop;
}

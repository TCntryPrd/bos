/**
 * sentinel.ts — proactive Chief-of-Staff intelligence (Fusion P3).
 *
 * Pure aggregation over the existing control plane: what needs the principal's
 * attention right now (priorities) and a narrative Daily Brief. Used by both the
 * /api/life routes (live, for the tile) and the boss_scan_urgent / boss_daily_brief
 * tools (so the CoS + the Proactive Sentinel agent can push it). Every query degrades
 * gracefully if a table is absent.
 */
import { getPool } from '../db.js';
import { currentTenantId } from './tenant.js';

export interface Priority {
  kind: string;
  label: string;
  count?: number;
  severity: 'high' | 'medium' | 'low';
  route?: string;
}

export interface Brief {
  date: string;
  greeting: string;
  headline: string;
  priorities: Priority[];
  sections: { label: string; items: string[] }[];
}

async function num(sql: string, params: unknown[] = []): Promise<number> {
  try { const { rows } = await getPool().query<{ n: string }>(sql, params); return Number(rows[0]?.n ?? 0); } catch { return 0; }
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  try { const { rows } = await getPool().query(sql, params); return (rows[0] as T) ?? null; } catch { return null; }
}

export async function computePriorities(tenantId: string): Promise<Priority[]> {
  const t = currentTenantId(tenantId);
  const out: Priority[] = [];
  const approvals = await num(`SELECT count(*) n FROM boss_approvals WHERE tenant_id=$1 AND status='pending'`, [t]);
  if (approvals) out.push({ kind: 'approvals', label: `${approvals} action${approvals > 1 ? 's' : ''} need your OK`, count: approvals, severity: 'high', route: '/' });
  const incidents = await num(`SELECT count(*) n FROM boss_incidents WHERE status NOT IN ('resolved','escalated')`);
  if (incidents) out.push({ kind: 'incidents', label: `${incidents} open incident${incidents > 1 ? 's' : ''} self-healing`, count: incidents, severity: 'high' });
  const stalled = await num(`SELECT count(*) n FROM boss_tasks WHERE status='failed'`);
  if (stalled) out.push({ kind: 'tasks_stalled', label: `${stalled} stalled task${stalled > 1 ? 's' : ''} to review`, count: stalled, severity: 'medium', route: '/tasks' });
  const open = await num(`SELECT count(*) n FROM boss_tasks WHERE status='pending'`);
  if (open) out.push({ kind: 'tasks_open', label: `${open} task${open > 1 ? 's' : ''} in progress`, count: open, severity: 'low', route: '/tasks' });
  return out;
}

export async function composeBrief(tenantId: string): Promise<Brief> {
  const t = currentTenantId(tenantId);
  const priorities = await computePriorities(t);
  const sections: { label: string; items: string[] }[] = [];

  const fin = await one<{ snapshot: Record<string, unknown> }>(`SELECT snapshot FROM boss_finance_snapshot ORDER BY created_at DESC LIMIT 1`);
  const money: string[] = [];
  if (fin?.snapshot) {
    const s = fin.snapshot;
    const cash = Number(s.cash ?? s.cash_total ?? s.cash_on_hand ?? NaN);
    const rev = Number(s.revenue_mtd ?? s.mtd_revenue ?? s.revenue ?? NaN);
    if (Number.isFinite(cash)) money.push(`Cash on hand: $${Math.round(cash).toLocaleString()}`);
    if (Number.isFinite(rev)) money.push(`Revenue MTD: $${Math.round(rev).toLocaleString()}`);
  }
  if (money.length) sections.push({ label: 'Money', items: money });

  const rev = await one<{ overall_rating: number | null; total_reviews: number }>(`SELECT overall_rating, total_reviews FROM boss_reviews_snapshot ORDER BY created_at DESC LIMIT 1`);
  if (rev?.overall_rating != null) sections.push({ label: 'Reputation', items: [`${Number(rev.overall_rating).toFixed(1)}★ across ${rev.total_reviews} reviews`] });

  const highs = priorities.filter((p) => p.severity === 'high').length;
  const headline = priorities.length
    ? `${highs || priorities.length} thing${(highs || priorities.length) > 1 ? 's' : ''} want your attention`
    : `You're clear — nothing urgent right now.`;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return { date: new Date().toISOString().slice(0, 10), greeting, headline, priorities, sections };
}

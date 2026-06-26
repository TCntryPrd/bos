/**
 * Life routes — /api/life  (Fusion P3 — "Dashboard of Life")
 *
 * Aggregates the principal's life-domains into one Glance surface. Objective domains
 * (wealth/reputation/pipeline/projects/operations) are computed live from existing
 * snapshots; subjective domains (energy/focus) + any manual overrides come from
 * boss_life_metrics. Every domain degrades gracefully to a "not set up" hint so a
 * fresh install still renders the full structure.
 *
 *   GET  /api/life/overview        — { domains: [...], updated_at }
 *   POST /api/life/metric          — { domain, value?, display?, note?, trend? } (set subjective)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { currentTenantId } from '../lib/tenant.js';
import { composeBrief } from '../lib/sentinel.js';

type DomainStatus = 'good' | 'watch' | 'attention' | 'neutral';
interface LifeDomain {
  key: string; label: string; display: string;
  value: number | null; unit: string | null; trend: string | null;
  status: DomainStatus; source: string; hint?: string;
}
const money = (n: number): string => '$' + Math.round(n).toLocaleString();

export async function lifeRoutes(server: FastifyInstance): Promise<void> {
  server.get('/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = currentTenantId(request.auth?.tenantId);
    const pool = getPool();
    const domains: LifeDomain[] = [];
    const one = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      try { const { rows } = await pool.query(sql, params); return (rows[0] as T) ?? null; } catch { return null; }
    };

    // WEALTH — latest finance snapshot
    const fin = await one<{ snapshot: Record<string, unknown> }>(`SELECT snapshot FROM boss_finance_snapshot ORDER BY created_at DESC LIMIT 1`);
    if (fin?.snapshot) {
      const s = fin.snapshot;
      const cash = Number(s.cash ?? s.cash_total ?? s.cash_on_hand ?? NaN);
      const rev = Number(s.revenue_mtd ?? s.mtd_revenue ?? s.revenue ?? NaN);
      const display = Number.isFinite(cash) ? `${money(cash)} cash${Number.isFinite(rev) ? ` · ${money(rev)} MTD` : ''}` : (Number.isFinite(rev) ? `${money(rev)} MTD` : '—');
      domains.push({ key: 'wealth', label: 'Wealth', display, value: Number.isFinite(cash) ? cash : null, unit: '$', trend: null, status: Number.isFinite(cash) && cash < 0 ? 'attention' : 'good', source: 'computed' });
    } else {
      domains.push({ key: 'wealth', label: 'Wealth', display: 'Not set up', value: null, unit: '$', trend: null, status: 'neutral', source: 'computed', hint: 'Run the CFO agent to populate cash + revenue' });
    }

    // REPUTATION — CSAT
    const rv = await one<{ overall_rating: number | null; total_reviews: number }>(`SELECT overall_rating, total_reviews FROM boss_reviews_snapshot ORDER BY created_at DESC LIMIT 1`);
    if (rv?.overall_rating != null) {
      domains.push({ key: 'business', label: 'Reputation', display: `${Number(rv.overall_rating).toFixed(1)}★ (${rv.total_reviews})`, value: Number(rv.overall_rating), unit: 'x5', trend: null, status: Number(rv.overall_rating) >= 4 ? 'good' : 'watch', source: 'computed' });
    } else {
      domains.push({ key: 'business', label: 'Reputation', display: 'Not set up', value: null, unit: 'x5', trend: null, status: 'neutral', source: 'computed', hint: 'Connect reviews to populate' });
    }

    // PIPELINE — CRM
    const crm = await one<{ snapshot: Record<string, unknown> }>(`SELECT snapshot FROM boss_crm_snapshot ORDER BY created_at DESC LIMIT 1`);
    if (crm?.snapshot) {
      const c = crm.snapshot;
      const val = Number(c.pipeline_value ?? c.pipeline ?? c.open_value ?? NaN);
      const contacts = Number(c.contacts ?? c.total_contacts ?? NaN);
      const display = Number.isFinite(val) ? `${money(val)} pipeline` : (Number.isFinite(contacts) ? `${contacts} contacts` : '—');
      domains.push({ key: 'pipeline', label: 'Pipeline', display, value: Number.isFinite(val) ? val : null, unit: '$', trend: null, status: 'good', source: 'computed' });
    } else {
      domains.push({ key: 'pipeline', label: 'Pipeline', display: 'Not set up', value: null, unit: '$', trend: null, status: 'neutral', source: 'computed', hint: 'Connect CRM to populate' });
    }

    // PROJECTS — tasks (status-only; no schema assumptions)
    const tasks = await one<{ pending: string; failed: string }>(`SELECT count(*) FILTER (WHERE status='pending') AS pending, count(*) FILTER (WHERE status='failed') AS failed FROM boss_tasks`);
    if (tasks) {
      const pending = Number(tasks.pending); const failed = Number(tasks.failed);
      domains.push({ key: 'projects', label: 'Projects', display: `${pending} open${failed > 0 ? ` · ${failed} stalled` : ' · on track'}`, value: pending, unit: 'count', trend: null, status: failed > 0 ? 'watch' : 'good', source: 'computed' });
    }

    // OPERATIONS — agent reliability 24h
    const ops = await one<{ total: string; ok: string }>(`SELECT count(*) AS total, count(*) FILTER (WHERE status NOT IN ('error','failed','timeout')) AS ok FROM boss_agent_runs WHERE started_at > now() - interval '24 hours'`);
    if (ops && Number(ops.total) > 0) {
      const pct = Math.round((Number(ops.ok) / Number(ops.total)) * 100);
      domains.push({ key: 'operations', label: 'Operations', display: `${pct}% agents OK (24h)`, value: pct, unit: '%', trend: null, status: pct >= 90 ? 'good' : pct >= 70 ? 'watch' : 'attention', source: 'computed' });
    } else {
      domains.push({ key: 'operations', label: 'Operations', display: 'Idle', value: null, unit: '%', trend: null, status: 'neutral', source: 'computed', hint: 'No agent runs in the last 24h' });
    }

    // SUBJECTIVE + manual overrides
    const manual = await pool.query<{ domain: string; label: string; value: number | null; display: string | null; trend: string | null }>(
      `SELECT domain,label,value,display,trend FROM boss_life_metrics WHERE tenant_id=$1`, [tenantId]).then(r => r.rows).catch(() => []);
    const manualMap = new Map(manual.map(m => [m.domain, m]));
    for (const subj of [{ key: 'energy', label: 'Energy' }, { key: 'focus', label: 'Focus' }]) {
      const m = manualMap.get(subj.key);
      if (m) {
        const v = m.value ?? 5;
        domains.push({ key: subj.key, label: m.label || subj.label, display: m.display ?? (m.value != null ? `${m.value}/10` : '—'), value: m.value, unit: 'x10', trend: m.trend, status: v >= 7 ? 'good' : v >= 4 ? 'watch' : 'attention', source: 'manual' });
      } else {
        domains.push({ key: subj.key, label: subj.label, display: 'Tap to set', value: null, unit: 'x10', trend: null, status: 'neutral', source: 'manual', hint: 'Set how you feel — your Chief of Staff factors it in' });
      }
    }
    // computed-domain overrides from manual rows
    for (const d of domains) {
      const m = manualMap.get(d.key);
      if (m && d.source === 'computed') { if (m.display) d.display = m.display; if (m.value != null) d.value = m.value; d.source = 'manual'; }
    }

    return reply.send({ domains, updated_at: new Date().toISOString() });
  });

  // Integration Health — which connected apps are live (from the OAuth store)
  server.get('/integrations', async (_request: FastifyRequest, reply: FastifyReply) => {
    const PROVIDERS = [
      { id: 'google', label: 'Google Workspace' },
      { id: 'microsoft', label: 'Microsoft 365' },
      { id: 'slack', label: 'Slack' },
      { id: 'linkedin', label: 'LinkedIn' },
      { id: 'meta', label: 'Meta' },
    ];
    const rows = await getPool().query<{ provider: string; n: string; any_fresh: boolean }>(
      `SELECT provider, count(*) n, bool_or(expires_at IS NULL OR expires_at > now()) any_fresh
       FROM boss_oauth_tokens GROUP BY provider`).then((r) => r.rows).catch(() => []);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const integrations = PROVIDERS.map((p) => {
      const r = byProvider.get(p.id);
      if (!r) return { id: p.id, label: p.label, status: 'disconnected', detail: 'Not connected' };
      const n = Number(r.n);
      return {
        id: p.id, label: p.label,
        status: r.any_fresh ? 'connected' : 'expired',
        detail: `${n} account${n > 1 ? 's' : ''}${r.any_fresh ? '' : ' — needs reconnect'}`,
      };
    });
    const connected = integrations.filter((i) => i.status === 'connected').length;
    return reply.send({ integrations, connected, total: PROVIDERS.length });
  });

  // Proactive Daily Brief — composed live from the control plane
  server.get('/brief', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = currentTenantId(request.auth?.tenantId);
    const brief = await composeBrief(tenantId);
    return reply.send(brief);
  });

  server.post('/metric', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = currentTenantId(request.auth?.tenantId);
    const b = (request.body ?? {}) as { domain?: string; label?: string; value?: number; display?: string; note?: string; trend?: string };
    if (!b.domain) return reply.status(400).send({ error: 'domain required' });
    await getPool().query(
      `INSERT INTO boss_life_metrics (tenant_id,domain,label,value,display,note,trend,source,as_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',now())
       ON CONFLICT (tenant_id,domain) DO UPDATE SET label=EXCLUDED.label, value=EXCLUDED.value, display=EXCLUDED.display,
         note=EXCLUDED.note, trend=EXCLUDED.trend, source='manual', as_of=now(), updated_at=now()`,
      [tenantId, b.domain, b.label ?? b.domain, b.value ?? null, b.display ?? null, b.note ?? null, b.trend ?? null]);
    return reply.send({ ok: true });
  });
}

export default lifeRoutes;

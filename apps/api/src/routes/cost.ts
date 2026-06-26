/**
 * Cost routes — /api/cost
 *
 * Unified backend tool/platform spend + open cost incidents, for the dashboard
 * and grounded Q&A. The CTO agent + COO read these to see spikes.
 *
 *   GET /api/cost/rollup?hours=24 — per-source cost + units + total
 *   GET /api/cost/incidents       — currently-open incidents (e.g. cost spikes)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getCostRollup, getOpenIncidents } from '../lib/cost-ledger.js';
import { budgetStatus } from '../lib/model-routes.js';
import { getPool } from '../db.js';
import { currentTenantId } from '../lib/tenant.js';

export async function costRoutes(server: FastifyInstance): Promise<void> {
  // Spend vs cap (Fusion P2 budget discipline)
  server.get('/budget', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await budgetStatus(currentTenantId(request.auth?.tenantId)));
  });

  // Set / update the spend cap
  server.post('/budget', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { cap_usd?: number; period?: string; alert_pct?: number; hard_stop?: boolean };
    if (typeof b.cap_usd !== 'number' || b.cap_usd < 0) return reply.status(400).send({ error: 'cap_usd (number) required' });
    const tenantId = currentTenantId(request.auth?.tenantId);
    const period = b.period === 'daily' ? 'daily' : 'monthly';
    await getPool().query(
      `INSERT INTO boss_budgets (tenant_id, period, cap_usd, alert_pct, hard_stop)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, period) DO UPDATE SET cap_usd=EXCLUDED.cap_usd, alert_pct=EXCLUDED.alert_pct, hard_stop=EXCLUDED.hard_stop, updated_at=now()`,
      [tenantId, period, b.cap_usd, b.alert_pct ?? 80, b.hard_stop ?? false]);
    return reply.send(await budgetStatus(tenantId));
  });


  server.get<{ Querystring: { hours?: string } }>(
    '/rollup',
    async (req: FastifyRequest<{ Querystring: { hours?: string } }>, reply: FastifyReply) => {
      const hours = Math.min(Math.max(Number(req.query?.hours ?? 24) || 24, 1), 24 * 30);
      const sources = await getCostRollup(hours);
      const total = Number(sources.reduce((a, b) => a + b.cost, 0).toFixed(4));
      return reply.send({ hours, total, sources });
    },
  );

  server.get('/incidents', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ incidents: await getOpenIncidents() });
  });
}

export default costRoutes;

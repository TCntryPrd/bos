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

export async function costRoutes(server: FastifyInstance): Promise<void> {
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

/**
 * Finance routes — /api/finance
 *
 * Serves the latest financial snapshot the CFO agent persisted (boss_finance_snapshot)
 * for the dashboard finance card + the COO.
 *
 *   GET /api/finance/snapshot — the most recent snapshot { ...figures, created_at }
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';

export async function financeRoutes(server: FastifyInstance): Promise<void> {
  server.get('/snapshot', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const { rows } = await pool.query<{ snapshot: Record<string, unknown>; created_at: string }>(
      `SELECT snapshot, created_at FROM boss_finance_snapshot ORDER BY created_at DESC LIMIT 1`,
    );
    if (rows.length === 0) {
      return reply.send({ snapshot: null, created_at: null });
    }
    return reply.send({ ...rows[0].snapshot, created_at: rows[0].created_at });
  });
}

export default financeRoutes;

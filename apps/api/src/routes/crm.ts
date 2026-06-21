/**
 * CRM routes — /api/crm
 *
 * Serves the latest CRM/sales snapshot the Sales agent persisted
 * (boss_crm_snapshot) for the dashboard CRM tiles + the COO.
 *
 *   GET /api/crm/snapshot — the most recent snapshot { ...metrics, created_at }
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';

export async function crmRoutes(server: FastifyInstance): Promise<void> {
  server.get('/snapshot', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const { rows } = await pool.query<{ snapshot: Record<string, unknown>; created_at: string }>(
      `SELECT snapshot, created_at FROM boss_crm_snapshot ORDER BY created_at DESC LIMIT 1`,
    );
    if (rows.length === 0) {
      return reply.send({ snapshot: null, created_at: null });
    }
    return reply.send({ ...rows[0].snapshot, created_at: rows[0].created_at });
  });
}

export default crmRoutes;

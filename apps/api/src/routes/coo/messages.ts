/**
 * GET /threads/:id/messages — load message history for a COO thread.
 *
 * Returns oldest-first (chat reading order) so the frontend appends
 * new turns without reversing. Limit 200 newest entries.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db.js';

export async function messagesRoutes(server: FastifyInstance) {
  server.get<{ Params: { id: string } }>(
    '/threads/:id/messages',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
      const { id } = req.params;
      const sess = await getPool().query(
        `SELECT id FROM boss_chat_sessions
          WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo'`,
        [id, tenantId],
      );
      if (sess.rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
      const { rows } = await getPool().query(
        `SELECT id, role, content, tokens_in, tokens_out, created_at
           FROM boss_chat_messages
          WHERE session_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [id],
      );
      // Reverse to chronological order (oldest first) for chat display
      rows.reverse();
      return reply.status(200).send(rows);
    },
  );
}

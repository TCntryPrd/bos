/**
 * Email draft ratings API (prefix /api/email-drafts) — backs the "Email Drafts"
 * tile where Kevin rates the agent's reply drafts 👍/👎 (+ note); those ratings
 * feed back to the agent via boss_email_draft_feedback so it learns.
 *   GET  /list        — recent drafts (unrated first)
 *   POST /:id/rate    — { rating: 1 | -1, note? }
 */
import type { FastifyInstance } from 'fastify';
import { listEmailDrafts, rateEmailDraft, ensureEmailDraftsTable } from '../lib/email-drafts.js';

export async function emailDraftsRoutes(server: FastifyInstance) {
  await ensureEmailDraftsTable().catch(() => {});

  server.get<{ Querystring: { limit?: string } }>('/list', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '25', 10) || 25, 100);
    return reply.send({ drafts: await listEmailDrafts({ limit, unratedFirst: true }) });
  });

  server.post<{ Params: { id: string }; Body: { rating?: number; note?: string } }>('/:id/rate', async (request, reply) => {
    const rating = Number(request.body?.rating);
    if (rating !== 1 && rating !== -1) return reply.status(400).send({ error: 'rating must be 1 (up) or -1 (down)' });
    try {
      await rateEmailDraft(request.params.id, rating, request.body?.note?.trim() || undefined);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, 'rate draft failed');
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}

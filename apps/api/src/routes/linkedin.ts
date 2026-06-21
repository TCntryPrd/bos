/**
 * LinkedIn API (prefix /api/linkedin) — backs the LinkedIn dashboard tile.
 *   GET  /status   — connection status (connected, email, expiry)
 *   GET  /posts    — recent posts published from BOS
 *   POST /post     — publish { text, link?, media?: { type, url?|dataBase64?, filename?, altText? } }
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getLinkedInStatus,
  publishLinkedInPost,
  listLinkedInPosts,
  ensureLinkedInPostsTable,
  deleteLinkedInPost,
  editLinkedInPost,
  type MediaInput,
} from '../lib/linkedin.js';

interface PostBody { text?: string; link?: string; media?: MediaInput; }

export async function linkedinRoutes(server: FastifyInstance) {
  await ensureLinkedInPostsTable().catch(() => {});

  server.get('/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await getLinkedInStatus());
  });

  server.get<{ Querystring: { limit?: string } }>('/posts', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '10', 10) || 10, 50);
    return reply.send({ posts: await listLinkedInPosts(limit) });
  });

  server.post<{ Body: PostBody }>(
    '/post',
    { bodyLimit: 50 * 1024 * 1024 }, // allow base64 image/document uploads
    async (request, reply) => {
      const text = (request.body?.text ?? '').trim();
      const link = request.body?.link?.trim() || undefined;
      const media = request.body?.media;
      if (!text && !media) return reply.status(400).send({ error: 'text is required' });
      try {
        const { postId } = await publishLinkedInPost(text, { link, media });
        return reply.send({ ok: true, postId });
      } catch (err) {
        request.log.error({ err }, 'LinkedIn post failed');
        return reply.status(502).send({ error: (err as Error).message });
      }
    },
  );

  // Delete a published post (LinkedIn + local row).
  server.delete<{ Params: { id: string } }>('/posts/:id', async (request, reply) => {
    try {
      await deleteLinkedInPost(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, 'LinkedIn delete failed');
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  // Edit a post's text (commentary only).
  server.patch<{ Params: { id: string }; Body: { text?: string } }>('/posts/:id', async (request, reply) => {
    const text = (request.body?.text ?? '').trim();
    if (!text) return reply.status(400).send({ error: 'text is required' });
    try {
      await editLinkedInPost(request.params.id, text);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, 'LinkedIn edit failed');
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
}

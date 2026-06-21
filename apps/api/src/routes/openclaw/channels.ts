import type { FastifyInstance } from 'fastify';

export async function channelsRoute(server: FastifyInstance): Promise<void> {
  server.get('/api/openclaw/channels', async (_request, reply) => {
    return reply.send({ channels: [], providers: [{ id: 'codex-cli', mode: 'local' }] });
  });
}

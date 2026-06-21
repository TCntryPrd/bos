import type { FastifyInstance } from 'fastify';

export async function modelsRoute(server: FastifyInstance): Promise<void> {
  server.get('/api/openclaw/models', async (_request, reply) => {
    return reply.send({ providers: [{ id: 'codex', models: [{ key: 'codex-cli', name: 'Codex CLI' }] }] });
  });
}

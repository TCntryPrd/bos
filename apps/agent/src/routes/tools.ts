import type { FastifyInstance } from 'fastify';

export async function setupToolRoutes(server: FastifyInstance): Promise<void> {
  server.get('/tools/list', async () => ({
    status: 'ready',
    mode: 'host-native',
  }));
}

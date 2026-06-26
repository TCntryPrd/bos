import type { FastifyInstance } from 'fastify';

export async function setupAgentRoutes(server: FastifyInstance): Promise<void> {
  server.get('/agents/status', async () => ({
    status: 'ready',
    mode: 'host-native',
  }));
}

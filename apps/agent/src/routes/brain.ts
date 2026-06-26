/**
 * Brain routes for the host-native agent.
 * Proxied from the Docker web API.
 *
 * This is a thin wrapper — the actual brain logic is imported from
 * the existing @boss/brain package. The difference is that tool
 * execution happens natively on the host.
 */

import type { FastifyInstance } from 'fastify';

export async function setupBrainRoutes(server: FastifyInstance): Promise<void> {
  // Placeholder — will wire up the brain chat/stream endpoints
  server.get('/brain/status', async () => ({
    status: 'ready',
    mode: 'host-native',
  }));
}

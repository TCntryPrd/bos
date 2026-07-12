/**
 * Google admin routes — /api/google
 *
 * The Google Manager (steward) read surface: the API registry (key↔project↔API
 * map) and metered-call usage/cost. Feeds the dashboard + grounded Q&A.
 *
 *   GET /api/google/registry — full registry rows
 *   GET /api/google/usage    — usage rollup (today, last 30d, est cost)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getRegistry, getUsageRollup } from '../lib/google-registry.js';

export async function googleAdminRoutes(server: FastifyInstance): Promise<void> {
  server.get('/registry', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ registry: await getRegistry() });
  });
  server.get('/usage', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await getUsageRollup());
  });
}

export default googleAdminRoutes;

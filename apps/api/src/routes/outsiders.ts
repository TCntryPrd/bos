/**
 * outsiders.ts — HTTP routes for the boss_outsiders registry.
 *
 * CRUD: GET/POST/PATCH/DELETE on /api/agents/outsiders[/:handle]
 *
 * Mirrors rascals.ts shape minus the import-presets endpoint (outsiders
 * are seeded via migration 022 and grow through POST).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  listOutsiders,
  getOutsider,
  createOutsider,
  updateOutsider,
  deleteOutsider,
  type OutsiderCli,
} from '../agents/outsiders-repo.js';

function tenantOf(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

type CreateBody = {
  handle: string;
  displayName: string;
  cli: OutsiderCli;
  client: string;
  projectDir: string;
  model?: string;
  enabled?: boolean;
};

type PatchBody = Partial<Omit<CreateBody, 'handle'>>;

export async function outsidersRoutes(server: FastifyInstance) {
  server.get<{ Querystring: { enabled?: string; handle?: string } }>(
    '/agents/outsiders',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const enabledOnly = request.query.enabled === 'true';
      if (request.query.handle) {
        const one = await getOutsider(tenantId, request.query.handle);
        return reply.send({ outsiders: one ? [one] : [] });
      }
      const outsiders = await listOutsiders(tenantId, { enabledOnly });
      return reply.send({ outsiders });
    },
  );

  server.post<{ Body: CreateBody }>(
    '/agents/outsiders',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      try {
        const input = {
          handle: request.body.handle,
          displayName: request.body.displayName,
          cli: request.body.cli,
          client: request.body.client,
          projectDir: request.body.projectDir,
        };
        let created = await createOutsider(tenantId, input);
        const followUp: { model?: string; enabled?: boolean } = {};
        if (typeof request.body.model === 'string' && request.body.model.length > 0) {
          followUp.model = request.body.model;
        }
        if (request.body.enabled === true) {
          followUp.enabled = true;
        }
        if (Object.keys(followUp).length > 0) {
          created = (await updateOutsider(tenantId, input.handle, followUp)) ?? created;
        }
        return reply.status(201).send(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(msg)) {
          return reply.status(409).send({ error: 'conflict', message: msg });
        }
        if (/invalid handle/i.test(msg)) {
          return reply.status(400).send({ error: 'bad_request', message: msg });
        }
        throw err;
      }
    },
  );

  server.patch<{ Params: { handle: string }; Body: PatchBody }>(
    '/agents/outsiders/:handle',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const updated = await updateOutsider(tenantId, request.params.handle, request.body);
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return reply.send(updated);
    },
  );

  server.delete<{ Params: { handle: string } }>(
    '/agents/outsiders/:handle',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const ok = await deleteOutsider(tenantId, request.params.handle);
      if (!ok) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    },
  );
}

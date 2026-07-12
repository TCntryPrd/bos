import type { FastifyInstance } from 'fastify';

export async function skillsRoute(server: FastifyInstance): Promise<void> {
  server.get('/api/openclaw/skills', async (_request, reply) => {
    return reply.send({ workspaceDir: process.env.BOSS_GIO_WORKSPACE ?? '/home/tcntryprd/outsiders/gio', skills: [] });
  });

  server.get<{ Params: { id: string } }>('/api/openclaw/skills/:id', async (request, reply) => {
    return reply.status(404).send({ error: 'skill-not-found', id: request.params.id });
  });
}

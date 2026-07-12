import type { FastifyInstance } from 'fastify';

const VALID_ACTIONS = new Set(['restart', 'reindex-memory', 'backup', 'set-model', 'open-ui']);

export async function controlRoute(server: FastifyInstance): Promise<void> {
  server.post<{ Params: { action: string } }>('/api/openclaw/control/:action', async (request, reply) => {
    const action = request.params.action;
    if (!VALID_ACTIONS.has(action)) {
      return reply.status(400).send({ error: 'unknown-action', action });
    }
    return reply.status(410).send({
      ok: false,
      action,
      error: 'openclaw-removed',
      message: 'OpenClaw has been removed. Gio chat now runs through Codex CLI.',
    });
  });
}

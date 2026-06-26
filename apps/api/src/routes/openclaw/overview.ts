import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getRuntimeConfig } from '../../config-store.js';

const GIO_WORKSPACE = process.env.BOSS_GIO_WORKSPACE ?? '/home/boss/outsiders/gio';

export async function overviewRoute(server: FastifyInstance): Promise<void> {
  server.get('/api/openclaw/overview', async (request, reply) => {
    let memoryReady = false;
    try {
      await fs.access(path.join(GIO_WORKSPACE, 'MEMORY.md'));
      memoryReady = true;
    } catch {
      memoryReady = false;
    }

    const [codexStatus, codexCheckedAt, codexExitCode, codexStderrTail] = await Promise.all([
      getRuntimeConfig('CODEX_CLI_STATUS', request.tenant?.tenantId ?? 'default'),
      getRuntimeConfig('CODEX_CLI_LAST_CHECK_AT', request.tenant?.tenantId ?? 'default'),
      getRuntimeConfig('CODEX_CLI_EXIT_CODE', request.tenant?.tenantId ?? 'default'),
      getRuntimeConfig('CODEX_CLI_STDERR_TAIL', request.tenant?.tenantId ?? 'default'),
    ]);

    return reply.send({
      gateway: 'live',
      agent: { id: 'gio', model: process.env.CODEX_MODEL ?? 'codex-cli' },
      channels: [],
      memoryReady,
      codexCli: {
        status: codexStatus ?? 'unknown',
        lastCheckedAt: codexCheckedAt,
        exitCode: codexExitCode,
      },
      lastHeartbeatAt: new Date().toISOString(),
      errors: codexStatus === 'error' && codexStderrTail ? [codexStderrTail] : [],
    });
  });
}

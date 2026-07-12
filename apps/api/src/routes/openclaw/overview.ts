import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getRuntimeConfig } from '../../config-store.js';

const GIO_WORKSPACE = process.env.BOSS_GIO_WORKSPACE ?? '/home/tcntryprd/outsiders/gio';

export async function overviewRoute(server: FastifyInstance): Promise<void> {
  server.get('/api/openclaw/overview', async (request, reply) => {
    let memoryReady = false;
    try {
      await fs.access(path.join(GIO_WORKSPACE, 'MEMORY.md'));
      memoryReady = true;
    } catch {
      memoryReady = false;
    }

    const tenantId = request.tenant?.tenantId ?? 'default';
    const readCodexConfig = async (key: string): Promise<string | null> => {
      const tenantValue = await getRuntimeConfig(key, tenantId);
      if (tenantValue !== null || tenantId === 'default') return tenantValue;
      return getRuntimeConfig(key, 'default');
    };

    const [codexStatus, codexCheckedAt, codexExitCode, codexStderrTail] = await Promise.all([
      readCodexConfig('CODEX_CLI_STATUS'),
      readCodexConfig('CODEX_CLI_LAST_CHECK_AT'),
      readCodexConfig('CODEX_CLI_EXIT_CODE'),
      readCodexConfig('CODEX_CLI_STDERR_TAIL'),
    ]);

    const gateway = codexStatus === 'ready' ? 'live' : 'down';

    return reply.send({
      gateway,
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

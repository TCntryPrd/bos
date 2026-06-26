/**
 * BOS Agent — Host-Native Process
 *
 * This runs directly on the host machine (NOT in Docker). It has:
 *   - Direct filesystem access (no /data/home mapping needed)
 *   - Direct shell execution (bash, git, docker, etc.)
 *   - Direct network access (no container networking)
 *   - Full system control
 *
 * The web UI (in Docker) connects to this agent via HTTP on a local port.
 * This is the brain. The web UI is just a window.
 *
 * Architecture:
 *   [Web UI (Docker)] → HTTP → [This Agent (Host)] → [Claude API]
 *                                    ↓
 *                              [Postgres (Docker)]
 *                              [Shell / Git / Docker]
 *                              [Filesystem]
 *                              [Google APIs / etc]
 */

import Fastify from 'fastify';
import { setupBrainRoutes } from './routes/brain.js';
import { setupToolRoutes } from './routes/tools.js';
import { setupAgentRoutes } from './routes/agents.js';
import { initDb } from './db.js';
import { startEmailTriage } from './agents/email-triage.js';
import { loadRuntimeConfig } from './config.js';

const PORT = parseInt(process.env.BOSS_AGENT_PORT || '8010', 10);
const HOST = '127.0.0.1'; // Local only — web UI proxy handles external access

async function main() {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      },
    },
  });

  // CORS for local web UI proxy
  server.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') {
      reply.status(204).send();
    }
  });

  // Initialize
  await initDb();
  await loadRuntimeConfig();

  // Health check
  server.get('/health', async () => ({
    status: 'ok',
    mode: 'host-native',
    pid: process.pid,
    uptime: process.uptime(),
    cwd: process.cwd(),
    user: process.env.USER,
  }));

  // Register route modules
  await setupBrainRoutes(server);
  await setupToolRoutes(server);
  await setupAgentRoutes(server);

  // Start
  await server.listen({ port: PORT, host: HOST });
  server.log.info(`BOS Agent (host-native) running on ${HOST}:${PORT}`);
  server.log.info(`PID: ${process.pid} | User: ${process.env.USER} | CWD: ${process.cwd()}`);

  // Start background agents
  startEmailTriage();

  // Graceful shutdown
  const shutdown = () => {
    server.log.info('Shutting down...');
    void server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

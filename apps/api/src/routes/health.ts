import type { FastifyInstance } from 'fastify';
import type { SystemHealth, HealthCheckResult, HealthStatus } from '@boss/core';
import { oauthClientConfigs } from './connectors.js';
import { getPool } from '../db.js';

export async function healthRoutes(server: FastifyInstance) {
  // Basic liveness probe — no auth required
  server.get('/', async () => {
    return {
      status: 'ok',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    };
  });

  // WS-1/WS-3/WS-6: readiness probe — DB reachable AND schema migrated.
  // Used by compose/installer health gates; refuses traffic until the
  // migration ledger shows the baseline applied (schema-version guard).
  server.get('/ready', async (_request, reply) => {
    try {
      await getPool().query('SELECT 1');
    } catch (err) {
      return reply.status(503).send({ status: 'not-ready', db: 'unreachable', reason: (err as Error).message });
    }
    try {
      const { rows } = await getPool().query(
        "SELECT 1 FROM _bos_migrate_log WHERE id = '000_baseline' LIMIT 1",
      );
      if (rows.length === 0) {
        return reply.status(503).send({ status: 'not-ready', db: 'ok', schema: 'unmigrated' });
      }
    } catch {
      // _bos_migrate_log table missing => migrations never ran
      return reply.status(503).send({ status: 'not-ready', db: 'ok', schema: 'no-ledger' });
    }
    return { status: 'ready', db: 'ok', schema: 'ok', timestamp: new Date().toISOString() };
  });

  // Detailed health check — no auth required
  server.get('/full', async (_request, reply) => {
    // Only include connector health entries for providers that have been
    // configured. Unconfigured providers are omitted entirely so they don't
    // drag overall health to 'degraded' before the user sets them up.
    const connectorServices: HealthCheckResult[] = [];
    if (oauthClientConfigs.has('microsoft')) {
      connectorServices.push(await checkService('connector-microsoft'));
    }
    if (oauthClientConfigs.has('google')) {
      connectorServices.push(await checkService('connector-google'));
    }

    const services: HealthCheckResult[] = [
      await checkService('postgres'),
      await checkService('redis'),
      await checkService('weaviate'),
      await checkService('brain'),
      ...connectorServices,
      await checkService('voice'),
      await checkService('backup'),
    ];

    const overall: HealthStatus = services.every(s => s.status === 'healthy')
      ? 'healthy'
      : services.some(s => s.status === 'unhealthy')
        ? 'unhealthy'
        : 'degraded';

    const health: SystemHealth = {
      overall,
      services,
      checkedAt: new Date(),
    };

    const statusCode = overall === 'healthy' ? 200 : 503;
    return reply.status(statusCode).send(health);
  });
}

async function checkService(
  service: HealthCheckResult['service']
): Promise<HealthCheckResult> {
  // Placeholder — each service will implement its own health check
  return {
    service,
    status: 'unknown',
    message: 'Health check not yet implemented',
    checkedAt: new Date(),
  };
}

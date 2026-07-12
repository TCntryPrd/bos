import type { FastifyInstance } from 'fastify';
import type { SystemHealth, HealthCheckResult, HealthStatus } from '@boss/core';
import { oauthClientConfigs } from './connectors.js';

export async function healthRoutes(server: FastifyInstance) {
  // Basic liveness probe — no auth required
  server.get('/', async () => {
    return {
      status: 'ok',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    };
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

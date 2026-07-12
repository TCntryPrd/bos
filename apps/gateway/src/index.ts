import { buildGateway } from './server.js';

const port = parseInt(process.env.BOSS_GATEWAY_PORT ?? '65138', 10);
const host = '127.0.0.1';

const server = await buildGateway();

try {
  await server.listen({ port, host });
  server.log.info(`BOS Gateway listening on http://${host}:${port}`);
} catch (err) {
  server.log.error(err, 'failed to start BOS Gateway');
  process.exit(1);
}

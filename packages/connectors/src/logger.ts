import pino from 'pino';

export const logger = pino({
  name: 'boss-connectors',
  level: process.env.LOG_LEVEL ?? 'info',
});

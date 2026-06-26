import type { FastifyInstance } from 'fastify';
import { overviewRoute } from './overview.js';
import { channelsRoute } from './channels.js';
import { modelsRoute } from './models.js';
import { skillsRoute } from './skills.js';
import { memoryRoute } from './memory.js';
import { chatRoute } from './chat.js';
import { controlRoute } from './control.js';

export async function openclawRoutes(server: FastifyInstance): Promise<void> {
  await server.register(overviewRoute);
  await server.register(channelsRoute);
  await server.register(modelsRoute);
  await server.register(skillsRoute);
  await server.register(memoryRoute);
  await server.register(chatRoute);
  await server.register(controlRoute);
}

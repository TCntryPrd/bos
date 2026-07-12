/**
 * COO surface — /api/coo/*
 *
 * Aggregator that registers all child routes for the /coo page:
 * workspaces (dropdown source), threads (CRUD), messages (history),
 * chat (SSE streaming).
 *
 * Each thread is one resumable Claude Code subprocess scoped to a
 * per-thread workspace dir, with bypass mode on (Kevin authorization).
 */
import type { FastifyInstance } from 'fastify';
import { workspacesRoutes } from './workspaces.js';
import { threadsRoutes } from './threads.js';
import { messagesRoutes } from './messages.js';
import { chatRoutes } from './chat.js';

export async function cooRoutes(server: FastifyInstance) {
  await server.register(workspacesRoutes);
  await server.register(threadsRoutes);
  await server.register(messagesRoutes);
  await server.register(chatRoutes);
}

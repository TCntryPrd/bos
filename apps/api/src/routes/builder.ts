/**
 * Builder-mode console routes — read-only view of live agent CLI streams.
 *
 * Every route 404s unless BOSS_BUILDER_MODE=1, so non-builder installs
 * expose nothing (not even the route's existence). Deliberately no input
 * path: this surface physically cannot write to an agent process.
 *
 * Auth: standard JWT middleware applies (/api/builder is not public).
 */
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { builderEnabled, builderRedisUrl } from '../lib/builder-stream.js';

let reader: Redis | null = null;
function client(): Redis {
  reader ??= new Redis(builderRedisUrl(), { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
  return reader;
}

interface SessionMeta {
  label: string;
  status: 'live' | 'finished' | 'error';
  updatedAt: number;
}

export async function builderRoutes(server: FastifyInstance): Promise<void> {
  server.addHook('onRequest', async (_req, reply) => {
    if (!builderEnabled()) {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // List known sessions, newest first.
  server.get('/sessions', async () => {
    let all: Record<string, string> = {};
    try {
      all = await client().hgetall('builder:sessions');
    } catch {
      return { sessions: [], redis: 'unavailable' };
    }
    const sessions = Object.entries(all)
      .map(([id, raw]) => {
        try {
          return { id, ...(JSON.parse(raw) as SessionMeta) };
        } catch {
          return null;
        }
      })
      .filter((s): s is { id: string } & SessionMeta => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100);
    return { sessions };
  });

  // SSE: replay the ring buffer, then follow live via pub/sub.
  server.get('/stream/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id)) {
      return reply.code(400).send({ error: 'bad session id' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': builder stream\n\n');

    // Subscribe BEFORE replay so no line falls between LRANGE and SUBSCRIBE
    // (duplicates across the boundary are acceptable; gaps are not).
    const sub = new Redis(builderRedisUrl(), { maxRetriesPerRequest: 1, lazyConnect: true });
    const pending: string[] = [];
    let replayDone = false;
    sub.on('message', (_ch: string, msg: string) => {
      if (replayDone) {
        reply.raw.write(`data: ${msg}\n\n`);
      } else {
        pending.push(msg);
      }
    });

    try {
      await sub.subscribe(`builder:live:${id}`);
      const buf = await client().lrange(`builder:buf:${id}`, 0, -1);
      for (const rec of buf) reply.raw.write(`data: ${rec}\n\n`);
    } catch {
      reply.raw.write(`data: ${JSON.stringify({ ts: Date.now(), line: '[builder] redis unavailable', status: 'error' })}\n\n`);
    }
    replayDone = true;
    for (const msg of pending) reply.raw.write(`data: ${msg}\n\n`);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': hb\n\n'); } catch { /* closed */ }
    }, 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      sub.quit().catch(() => sub.disconnect());
    });

    // Fastify: the raw stream is ours now; never auto-serialize a body.
    return reply;
  });
}

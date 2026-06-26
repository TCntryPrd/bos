/**
 * Miro proxy routes — v1.7.15
 *
 * Server-side proxy for Miro REST API. Keeps the access token in env
 * (MIRO_ACCESS_TOKEN) instead of exposing it to the browser.
 *
 * Routes:
 *   GET  /api/miro/boards           — list boards
 *   GET  /api/miro/boards/:id       — get board details
 *   POST /api/miro/boards           — create a new board
 *   GET  /api/miro/boards/:id/items — list items on a board
 *   GET  /api/miro/health           — token + connectivity check
 *
 * Write tools (sticky/shape/connector) intentionally NOT exposed here —
 * agents drive the board via MCP/CLI. The web surface is for visual work.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const MIRO_API = 'https://api.miro.com/v2';

function miroHeaders(): Record<string, string> {
  const token = process.env.MIRO_ACCESS_TOKEN ?? '';
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function miroFetch<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const token = process.env.MIRO_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, status: 503, error: 'MIRO_ACCESS_TOKEN not configured' };
  }

  try {
    const res = await fetch(`${MIRO_API}${path}`, {
      ...init,
      headers: { ...miroHeaders(), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.substring(0, 500) };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
}

interface BoardListResponse {
  data: Array<{ id: string; name: string; description?: string; viewLink?: string; modifiedAt?: string; team?: { id: string; name: string } }>;
  total: number;
  size: number;
  offset?: number;
  limit?: number;
}

interface BoardDetailResponse {
  id: string;
  name: string;
  description?: string;
  viewLink?: string;
  modifiedAt?: string;
}

interface BoardItemsResponse {
  data: Array<{ id: string; type: string; data?: Record<string, unknown>; position?: { x: number; y: number }; modifiedAt?: string }>;
  total: number;
  cursor?: string;
}

export async function miroRoutes(server: FastifyInstance) {
  /**
   * GET /api/miro/health — confirms token validity
   */
  server.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await miroFetch<BoardListResponse>('/boards?limit=1');
    if (!result.ok) {
      return reply.status(503).send({ ok: false, error: result.error, status: result.status });
    }
    return reply.send({ ok: true, total_boards_visible: result.data?.total ?? 0 });
  });

  /**
   * GET /api/miro/boards — list boards
   * Query: limit (default 50), offset (default 0)
   */
  server.get('/boards', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 50);
    const offset = parseInt(q.offset ?? '0', 10);
    const result = await miroFetch<BoardListResponse>(`/boards?limit=${limit}&offset=${offset}&sort=last_modified`);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    return reply.send({
      boards: (result.data?.data ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        viewLink: b.viewLink,
        modifiedAt: b.modifiedAt,
        team: b.team?.name,
      })),
      total: result.data?.total ?? 0,
    });
  });

  /**
   * GET /api/miro/boards/:id — get a single board
   */
  server.get('/boards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const result = await miroFetch<BoardDetailResponse>(`/boards/${encodeURIComponent(id)}`);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    return reply.send(result.data);
  });

  /**
   * POST /api/miro/boards — create new board
   * Body: { name, description? }
   */
  server.post('/boards', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { name?: string; description?: string };
    if (!body.name) return reply.status(400).send({ error: 'name is required' });

    const result = await miroFetch<BoardDetailResponse>('/boards', {
      method: 'POST',
      body: JSON.stringify({
        name: body.name,
        description: body.description ?? '',
        policy: { permissionsPolicy: { collaborationToolsStartAccess: 'all_editors', copyAccess: 'team_members', sharingAccess: 'team_members_with_editing' } },
      }),
    });
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    return reply.status(201).send(result.data);
  });

  /**
   * GET /api/miro/boards/:id/items — list items on a board
   */
  server.get('/boards/:id/items', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { limit?: string; cursor?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 50);
    const cursor = q.cursor ? `&cursor=${encodeURIComponent(q.cursor)}` : '';
    const result = await miroFetch<BoardItemsResponse>(`/boards/${encodeURIComponent(id)}/items?limit=${limit}${cursor}`);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    return reply.send(result.data);
  });
}

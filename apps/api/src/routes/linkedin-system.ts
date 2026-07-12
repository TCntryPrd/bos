import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const serviceBase = () => (process.env.VASARI_UNIPILE_URL || 'http://vasari_unipile:8000').replace(/\/$/, '');
const publicBase = () => (process.env.PUBLIC_BASE_URL || 'http://localhost').replace(/\/$/, '');

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function serviceJson(path: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${serviceBase()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: parseJson(text) };
}

function sendServiceResult(reply: FastifyReply, result: { status: number; ok: boolean; body: unknown }) {
  if (result.ok) return reply.send(result.body);
  const message = typeof result.body === 'object' && result.body && 'detail' in result.body
    ? String((result.body as { detail?: unknown }).detail)
    : `LinkedIn system service returned ${result.status}`;
  return reply.status(result.status >= 400 ? result.status : 502).send({
    error: { code: 'LINKEDIN_SYSTEM', message },
  });
}

function gptActionKey(): string {
  return String(process.env.LINKEDIN_GPT_ACTION_KEY || process.env.BOSS_LINKEDIN_GPT_ACTION_KEY || '').trim();
}

function assertGptActionKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = gptActionKey();
  if (!expected) {
    void reply.status(503).send({
      error: { code: 'GPT_ACTION_DISABLED', message: 'LinkedIn GPT action key is not configured' },
    });
    return false;
  }
  const received = request.headers['x-gpt-action-key'];
  const key = Array.isArray(received) ? received[0] : received;
  if (key !== expected) {
    void reply.status(401).send({
      error: { code: 'GPT_ACTION_UNAUTHORIZED', message: 'Missing or invalid GPT action key' },
    });
    return false;
  }
  return true;
}

function actionFromOverview(body: unknown) {
  const overview = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const posts = Array.isArray(overview.posts) ? overview.posts.slice(0, 12) : [];
  return {
    instructions: [
      'Help Kevin create useful LinkedIn drafts that showcase real work without bragging or scare tactics.',
      'Use the Roast-or-Toast structure: strong hook, short lines, bullets for hidden costs, then a compact lesson.',
      'Make posts easy to skim. Prefer concrete bullets over dense paragraphs.',
      'Sort drafts into recurring series when possible: Build Breakdown, Consultant Toolkit, Client Delivery Mistakes, AI in the Trenches, or Workflow Clinic.',
      'Show the messy middle. Demonstrate judgment, not just finished systems or technical skill.',
      'Every draft should reinforce why consultants and clients can trust Kevin: he makes consultants look good, builds systems that last, documents the work, and leaves the client better than he found them.',
      'Use wins, losses, lessons, and source media as context.',
      'Do not approve, queue, or publish. Save revised drafts for human review in Vasari.',
    ],
    checked_at: overview.checked_at ?? null,
    account: overview.account ?? null,
    proof: overview.proof ?? null,
    pending_draft: overview.pending_draft ?? null,
    recent_posts: posts,
    post_accept_message: overview.post_accept_message ?? null,
  };
}

function linkedinGptOpenApi() {
  const server = publicBase();
  return {
    openapi: '3.1.0',
    info: {
      title: 'Vasari LinkedIn Agent GPT Bridge',
      version: '1.0.0',
      description: 'Read LinkedIn context and save reviewed LinkedIn post drafts for human approval in Vasari-BOS.',
    },
    servers: [{ url: server }],
    components: {
      securitySchemes: {
        GptActionKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-GPT-Action-Key',
        },
      },
      schemas: {
        Media: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['image', 'video', 'file'] },
            url: { type: 'string' },
            preview_url: { type: 'string' },
            file_name: { type: 'string' },
          },
        },
        SourcePost: {
          type: 'object',
          properties: {
            social_id: { type: 'string' },
            share_url: { type: 'string' },
            text: { type: 'string' },
            parsed_datetime: { type: 'string' },
            media: {
              type: 'array',
              items: { $ref: '#/components/schemas/Media' },
            },
          },
        },
        DraftInput: {
          type: 'object',
          required: ['text'],
          properties: {
            action_id: { type: 'integer', description: 'Existing draft action id to revise when available.' },
            draft_title: { type: 'string' },
            text: { type: 'string', maxLength: 3000 },
            approval_note: { type: 'string', maxLength: 500 },
            external_link: { type: 'string' },
            media: {
              type: 'array',
              items: { $ref: '#/components/schemas/Media' },
            },
            source_posts: {
              type: 'array',
              items: { $ref: '#/components/schemas/SourcePost' },
            },
          },
        },
      },
    },
    paths: {
      '/api/linkedin-system/gpt/context': {
        get: {
          operationId: 'getLinkedInReviewContext',
          summary: 'Get LinkedIn account, recent posts, media, proof, and pending draft context.',
          security: [{ GptActionKey: [] }],
          responses: {
            '200': { description: 'LinkedIn review context' },
          },
        },
      },
      '/api/linkedin-system/gpt/draft': {
        post: {
          operationId: 'saveLinkedInDraftForReview',
          summary: 'Save a LinkedIn draft for human approval in Vasari. Does not publish.',
          security: [{ GptActionKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DraftInput' },
              },
            },
          },
          responses: {
            '200': { description: 'Saved draft action' },
          },
        },
      },
    },
  };
}

export async function linkedinSystemRoutes(server: FastifyInstance): Promise<void> {
  server.get('/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return sendServiceResult(reply, await serviceJson('/views/linkedin'));
    } catch (err) {
      request.log.error({ err }, 'LinkedIn system overview failed');
      return reply.status(502).send({
        error: { code: 'LINKEDIN_SYSTEM', message: err instanceof Error ? err.message : 'LinkedIn system unavailable' },
      });
    }
  });

  server.post('/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return sendServiceResult(reply, await serviceJson('/tools/sync-linkedin', { method: 'POST', body: '{}' }));
    } catch (err) {
      request.log.error({ err }, 'LinkedIn system sync failed');
      return reply.status(502).send({
        error: { code: 'LINKEDIN_SYSTEM', message: err instanceof Error ? err.message : 'LinkedIn sync unavailable' },
      });
    }
  });

  server.post<{ Body: { message?: string; auto_send?: boolean } }>(
    '/post-accept-message',
    async (request, reply) => {
      try {
        return sendServiceResult(
          reply,
          await serviceJson('/tools/post-accept-message', {
            method: 'POST',
            body: JSON.stringify({
              message: request.body?.message ?? '',
              auto_send: Boolean(request.body?.auto_send),
            }),
          }),
        );
      } catch (err) {
        request.log.error({ err }, 'LinkedIn post-accept message update failed');
        return reply.status(502).send({
          error: { code: 'LINKEDIN_SYSTEM', message: err instanceof Error ? err.message : 'Message update unavailable' },
        });
      }
    },
  );

  server.post<{ Params: { id: string } }>('/actions/:id/approve', async (request, reply) => {
    try {
      return sendServiceResult(
        reply,
        await serviceJson(`/tools/actions/${encodeURIComponent(request.params.id)}/approve`, {
          method: 'POST',
          body: '{}',
        }),
      );
    } catch (err) {
      request.log.error({ err, actionId: request.params.id }, 'LinkedIn action approve failed');
      return reply.status(502).send({
        error: { code: 'LINKEDIN_SYSTEM', message: err instanceof Error ? err.message : 'Action approve unavailable' },
      });
    }
  });

  server.post<{ Params: { id: string } }>('/actions/:id/cancel', async (request, reply) => {
    try {
      return sendServiceResult(
        reply,
        await serviceJson(`/tools/actions/${encodeURIComponent(request.params.id)}/cancel`, {
          method: 'POST',
          body: '{}',
        }),
      );
    } catch (err) {
      request.log.error({ err, actionId: request.params.id }, 'LinkedIn action cancel failed');
      return reply.status(502).send({
        error: { code: 'LINKEDIN_SYSTEM', message: err instanceof Error ? err.message : 'Action cancel unavailable' },
      });
    }
  });

  server.get('/gpt/openapi.json', { config: { skipAuth: true } }, async (_request, reply) => {
    return reply.send(linkedinGptOpenApi());
  });

  server.get('/gpt/context', { config: { skipAuth: true } }, async (request, reply) => {
    if (!assertGptActionKey(request, reply)) return;
    try {
      const result = await serviceJson('/views/linkedin');
      if (!result.ok) return sendServiceResult(reply, result);
      return reply.send(actionFromOverview(result.body));
    } catch (err) {
      request.log.error({ err }, 'LinkedIn GPT context failed');
      return reply.status(502).send({
        error: { code: 'LINKEDIN_GPT_CONTEXT', message: err instanceof Error ? err.message : 'LinkedIn GPT context unavailable' },
      });
    }
  });

  server.post<{ Body: Record<string, unknown> }>(
    '/gpt/draft',
    { config: { skipAuth: true } },
    async (request, reply) => {
      if (!assertGptActionKey(request, reply)) return;
      try {
        return sendServiceResult(
          reply,
          await serviceJson('/tools/post-draft', {
            method: 'POST',
            body: JSON.stringify(request.body ?? {}),
          }),
        );
      } catch (err) {
        request.log.error({ err }, 'LinkedIn GPT draft save failed');
        return reply.status(502).send({
          error: { code: 'LINKEDIN_GPT_DRAFT', message: err instanceof Error ? err.message : 'LinkedIn GPT draft save unavailable' },
        });
      }
    },
  );
}

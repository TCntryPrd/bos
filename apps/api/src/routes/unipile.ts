import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createUnipileHostedAuthLink,
  getUnipileStatus,
  type UnipileProvider,
} from '../lib/unipile.js';

interface ConnectLinkBody {
  provider: UnipileProvider;
}

function getBaseUrl(request?: { headers: Record<string, unknown> }): string {
  if (request?.headers) {
    const xfHost = request.headers['x-forwarded-host'] ?? request.headers.host;
    const host = Array.isArray(xfHost) ? xfHost[0] : xfHost;
    if (host && typeof host === 'string' && !host.startsWith('localhost') && !host.startsWith('127.')) {
      const proto = (request.headers['x-forwarded-proto'] as string) || 'https';
      return `${String(proto).split(',')[0]}://${host}`;
    }
  }
  return process.env.API_BASE_URL ?? 'http://localhost:3000';
}

function normalizeProvider(value: unknown): UnipileProvider | null {
  // Unipile is LinkedIn-only. WhatsApp runs on the Baileys bridge (see routes/whatsapp.ts).
  return String(value ?? '').toUpperCase() === 'LINKEDIN' ? 'LINKEDIN' : null;
}

export async function unipileRoutes(server: FastifyInstance): Promise<void> {
  server.get('/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await getUnipileStatus());
    } catch (err) {
      _request.log.warn({ err }, 'Unipile status check failed');
      return reply.status(200).send({
        configured: true,
        checkedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Unipile status check failed',
        accounts: [],
      });
    }
  });

  server.post<{ Body: ConnectLinkBody }>(
    '/connect-link',
    {
      schema: {
        body: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', enum: ['LINKEDIN'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const provider = normalizeProvider(request.body.provider);
      if (!provider) return reply.status(400).send({ error: 'provider must be LINKEDIN' });

      const baseUrl = getBaseUrl(request);
      try {
        const link = await createUnipileHostedAuthLink(provider, {
          name: `vasari-bos-${provider.toLowerCase()}-${request.auth?.userId ?? 'admin'}`,
          successRedirectUrl: `${baseUrl}/settings`,
          failureRedirectUrl: `${baseUrl}/settings`,
          notifyUrl: `${baseUrl}/api/unipile/webhook`,
        });
        return reply.send({ provider, url: link.url });
      } catch (err) {
        request.log.error({ err, provider }, 'Unipile hosted auth link failed');
        return reply.status(502).send({ error: err instanceof Error ? err.message : 'Could not create Unipile link' });
      }
    },
  );

  server.post(
    '/webhook',
    { config: { skipAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      request.log.info({ body: request.body }, 'Unipile webhook received');
      return reply.send({ ok: true });
    },
  );
}

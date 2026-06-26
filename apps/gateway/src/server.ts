import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import {
  loadAnthropicAuthToken,
  loadGatewayToken,
  requireGatewayToken,
} from './auth.js';
import {
  buildAnthropicClient,
  proxyChatCompletion,
  ChatCompletionRequest,
} from './proxy.js';

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6', object: 'model' },
  { id: 'claude-opus-4-5', object: 'model' },
  { id: 'claude-sonnet-4-6', object: 'model' },
  { id: 'claude-sonnet-4-5', object: 'model' },
  { id: 'claude-haiku-4-5', object: 'model' },
];

export async function buildGateway(): Promise<FastifyInstance> {
  const gatewayToken = loadGatewayToken();
  const anthropicAuthToken = loadAnthropicAuthToken();
  const anthropicClient = buildAnthropicClient(anthropicAuthToken);

  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            }
          : undefined,
    },
  });

  await server.register(cors, {
    origin: false, // loopback-only; no browser cross-origin needed
  });

  // -------------------------------------------------------------------------
  // Auth preHandler factory — binds the loaded gateway token into the closure
  // -------------------------------------------------------------------------
  const checkAuth = async (
    request: Parameters<typeof requireGatewayToken>[0],
    reply: Parameters<typeof requireGatewayToken>[1],
  ) => requireGatewayToken(request, reply, gatewayToken);

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------
  server.get('/health', async (_request, _reply) => {
    return { status: 'ok', version: '2.0.0' };
  });

  // -------------------------------------------------------------------------
  // GET /v1/models
  // -------------------------------------------------------------------------
  server.get(
    '/v1/models',
    { preHandler: checkAuth },
    async (_request, _reply) => {
      return { object: 'list', data: AVAILABLE_MODELS };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/chat/completions
  // -------------------------------------------------------------------------
  server.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
    { preHandler: checkAuth },
    async (request, reply) => {
      const body = request.body;

      // Basic validation
      if (!body || !body.model) {
        return reply.status(400).send({ error: 'model is required' });
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return reply
          .status(400)
          .send({ error: 'messages array is required and must not be empty' });
      }

      request.log.info(
        {
          model: body.model,
          messageCount: body.messages.length,
          stream: body.stream ?? false,
          maxTokens: body.max_tokens ?? 8192,
        },
        'chat completion request',
      );

      try {
        const result = await proxyChatCompletion(anthropicClient, body);

        request.log.info(
          {
            id: result.id,
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            finishReason: result.choices[0]?.finish_reason,
          },
          'chat completion success',
        );

        return reply.status(200).send(result);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'unknown proxy error';
        const status = extractAnthropicStatus(err) ?? 502;

        request.log.error(
          { err, status },
          'anthropic proxy error',
        );

        return reply.status(status).send({
          error: {
            message,
            type: 'proxy_error',
            code: status,
          },
        });
      }
    },
  );

  return server;
}

/**
 * Attempts to pull an HTTP status code out of Anthropic SDK errors.
 * The SDK attaches a `status` property to APIError instances.
 */
function extractAnthropicStatus(err: unknown): number | null {
  if (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

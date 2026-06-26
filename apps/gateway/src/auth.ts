import { readFileSync } from 'fs';
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Loads the Anthropic OAuth subscription token.
 * Checks ANTHROPIC_AUTH_TOKEN env first, then falls back to a token file
 * at ANTHROPIC_TOKEN_FILE (defaults to ~/.boss/anthropic-token).
 */
export function loadAnthropicAuthToken(): string {
  const envToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const tokenFile =
    process.env.ANTHROPIC_TOKEN_FILE ||
    `${process.env.HOME || '/root'}/.boss/anthropic-token`;

  try {
    const fileToken = readFileSync(tokenFile, 'utf-8').trim();
    if (fileToken.length > 0) {
      return fileToken;
    }
  } catch {
    // file not found or unreadable — fall through
  }

  throw new Error(
    'Anthropic auth token not found. Set ANTHROPIC_AUTH_TOKEN env var or write the token to ' +
      (process.env.ANTHROPIC_TOKEN_FILE ||
        `${process.env.HOME || '/root'}/.boss/anthropic-token`),
  );
}

/**
 * Gateway token used to authenticate BOS → Gateway requests.
 * Read from BOSS_GATEWAY_TOKEN env.  Falls back to a hardcoded
 * development default so the server can start without config, but
 * logs a loud warning.
 */
export function loadGatewayToken(): string {
  const token = process.env.BOSS_GATEWAY_TOKEN;
  if (token && token.trim().length > 0) {
    return token.trim();
  }

  // Insecure default — only acceptable for local loopback dev use.
  console.warn(
    '[gateway/auth] WARNING: BOSS_GATEWAY_TOKEN not set. ' +
      'Using insecure default. Set this env var before production use.',
  );
  return 'boss-dev-gateway-token-insecure';
}

/**
 * Fastify preHandler that validates the incoming Bearer token against
 * the configured gateway token.
 */
export async function requireGatewayToken(
  request: FastifyRequest,
  reply: FastifyReply,
  gatewayToken: string,
): Promise<void> {
  const authHeader = request.headers['authorization'];
  if (!authHeader) {
    await reply.status(401).send({ error: 'missing Authorization header' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    await reply
      .status(401)
      .send({ error: 'Authorization header must use Bearer scheme' });
    return;
  }

  const providedToken = parts[1];
  if (providedToken !== gatewayToken) {
    await reply.status(403).send({ error: 'invalid gateway token' });
    return;
  }
}

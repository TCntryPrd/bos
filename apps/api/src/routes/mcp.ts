/**
 * MCP routes — /api/mcp/*
 *
 * Fills in the endpoints the Settings → Global MCP tab has always called but
 * which never existed server-side:
 *
 *   GET    /global                          — status + registered connections
 *   POST   /global/connections              — add a connection
 *   DELETE /global/connections/:id          — remove one
 *   POST   /global/connections/:id/login    — start the PKCE flow, return authorizeUrl
 *   GET    /global/callback                 — OAuth redirect target
 *
 * Plus the Managed Agent surface that replaces the n8n delegation path:
 *
 *   POST   /agent/run                       — run a task on the managed agent
 *   GET    /agent/runs                      — recent runs
 *
 * The login endpoint runs the PKCE dance server-side rather than handing the
 * browser the MCP URL directly: an OAuth-protected MCP endpoint answers a
 * browser with 401, which is exactly the dead end the UI comment describes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  discoverOAuth,
  exchangeCode,
  registerClient,
} from '../lib/mcp-oauth.js';
import {
  consumeOAuthState,
  createConnection,
  deleteConnection,
  getConnection,
  isAuthenticated,
  listConnections,
  saveDiscovery,
  saveOAuthState,
  saveTokens,
  seedFromEnv,
  type McpConnection,
  type McpTransport,
} from '../lib/mcp-registry.js';
import {
  listRuns,
  managedAgentsConfigured,
  runManagedAgentTask,
  syncMcpCredential,
} from '../lib/managed-agent.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TRANSPORTS: McpTransport[] = ['http', 'sse', 'stdio'];

function publicBaseUrl(): string {
  const raw = process.env.API_BASE_URL || process.env.BOS_PUBLIC_URL || 'http://localhost:8001';
  return raw.replace(/\/+$/, '');
}

function redirectUri(): string {
  return `${publicBaseUrl()}/api/mcp/global/callback`;
}

/** Shape a connection for the UI. Secrets never cross this boundary. */
function toPublicConnection(conn: McpConnection) {
  return {
    id: conn.id,
    name: conn.name,
    transport: conn.transport,
    serverUrl: conn.serverUrl ?? undefined,
    command: conn.command ?? undefined,
    args: conn.args ?? undefined,
    loginUrl: conn.loginUrl ?? undefined,
    authenticated: isAuthenticated(conn),
    loginMethod: conn.transport === 'stdio' ? undefined : ('oauth' as const),
    tokenEnv: conn.tokenEnv ?? undefined,
    configPath: conn.configPath ?? undefined,
    description: conn.description ?? undefined,
    enabled: conn.enabled,
    createdAt: conn.createdAt?.toISOString(),
    updatedAt: conn.updatedAt?.toISOString(),
  };
}

function htmlPage(title: string, body: string, ok: boolean): string {
  const accent = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;background:#0b0f14;color:#e6edf3;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{max-width:34rem;padding:2rem;border:1px solid #1f2937;border-radius:12px;background:#111820}
  h1{margin:0 0 .5rem;font-size:1.25rem;color:${accent}}
  p{margin:.5rem 0;color:#9aa7b4}
  code{background:#0b0f14;padding:.15rem .4rem;border-radius:4px;color:#e6edf3}
</style></head>
<body><div class="card"><h1>${title}</h1>${body}
<p>You can close this tab and return to BOS.</p></div></body></html>`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function mcpRoutes(server: FastifyInstance): Promise<void> {
  // ── Status ────────────────────────────────────────────────────────────────
  server.get('/global', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await seedFromEnv();
    } catch (err) {
      server.log.warn({ err }, 'MCP seed from env failed');
    }

    let connections: McpConnection[] = [];
    let errors: string[] = [];
    try {
      connections = await listConnections();
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    }

    const primary =
      connections.find((conn) => conn.name === 'mygentic') ??
      connections.find((conn) => conn.enabled && conn.serverUrl) ??
      null;

    return reply.send({
      id: 'global',
      name: 'Global MCP',
      scope: 'bos',
      configured: connections.length > 0,
      connected: connections.some(isAuthenticated),
      loginRequired: connections.some((conn) => conn.serverUrl && !isAuthenticated(conn)),
      authConfigured: managedAgentsConfigured(),
      serverUrl: primary?.serverUrl ?? null,
      loginUrl: primary ? `${publicBaseUrl()}/api/mcp/global/connections/${primary.id}/login` : null,
      configPath: 'postgres://boss_mcp_connections',
      configPresent: true,
      registryPath: 'boss_mcp_connections',
      registryPresent: true,
      codexHome: process.env.CODEX_HOME ?? '/home/boss/.codex',
      claudeHome: process.env.CLAUDE_HOME ?? '/home/boss/.claude',
      transport: primary?.transport ?? 'http',
      model: process.env.BOSS_MANAGED_AGENT_MODEL ?? 'claude-opus-5',
      discovery: {
        statusUrl: '/api/mcp/global',
        registryPath: 'boss_mcp_connections',
        configPath: 'postgres://boss_mcp_connections',
        serverUrlEnv: 'MYGENTIC_MCP_URL',
        configPathEnv: '(n/a — stored in postgres)',
        registryPathEnv: '(n/a — stored in postgres)',
        tokenEnv: '(n/a — tokens live in the Anthropic vault)',
        loginUrlEnv: 'API_BASE_URL',
      },
      customConnections: connections.map(toPublicConnection),
      agentInstructions: [
        'MCP servers are reached through Anthropic Managed Agents, not n8n.',
        'Declare the server here, click Login once, then call boss_managed_agent_run.',
        'Anthropic stores the OAuth token in a vault and refreshes it automatically.',
      ],
      errors: errors.length ? errors : undefined,
      checkedAt: new Date().toISOString(),
    });
  });

  // ── Create a connection ───────────────────────────────────────────────────
  server.post('/global/connections', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const transport = (typeof body.transport === 'string' ? body.transport : 'http') as McpTransport;
    const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : '';
    const command = typeof body.command === 'string' ? body.command.trim() : '';

    if (!name) return reply.code(400).send({ error: 'name is required' });
    if (!TRANSPORTS.includes(transport)) {
      return reply.code(400).send({ error: `transport must be one of ${TRANSPORTS.join(', ')}` });
    }
    if (transport === 'stdio' && !command) {
      return reply.code(400).send({ error: 'command is required for stdio connections' });
    }
    if (transport !== 'stdio') {
      if (!serverUrl) return reply.code(400).send({ error: 'serverUrl is required for http and sse connections' });
      try {
        const parsed = new URL(serverUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
      } catch {
        return reply.code(400).send({ error: 'serverUrl must be a valid http(s) URL' });
      }
    }

    try {
      const conn = await createConnection({
        name,
        transport,
        serverUrl: serverUrl || undefined,
        command: command || undefined,
        args: typeof body.args === 'string' ? body.args : undefined,
        loginUrl: typeof body.loginUrl === 'string' ? body.loginUrl : undefined,
        tokenEnv: typeof body.tokenEnv === 'string' ? body.tokenEnv : undefined,
        configPath: typeof body.configPath === 'string' ? body.configPath : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        enabled: body.enabled !== false,
      });
      return reply.send({ connection: toPublicConnection(conn) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      server.log.error({ err }, 'MCP connection create failed');
      return reply.code(500).send({ error: message });
    }
  });

  // ── Delete a connection ───────────────────────────────────────────────────
  server.delete('/global/connections/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    try {
      const removed = await deleteConnection(id);
      if (!removed) return reply.code(404).send({ error: 'connection not found' });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Start the OAuth (PKCE) flow ───────────────────────────────────────────
  server.post('/global/connections/:id/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    try {
      const conn = await getConnection(id);
      if (!conn) return reply.code(404).send({ error: 'connection not found' });
      if (!conn.serverUrl) {
        return reply.code(400).send({ error: 'stdio connections do not use OAuth' });
      }

      const uri = redirectUri();
      if (uri.startsWith('http://localhost')) {
        server.log.warn(
          'API_BASE_URL is unset — the OAuth redirect will point at localhost and most providers will reject it.',
        );
      }

      // Discover once and cache; re-discover if we have no endpoints yet.
      let authorizeEndpoint = conn.oauthAuthorizeEndpoint;
      let tokenEndpoint = conn.oauthTokenEndpoint;
      let registrationEndpoint = conn.oauthRegistrationEndpoint;
      let scope = conn.oauthScope ?? undefined;
      let resource = conn.oauthResource ?? undefined;

      if (!authorizeEndpoint || !tokenEndpoint) {
        const discovered = await discoverOAuth(conn.serverUrl);
        authorizeEndpoint = discovered.authorizationEndpoint;
        tokenEndpoint = discovered.tokenEndpoint;
        registrationEndpoint = discovered.registrationEndpoint ?? null;
        scope = discovered.scopesSupported?.join(' ') ?? scope;
        resource = discovered.resource ?? resource;
      }

      // Register a client if we don't have one (RFC 7591).
      let clientId = conn.oauthClientId;
      let clientSecret = conn.oauthClientSecret ?? undefined;
      if (!clientId && registrationEndpoint) {
        const registered = await registerClient(registrationEndpoint, uri, 'BOS (IR Custom AIOS)');
        if (registered) {
          clientId = registered.clientId;
          clientSecret = registered.clientSecret;
        }
      }
      if (!clientId) {
        return reply.code(400).send({
          error:
            `${conn.name} did not support dynamic client registration and no client_id is stored. ` +
            `Register BOS manually with redirect URI ${uri}, then re-add the connection with the client_id.`,
        });
      }

      await saveDiscovery(id, {
        authorizeEndpoint,
        tokenEndpoint,
        registrationEndpoint: registrationEndpoint ?? undefined,
        scope,
        resource,
        clientId,
        clientSecret,
      });

      const pkce = createPkce();
      const state = createState();
      await saveOAuthState({ state, connectionId: id, codeVerifier: pkce.verifier, redirectUri: uri });

      const authorizeUrl = buildAuthorizeUrl({
        authorizationEndpoint: authorizeEndpoint,
        clientId,
        redirectUri: uri,
        state,
        codeChallenge: pkce.challenge,
        scope,
        resource,
      });

      return reply.send({ authorizeUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      server.log.error({ err }, 'MCP login start failed');
      return reply.code(500).send({ error: message });
    }
  });

  // ── OAuth redirect target ─────────────────────────────────────────────────
  server.get('/global/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    reply.type('text/html');

    if (query.error) {
      return reply
        .code(400)
        .send(htmlPage('Login failed', `<p>The provider returned <code>${query.error}</code>.</p>`, false));
    }
    if (!query.code || !query.state) {
      return reply.code(400).send(htmlPage('Login failed', '<p>Missing <code>code</code> or <code>state</code>.</p>', false));
    }

    try {
      const pending = await consumeOAuthState(query.state);
      if (!pending) {
        return reply
          .code(400)
          .send(htmlPage('Login failed', '<p>That login link expired or was already used. Start again from Settings.</p>', false));
      }

      const conn = await getConnection(pending.connectionId);
      if (!conn?.oauthTokenEndpoint || !conn.oauthClientId) {
        return reply.code(400).send(htmlPage('Login failed', '<p>Connection is no longer configured.</p>', false));
      }

      const tokens = await exchangeCode({
        tokenEndpoint: conn.oauthTokenEndpoint,
        clientId: conn.oauthClientId,
        clientSecret: conn.oauthClientSecret ?? undefined,
        code: query.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        resource: conn.oauthResource ?? undefined,
      });

      await saveTokens(conn.id, tokens);

      // Push straight into the Anthropic vault so the agent can use it now.
      let vaultNote = '';
      try {
        const refreshed = await getConnection(conn.id);
        if (refreshed) await syncMcpCredential(refreshed);
        vaultNote = '<p>Credential stored in the Anthropic vault — the managed agent can use it now.</p>';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        server.log.error({ err }, 'vault credential sync failed');
        vaultNote = `<p>Token saved, but the Anthropic vault sync failed: <code>${message}</code></p>`;
      }

      return reply.send(
        htmlPage('Connected', `<p><strong>${conn.name}</strong> is authenticated.</p>${vaultNote}`, true),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      server.log.error({ err }, 'MCP oauth callback failed');
      return reply.code(500).send(htmlPage('Login failed', `<p><code>${message}</code></p>`, false));
    }
  });

  // ── Managed agent: run a task ─────────────────────────────────────────────
  server.post('/agent/run', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
    if (!managedAgentsConfigured()) {
      return reply.code(400).send({ error: 'ANTHROPIC_API_KEY is not set' });
    }

    try {
      const result = await runManagedAgentTask({
        prompt,
        agentKey: typeof body.agentKey === 'string' ? body.agentKey : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        mcpConnectionNames: Array.isArray(body.mcpConnectionNames)
          ? (body.mcpConnectionNames as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined,
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      server.log.error({ err }, 'managed agent run failed');
      return reply.code(500).send({ error: message });
    }
  });

  // ── Managed agent: run history ────────────────────────────────────────────
  server.get('/agent/runs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { limit } = (req.query ?? {}) as { limit?: string };
    try {
      const runs = await listRuns(limit ? parseInt(limit, 10) || 10 : 10);
      return reply.send({ runs });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export default mcpRoutes;

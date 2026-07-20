import type { FastifyInstance, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { getRuntimeConfig, setRuntimeConfig, deleteRuntimeConfig } from '../config-store.js';

type CustomMcpTransport = 'http' | 'sse' | 'stdio';

interface CustomMcpConnection {
  id: string;
  name: string;
  transport: CustomMcpTransport;
  serverUrl?: string;
  command?: string;
  args?: string;
  loginUrl?: string;
  tokenEnv?: string;
  configPath?: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GlobalMcpRegistry {
  customConnections?: CustomMcpConnection[];
  [key: string]: unknown;
}

function firstEnv(keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function globalRegistryPath(): string {
  return firstEnv(['BOSS_GLOBAL_MCP_REGISTRY_PATH']) ?? '/home/boss/boss-dev/mcp/global-connections.json';
}

async function readRegistry(path: string): Promise<GlobalMcpRegistry> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as GlobalMcpRegistry;
    return {
      ...parsed,
      customConnections: Array.isArray(parsed.customConnections) ? parsed.customConnections : [],
    };
  } catch {
    return { customConnections: [] };
  }
}

async function writeRegistry(path: string, registry: GlobalMcpRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCustomConnection(body: unknown, existing?: CustomMcpConnection): { ok: true; value: CustomMcpConnection } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = textField(input.name);
  if (!name) return { ok: false, error: 'Name is required.' };

  const transportRaw = textField(input.transport) ?? 'http';
  if (!['http', 'sse', 'stdio'].includes(transportRaw)) {
    return { ok: false, error: 'Transport must be http, sse, or stdio.' };
  }
  const transport = transportRaw as CustomMcpTransport;
  const serverUrl = textField(input.serverUrl);
  const command = textField(input.command);

  if (transport === 'stdio' && !command) {
    return { ok: false, error: 'Command is required for stdio MCP connections.' };
  }
  if (transport !== 'stdio' && !serverUrl) {
    return { ok: false, error: 'Server URL is required for http and sse MCP connections.' };
  }

  const now = new Date().toISOString();
  const id = slug(textField(input.id) ?? existing?.id ?? name);
  if (!id) return { ok: false, error: 'A valid id could not be created from that name.' };

  return {
    ok: true,
    value: {
      id,
      name,
      transport,
      ...(serverUrl ? { serverUrl } : {}),
      ...(command ? { command } : {}),
      ...(textField(input.args) ? { args: textField(input.args) } : {}),
      ...(textField(input.loginUrl) ? { loginUrl: textField(input.loginUrl) } : {}),
      ...(textField(input.tokenEnv) ? { tokenEnv: textField(input.tokenEnv) } : {}),
      ...(textField(input.configPath) ? { configPath: textField(input.configPath) } : {}),
      ...(textField(input.description) ? { description: textField(input.description) } : {}),
      enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  };
}

function canManageMcp(request: FastifyRequest): boolean {
  const auth = request.auth;
  return auth?.authMethod === 'internal' || auth?.role === 'admin' || auth?.role === 'owner';
}

async function checkHealth(url: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: 'ok' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkCodexMcpAuth(codexHome: string, ids: string[]): Promise<{ configured: boolean; authenticated: boolean; auth: string | null; error?: string }> {
  const wanted = new Set(ids.map((id) => id.toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return { configured: false, authenticated: false, auth: null };

  return new Promise((resolve) => {
    execFile(
      'codex',
      ['mcp', 'list'],
      {
        env: { ...process.env, CODEX_HOME: codexHome },
        timeout: 2500,
        maxBuffer: 16 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolve({ configured: false, authenticated: false, auth: null, error: error.message });
          return;
        }

        const line = String(stdout)
          .split(/\r?\n/)
          .map((item) => item.trim())
          .find((item) => wanted.has((item.split(/\s+/, 1)[0] ?? '').toLowerCase()));

        if (!line) {
          resolve({ configured: false, authenticated: false, auth: null });
          return;
        }

        const auth = /not logged in/i.test(line) ? 'Not logged in' : /oauth/i.test(line) ? 'OAuth' : 'Configured';
        resolve({ configured: true, authenticated: auth !== 'Not logged in', auth });
      },
    );
  });
}

function gatewayPublicUrl(request: FastifyRequest): string {
  const configured = firstEnv(['BOSS_GATEWAY_PUBLIC_URL', 'HERMES_GATEWAY_PUBLIC_URL']);
  if (configured) return configured;

  const forwardedHost = request.headers['x-forwarded-host'] ?? request.headers.host;
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  if (host && typeof host === 'string') {
    if (host.startsWith('localhost') || host.startsWith('127.') || /^\d+\.\d+\.\d+\.\d+/.test(host)) {
      return process.env.HERMES_GATEWAY_PUBLIC_URL || '';
    }
    const rootHost = host.replace(/^vasari\./, '');
    const forwardedProto = request.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return `${(proto ?? 'https').split(',')[0]}://gateway.${rootHost}`;
  }

  return process.env.HERMES_GATEWAY_PUBLIC_URL || '';
}

// ── OAuth (PKCE) for custom MCP connections ────────────────────────────────
// Mygentic Connect and other OAuth MCP servers cannot be "logged in" by opening
// a URL — the /mcp endpoint is a machine endpoint that returns 401 to a browser.
// These helpers let BOS act as the OAuth client: dynamic client registration +
// PKCE authorization-code flow, then inject the bearer into the Codex config so
// Codex can actually call the server's tools.

interface McpOAuthMeta {
  issuer: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource: string;
  scopes?: string;
}

// OAuth state/token/client are pinned to the 'default' tenant so the authed
// login route and the unauthed (tenant-less) callback always read the same keys.
const OAUTH_TENANT = 'default';
const oauthGet = (key: string) => getRuntimeConfig(key, OAUTH_TENANT);
const oauthSet = (key: string, value: string) => setRuntimeConfig(key, value, OAUTH_TENANT);
const oauthDel = (key: string) => deleteRuntimeConfig(key, OAUTH_TENANT);

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requestBaseUrl(request: FastifyRequest): string {
  const xfHost = request.headers['x-forwarded-host'] ?? request.headers.host;
  const host = Array.isArray(xfHost) ? xfHost[0] : xfHost;
  if (host && typeof host === 'string' && !host.startsWith('localhost') && !host.startsWith('127.')) {
    const proto = request.headers['x-forwarded-proto'];
    const scheme = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0] ?? 'https';
    return `${scheme}://${host}`;
  }
  return firstEnv(['API_BASE_URL', 'BOSS_PUBLIC_URL']) ?? '';
}

async function fetchJsonSafe(url: string, init?: Parameters<typeof fetch>[1]): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { ...(init ?? {}), signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: err instanceof Error ? err.message : 'fetch failed' };
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverMcpOAuth(resourceUrl: string): Promise<McpOAuthMeta> {
  const origin = new URL(resourceUrl).origin;
  let authServer = origin;
  let scopes: string | undefined;
  const prm = await fetchJsonSafe(`${origin}/.well-known/oauth-protected-resource`);
  if (prm.ok && prm.json) {
    const servers = prm.json.authorization_servers;
    if (Array.isArray(servers) && servers.length > 0) authServer = String(servers[0]).replace(/\/$/, '');
    if (Array.isArray(prm.json.scopes_supported)) scopes = prm.json.scopes_supported.join(' ');
  }
  const asm = await fetchJsonSafe(`${authServer}/.well-known/oauth-authorization-server`);
  const meta = asm.ok && asm.json ? asm.json : {};
  return {
    issuer: meta.issuer ?? authServer,
    authorizeEndpoint: meta.authorization_endpoint ?? `${authServer}/authorize`,
    tokenEndpoint: meta.token_endpoint ?? `${authServer}/token`,
    registrationEndpoint: meta.registration_endpoint ?? `${authServer}/register`,
    resource: resourceUrl,
    scopes,
  };
}

async function getOrRegisterClient(connectionId: string, meta: McpOAuthMeta, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  const stored = await oauthGet(`mcp_oauth_client:${connectionId}`);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.clientId && parsed.redirectUri === redirectUri) {
        return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
      }
    } catch { /* fall through to re-register */ }
  }
  if (!meta.registrationEndpoint) {
    throw new Error('Server exposes no dynamic client registration endpoint; a client_id must be provisioned manually.');
  }
  const reg = await fetchJsonSafe(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `Vasari-BOS (${connectionId})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: meta.scopes ?? 'mcp',
    }),
  });
  if (!reg.ok || !reg.json?.client_id) {
    throw new Error(`Dynamic client registration failed (HTTP ${reg.status}): ${String(reg.text).slice(0, 200)}`);
  }
  const clientId = String(reg.json.client_id);
  const clientSecret = reg.json.client_secret ? String(reg.json.client_secret) : undefined;
  await oauthSet(`mcp_oauth_client:${connectionId}`, JSON.stringify({ clientId, clientSecret, redirectUri }));
  return { clientId, clientSecret };
}

// Set `http_headers = { Authorization = "Bearer <token>" }` on [mcp_servers.<id>]
// in the Codex config.toml, preserving the rest of the file. Atomic write.
async function writeCodexServerBearer(configPath: string, serverId: string, serverUrl: string, token: string): Promise<void> {
  let content = '';
  try { content = await readFile(configPath, 'utf8'); } catch { content = ''; }
  const header = `[mcp_servers.${serverId}]`;
  const headerLine = `http_headers = { Authorization = "Bearer ${token}" }`;
  const lines = content.length ? content.split(/\r?\n/) : [];
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx === -1) {
    const block = `${header}\nurl = "${serverUrl}"\n${headerLine}\n`;
    content = content.length ? `${content.replace(/\n*$/, '\n')}\n${block}` : block;
  } else {
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
    let replaced = false;
    for (let i = headerIdx + 1; i < end; i++) {
      if (/^\s*http_headers\s*=/.test(lines[i])) { lines[i] = headerLine; replaced = true; break; }
    }
    if (!replaced) lines.splice(end, 0, headerLine);
    content = lines.join('\n');
  }
  const tmp = `${configPath}.tmp-oauth-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, configPath);
}

function oauthResultPage(ok: boolean, message: string): string {
  const color = ok ? '#2f9e5c' : '#c0453b';
  const title = ok ? 'Connected' : 'Login failed';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#0d1117;color:#e6edf3;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:440px;padding:32px;border:1px solid #30363d;border-radius:12px;background:#161b22;text-align:center}
.dot{width:14px;height:14px;border-radius:50%;background:${color};display:inline-block;margin-right:8px}
h1{font-size:18px;margin:0 0 12px}p{color:#9da7b3;font-size:14px;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1><span class="dot"></span>${title}</h1><p>${message}</p></div>
<script>setTimeout(function(){window.close();},${ok ? 2500 : 8000});</script></body></html>`;
}

export async function mcpRoutes(server: FastifyInstance): Promise<void> {
  server.get('/global', async (request) => {
    const codexHome = firstEnv(['CODEX_HOME']) ?? '/home/boss/.codex';
    const claudeHome = firstEnv(['CLAUDE_HOME']) ?? '/home/boss/.claude';
    const hermesHome = firstEnv(['HERMES_HOME', 'BOSS_HERMES_HOME']) ?? '/home/boss/.hermes';
    const configPath = firstEnv(['BOSS_GLOBAL_MCP_CONFIG_PATH', 'MCP_CONFIG_PATH']) ?? join(codexHome, 'config.toml');
    const registryPath = globalRegistryPath();
    const hostRegistryPath = firstEnv(['BOSS_GLOBAL_MCP_HOST_REGISTRY_PATH']) ?? '/docker/hermes-agent-epgg/mcp/global-connections.json';
    const serverUrl = firstEnv([
      'BOSS_GLOBAL_MCP_URL',
      'GLOBAL_MCP_URL',
      'MCP_SERVER_URL',
      'MCP_GATEWAY_URL',
    ]);
    const envAuthConfigured = Boolean(firstEnv([
      'BOSS_GLOBAL_MCP_TOKEN',
      'GLOBAL_MCP_TOKEN',
      'MCP_ACCESS_TOKEN',
      'MCP_API_KEY',
    ]));
    const loginUrl = firstEnv([
      'BOSS_GLOBAL_MCP_LOGIN_URL',
      'GLOBAL_MCP_LOGIN_URL',
      'MCP_LOGIN_URL',
      'MCP_AUTH_URL',
    ]);
    const gatewayBaseUrl = firstEnv(['HERMES_AGENT_URL', 'VASARI_GATEWAY_BASE_URL', 'OPENCLAW_BASE_URL']) ?? 'http://hermes-agent:4860';
    const publicGatewayUrl = gatewayPublicUrl(request);
    const configPresent = await exists(configPath);
    const registryPresent = await exists(registryPath);
    const registry = await readRegistry(registryPath);
    const codexMcp = await checkCodexMcpAuth(codexHome, [
      'mygentic',
      ...(registry.customConnections ?? []).map((item) => item.id),
    ]);
    // Real token presence per connection (a BOS-minted OAuth token in runtime_config).
    // `codex mcp list` reporting "OAuth" only means the server DEMANDS OAuth, not
    // that a token exists — so trust the stored token, not the list output.
    const connectionAuth = new Map<string, boolean>();
    await Promise.all(
      (registry.customConnections ?? []).map(async (item) => {
        connectionAuth.set(item.id, Boolean(await oauthGet(`mcp_oauth_token:${item.id}`)));
      }),
    );
    const anyConnectionAuthed = Array.from(connectionAuth.values()).some(Boolean);
    const authConfigured = envAuthConfigured || anyConnectionAuthed;
    const configured = Boolean(serverUrl || configPresent || registryPresent);
    const loginRequired = configured && !authConfigured;
    const gatewayHealth = await checkHealth(`${gatewayBaseUrl.replace(/\/$/, '')}/health`);

    return {
      id: 'global-mcp',
      name: 'Global MCP',
      scope: 'Vasari-VPS / hermes-agent docker project',
      configured,
      connected: configured && !loginRequired,
      loginRequired,
      authConfigured,
      serverUrl,
      loginUrl,
      configPath,
      configPresent,
      registryPath,
      registryPresent,
      hostRegistryPath,
      codexHome,
      claudeHome,
      hermesHome,
      codexMcp,
      transport: firstEnv(['BOSS_GLOBAL_MCP_TRANSPORT', 'MCP_TRANSPORT']) ?? 'stdio/http',
      model: firstEnv(['CODEX_MODEL', 'BOSS_EMPLOYEE_AGENT_CODEX_MODEL']) ?? null,
      gateway: {
        name: 'Hermes Gateway',
        owner: 'Hermes',
        relationship: 'wired-for-access',
        baseUrl: gatewayBaseUrl,
        publicUrl: publicGatewayUrl,
        healthUrl: `${gatewayBaseUrl.replace(/\/$/, '')}/health`,
        chatCompletionsUrl: `${gatewayBaseUrl.replace(/\/$/, '')}/v1/chat/completions`,
        modelsUrl: `${gatewayBaseUrl.replace(/\/$/, '')}/v1/models`,
        tokenConfigured: Boolean(firstEnv(['VASARI_GATEWAY_TOKEN', 'OPENCLAW_API_KEY', 'HERMES_AGENT_TOKEN'])),
        health: gatewayHealth,
      },
      discovery: {
        statusUrl: '/api/mcp/global',
        registryPath,
        hostRegistryPath,
        configPath,
        serverUrlEnv: 'BOSS_GLOBAL_MCP_URL',
        configPathEnv: 'BOSS_GLOBAL_MCP_CONFIG_PATH',
        registryPathEnv: 'BOSS_GLOBAL_MCP_REGISTRY_PATH',
        tokenEnv: 'BOSS_GLOBAL_MCP_TOKEN',
        loginUrlEnv: 'BOSS_GLOBAL_MCP_LOGIN_URL',
      },
      consumers: [
        {
          id: 'codex',
          name: 'Codex CLI',
          mode: 'internal',
          configPath: join(codexHome, 'config.toml'),
          purpose: 'Gio, employee-agent work, code execution, repository operations, and builder tasks.',
          canUseGlobalRegistry: true,
        },
        {
          id: 'claude',
          name: 'Claude Code CLI',
          mode: 'internal',
          configPath: firstEnv(['CLAUDE_MCP_CONFIG_PATH']) ?? join(claudeHome, 'claude_desktop_config.json'),
          purpose: 'Builder and deep-code workflows that need Claude Code semantics and MCP access.',
          canUseGlobalRegistry: true,
        },
        {
          id: 'hermes',
          name: 'Hermes',
          mode: 'internal',
          configPath: firstEnv(['HERMES_MCP_CONFIG_PATH', 'BOSS_HERMES_MCP_CONFIG_PATH']) ?? join(hermesHome, 'mcp.json'),
          purpose: 'Hermes-owned orchestration runtime and gateway access wired into Vasari-BOS.',
          canUseGlobalRegistry: true,
        },
      ],
      customConnections: (registry.customConnections ?? []).map((item) => ({
        ...item,
        authenticated: connectionAuth.get(item.id) ?? false,
        loginMethod: 'oauth' as const,
      })),
      agentInstructions: [
        'Use /api/mcp/global for browser-safe Global MCP metadata.',
        'On Vasari-VPS, the live BOS project is /docker/hermes-agent-qtbk.',
        'Use BOSS_GLOBAL_MCP_REGISTRY_PATH, BOSS_GLOBAL_MCP_CONFIG_PATH, and BOSS_GLOBAL_MCP_URL for shared discovery.',
        'Do not expose token values through the UI. Agents should read their own runtime secrets and establish their own internal MCP sessions.',
        'Claude Code CLI, Codex CLI, and Hermes can keep separate internal MCP configs while pointing at the same Global MCP registry or server URL.',
      ],
      checkedAt: new Date().toISOString(),
    };
  });

  server.post('/global/connections', async (request, reply) => {
    if (!canManageMcp(request)) {
      return reply.status(403).send({ error: 'Admin access required.' });
    }

    const registryPath = globalRegistryPath();
    const registry = await readRegistry(registryPath);
    const list = registry.customConnections ?? [];
    const incomingId = textField((request.body as Record<string, unknown> | undefined)?.id);
    const existing = incomingId ? list.find((item) => item.id === slug(incomingId)) : undefined;
    const normalized = normalizeCustomConnection(request.body, existing);
    if (!normalized.ok) {
      return reply.status(400).send({ error: normalized.error });
    }

    const next = list.filter((item) => item.id !== normalized.value.id);
    next.push(normalized.value);
    next.sort((a, b) => a.name.localeCompare(b.name));

    await writeRegistry(registryPath, { ...registry, customConnections: next });
    return reply.status(existing ? 200 : 201).send(normalized.value);
  });

  server.delete<{ Params: { id: string } }>('/global/connections/:id', async (request, reply) => {
    if (!canManageMcp(request)) {
      return reply.status(403).send({ error: 'Admin access required.' });
    }

    const id = slug(request.params.id);
    const registryPath = globalRegistryPath();
    const registry = await readRegistry(registryPath);
    const before = registry.customConnections ?? [];
    const after = before.filter((item) => item.id !== id);
    await writeRegistry(registryPath, { ...registry, customConnections: after });
    return reply.status(200).send({ ok: true, removed: before.length - after.length });
  });

  // Start an OAuth (PKCE) login for a custom MCP connection. Returns the REAL
  // provider authorize URL for the browser to open. Replaces the broken
  // "open the /mcp endpoint and get a 401" behaviour.
  server.post<{ Params: { id: string } }>('/global/connections/:id/login', async (request, reply) => {
    if (!canManageMcp(request)) {
      return reply.status(403).send({ error: 'Admin access required.' });
    }
    const id = slug(request.params.id);
    const registry = await readRegistry(globalRegistryPath());
    const conn = (registry.customConnections ?? []).find((item) => item.id === id);
    if (!conn) return reply.status(404).send({ error: `No custom MCP connection '${id}'.` });
    const resource = conn.serverUrl;
    if (!resource) return reply.status(400).send({ error: 'Connection has no server URL to authenticate against.' });

    try {
      const meta = await discoverMcpOAuth(resource);
      const redirectUri = `${requestBaseUrl(request)}/api/mcp/global/connections/${id}/callback`;
      const { clientId } = await getOrRegisterClient(id, meta, redirectUri);
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      const state = base64url(crypto.randomBytes(24));
      await oauthSet(
        `mcp_oauth_state:${state}`,
        JSON.stringify({ id, verifier, redirectUri, clientId, tokenEndpoint: meta.tokenEndpoint, resource, ts: Date.now() }),
      );
      const authorizeUrl = new URL(meta.authorizeEndpoint);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('state', state);
      if (meta.scopes) authorizeUrl.searchParams.set('scope', meta.scopes);
      authorizeUrl.searchParams.set('resource', resource);
      return reply.send({ authorizeUrl: authorizeUrl.toString() });
    } catch (err) {
      request.log.error({ err, id }, 'MCP OAuth login start failed');
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'OAuth start failed' });
    }
  });

  // OAuth redirect target — public (the provider's browser redirect carries no
  // BOS auth). Exchanges the code, stores the token, injects the bearer into Codex.
  server.get<{ Params: { id: string }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/global/connections/:id/callback',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const send = (ok: boolean, msg: string) => reply.type('text/html').send(oauthResultPage(ok, msg));
      const { code, state, error, error_description } = request.query;
      if (error) return send(false, `Authorization was denied: ${error} ${error_description ?? ''}`.trim());
      if (!code || !state) return send(false, 'Missing authorization code or state.');

      const raw = await oauthGet(`mcp_oauth_state:${state}`);
      if (!raw) return send(false, 'Login state is invalid or already used. Start again from Settings.');
      await oauthDel(`mcp_oauth_state:${state}`);

      let st: { id: string; verifier: string; redirectUri: string; clientId: string; tokenEndpoint: string; resource: string; ts: number };
      try { st = JSON.parse(raw); } catch { return send(false, 'Corrupt login state.'); }
      if (Date.now() - (st.ts ?? 0) > 30 * 60 * 1000) return send(false, 'Login state expired (30 minutes). Start again.');
      if (slug(request.params.id) !== st.id) return send(false, 'Login state / connection mismatch.');

      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: st.redirectUri,
          client_id: st.clientId,
          code_verifier: st.verifier,
        });
        const tok = await fetchJsonSafe(st.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (!tok.ok || !tok.json?.access_token) {
          return send(false, `Token exchange failed (HTTP ${tok.status}). ${String(tok.text).slice(0, 160)}`);
        }
        const now = Date.now();
        const bundle = {
          access_token: String(tok.json.access_token),
          refresh_token: tok.json.refresh_token ? String(tok.json.refresh_token) : null,
          token_type: tok.json.token_type ?? 'Bearer',
          expires_at: tok.json.expires_in ? now + Number(tok.json.expires_in) * 1000 : null,
          obtained_at: now,
          resource: st.resource,
          token_endpoint: st.tokenEndpoint,
          client_id: st.clientId,
        };
        await oauthSet(`mcp_oauth_token:${st.id}`, JSON.stringify(bundle));

        const reg = await readRegistry(globalRegistryPath());
        const conn = (reg.customConnections ?? []).find((item) => item.id === st.id);
        const configPath = conn?.configPath ?? join(firstEnv(['CODEX_HOME']) ?? '/home/boss/.codex', 'config.toml');
        await writeCodexServerBearer(configPath, st.id, conn?.serverUrl ?? st.resource, bundle.access_token);

        return send(true, `${conn?.name ?? st.id} is authenticated. You can close this tab and return to Vasari.`);
      } catch (err) {
        request.log.error({ err, id: st.id }, 'MCP OAuth callback failed');
        return send(false, err instanceof Error ? err.message : 'Callback failed.');
      }
    },
  );

  // Refresh a stored token (callable by an operator or a scheduled healer).
  server.post<{ Params: { id: string } }>('/global/connections/:id/refresh', async (request, reply) => {
    if (!canManageMcp(request)) {
      return reply.status(403).send({ error: 'Admin access required.' });
    }
    const id = slug(request.params.id);
    const raw = await oauthGet(`mcp_oauth_token:${id}`);
    if (!raw) return reply.status(404).send({ error: 'No stored token. Run Open Login first.' });
    let bundle: any;
    try { bundle = JSON.parse(raw); } catch { return reply.status(500).send({ error: 'Corrupt stored token.' }); }
    if (!bundle.refresh_token) return reply.status(400).send({ error: 'No refresh token available; re-run Open Login.' });

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refresh_token,
      client_id: bundle.client_id,
    });
    const tok = await fetchJsonSafe(bundle.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!tok.ok || !tok.json?.access_token) {
      return reply.status(502).send({ error: `Refresh failed (HTTP ${tok.status}). Re-run Open Login.` });
    }
    const now = Date.now();
    const next = {
      ...bundle,
      access_token: String(tok.json.access_token),
      refresh_token: tok.json.refresh_token ? String(tok.json.refresh_token) : bundle.refresh_token,
      expires_at: tok.json.expires_in ? now + Number(tok.json.expires_in) * 1000 : null,
      obtained_at: now,
    };
    await oauthSet(`mcp_oauth_token:${id}`, JSON.stringify(next));

    const reg = await readRegistry(globalRegistryPath());
    const conn = (reg.customConnections ?? []).find((item) => item.id === id);
    const configPath = conn?.configPath ?? join(firstEnv(['CODEX_HOME']) ?? '/home/boss/.codex', 'config.toml');
    await writeCodexServerBearer(configPath, id, conn?.serverUrl ?? next.resource, next.access_token);
    return reply.send({ ok: true, expiresAt: next.expires_at });
  });
}

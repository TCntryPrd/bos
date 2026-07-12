import type { FastifyInstance, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
      return 'https://gateway.vasari.starrpartners.ai';
    }
    const rootHost = host.replace(/^vasari\./, '');
    const forwardedProto = request.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return `${(proto ?? 'https').split(',')[0]}://gateway.${rootHost}`;
  }

  return 'https://gateway.vasari.starrpartners.ai';
}

export async function mcpRoutes(server: FastifyInstance): Promise<void> {
  server.get('/global', async (request) => {
    const codexHome = firstEnv(['CODEX_HOME']) ?? '/home/boss/.codex';
    const claudeHome = firstEnv(['CLAUDE_HOME']) ?? '/home/boss/.claude';
    const hermesHome = firstEnv(['HERMES_HOME', 'BOSS_HERMES_HOME']) ?? '/home/boss/.hermes';
    const configPath = firstEnv(['BOSS_GLOBAL_MCP_CONFIG_PATH', 'MCP_CONFIG_PATH']) ?? join(codexHome, 'config.toml');
    const registryPath = globalRegistryPath();
    const hostRegistryPath = firstEnv(['BOSS_GLOBAL_MCP_HOST_REGISTRY_PATH']) ?? '/docker/hermes-agent-qtbk/mcp/global-connections.json';
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
    const authConfigured = envAuthConfigured || codexMcp.authenticated;
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
      customConnections: registry.customConnections ?? [],
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
}

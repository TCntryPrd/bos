/**
 * Connector routes — /api/connectors/*
 *
 *   GET    /accounts                    — list all connected accounts for the tenant
 *   POST   /oauth/:provider/start       — initiate OAuth2 PKCE flow, returns redirect URL
 *   GET    /oauth/:provider/callback    — handle provider redirect, exchange code for tokens
 *   DELETE /accounts/:provider/:email   — disconnect and delete stored tokens
 *
 * Supported providers: google | microsoft
 *
 * OAuth flow:
 *   1. Client calls POST /start → receives { url, state }
 *   2. Client redirects the user's browser to url
 *   3. Provider redirects to /callback?code=...&state=...
 *   4. Server exchanges the code, stores the token, returns account info
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  buildAuthUrl,
  exchangeCode,
  getScopesForServices,
  storeAuthState,
  consumeAuthState,
  storeToken,
  getAllTokensForProvider,
  deleteToken,
  initTokenStore,
} from '@boss/connectors';
import type { Provider } from '@boss/connectors';
import crypto from 'node:crypto';
import { getRuntimeConfig, setRuntimeConfig, deleteRuntimeConfig } from '../config-store.js';
import {
  QBO_AUTHORIZE_ENDPOINT,
  QBO_SCOPE,
  qboConfigured,
  qboConnected,
  qboRedirectUri,
  exchangeQboCode,
  storeQboTokens,
  disconnectQbo,
} from '../tools/quickbooks-auth.js';
import { getQboFinancialSnapshot } from '../tools/quickbooks-snapshot.js';

// ---------------------------------------------------------------------------
// Token store initialisation (requires DB in production; skipped in Phase 1)
// ---------------------------------------------------------------------------

let storeInitAttempted = false;

async function tryInitStore(): Promise<void> {
  if (storeInitAttempted) return;
  storeInitAttempted = true;
  // Phase 1: no DB wired — initTokenStore will throw if called with null.
  // Routes that need the store will return 503 until DB is configured.
}

// ---------------------------------------------------------------------------
// OAuth client configuration (Phase 1 — runtime env / module-level cache)
// Populated by POST /api/connectors/oauth/configure during onboarding.
// ---------------------------------------------------------------------------

interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  configuredAt: Date;
}

/** Module-level cache so getOAuthConfig() picks up values set at runtime. */
export const oauthClientConfigs = new Map<Provider, OAuthClientConfig>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const providerParamSchema = {
  type: 'object',
  required: ['provider'],
  properties: {
    provider: { type: 'string', enum: ['google', 'microsoft', 'linkedin'] },
  },
} as const;

const disconnectParamSchema = {
  type: 'object',
  required: ['provider', 'email'],
  properties: {
    provider: { type: 'string', enum: ['google', 'microsoft', 'linkedin'] },
    email: { type: 'string' },
  },
} as const;

const oauthStartBodySchema = {
  type: 'object',
  properties: {
    services: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['mail', 'calendar', 'tasks', 'drive', 'contacts', 'chat'],
      },
      default: ['mail', 'calendar', 'tasks'],
    },
    email: {
      type: 'string',
      description: 'Optional login_hint — pre-selects a specific Google account in the account picker',
    },
  },
  additionalProperties: false,
} as const;

const oauthConfigureBodySchema = {
  type: 'object',
  required: ['provider', 'clientId', 'clientSecret'],
  properties: {
    provider: { type: 'string', enum: ['google', 'microsoft', 'linkedin'] },
    clientId: { type: 'string', minLength: 1 },
    clientSecret: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const callbackQuerySchema = {
  type: 'object',
  required: ['state'],
  properties: {
    code: { type: 'string' },
    state: { type: 'string' },
    error: { type: 'string' },
    error_description: { type: 'string' },
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive per-service connection status from the OAuth scopes granted to an
 * account. The web client renders one row per service, so we translate the
 * raw Google/Microsoft scope URLs into the canonical service keys it expects
 * (mail | calendar | tasks | drive | contacts | chat).
 */
function deriveServiceStatuses(
  scopes: string[],
  tokenHealthy: boolean,
  checkedAt: string,
): Array<{ service: string; enabled: boolean; healthy: boolean; lastChecked: string }> {
  const has = (needle: string) => scopes.some((s) => s.includes(needle));
  const services: Array<[string, boolean]> = [
    ['mail',     has('gmail') || has('mail') || has('outlook')],
    ['calendar', has('calendar')],
    ['tasks',    has('tasks') || has('todo')],
    ['drive',    has('drive') || has('onedrive')],
    ['contacts', has('contacts') || has('people')],
    ['chat',     has('chat') || has('teams')],
  ];
  return services
    .filter(([, enabled]) => enabled)
    .map(([service, enabled]) => ({
      service,
      enabled,
      healthy: enabled && tokenHealthy,
      lastChecked: checkedAt,
    }));
}

function getOAuthConfig(
  provider: Provider,
  redirectUri: string,
  scopes: string[],
) {
  // Prefer runtime-configured values (set via /oauth/configure) over env vars
  const cached = oauthClientConfigs.get(provider);
  if (provider === 'google') {
    return {
      provider,
      clientId: cached?.clientId ?? process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: cached?.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri,
      scopes,
    };
  }
  if (provider === 'linkedin') {
    return {
      provider,
      clientId: cached?.clientId ?? process.env.LINKEDIN_CLIENT_ID ?? '',
      clientSecret: cached?.clientSecret ?? process.env.LINKEDIN_CLIENT_SECRET ?? '',
      redirectUri,
      scopes,
    };
  }
  return {
    provider,
    clientId: cached?.clientId ?? process.env.MS_CLIENT_ID ?? '',
    clientSecret: cached?.clientSecret ?? process.env.MS_CLIENT_SECRET ?? '',
    redirectUri,
    scopes,
  };
}

function getBaseUrl(request?: { headers: Record<string, unknown> }): string {
  // Prefer the actual host the request came in on (Traefik sets x-forwarded-*),
  // so every white-label install redirects OAuth to ITS OWN domain — not a
  // hard-coded one. Falls back to API_BASE_URL, then localhost.
  if (request?.headers) {
    const xfHost = request.headers['x-forwarded-host'] ?? request.headers['host'];
    const host = Array.isArray(xfHost) ? xfHost[0] : xfHost;
    if (host && typeof host === 'string' && !host.startsWith('localhost') && !host.startsWith('127.')) {
      const proto = (request.headers['x-forwarded-proto'] as string) || 'https';
      return `${String(proto).split(',')[0]}://${host}`;
    }
  }
  return process.env.API_BASE_URL ?? 'http://localhost:3000';
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

type ServiceName = 'mail' | 'calendar' | 'tasks' | 'drive' | 'contacts' | 'chat';

interface OAuthStartBody {
  services?: ServiceName[];
  /** Optional login_hint — pre-selects a specific Google/Microsoft account. */
  email?: string;
}

interface OAuthConfigureBody {
  provider: 'google' | 'microsoft';
  clientId: string;
  clientSecret: string;
}

interface CallbackQuery {
  code?: string;
  state: string;
  error?: string;
  error_description?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function connectorRoutes(server: FastifyInstance) {
  await tryInitStore();

  // Restore OAuth client configs. ENV VARS ALWAYS WIN over Postgres runtime_config
  // to prevent stale DB values from breaking OAuth on container restart.
  try {
    const envGoogleId = process.env.GOOGLE_CLIENT_ID;
    const envGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;
    const envMsId = process.env.MS_CLIENT_ID ?? process.env.MS365_CLIENT_ID;
    const envMsSecret = process.env.MS_CLIENT_SECRET ?? process.env.MS365_CLIENT_SECRET;

    // Google: env wins, then DB fallback
    if (envGoogleId && envGoogleSecret) {
      oauthClientConfigs.set('google', {
        clientId: envGoogleId,
        clientSecret: envGoogleSecret,
        configuredAt: new Date(),
      });
      // Sync DB to match env so they never drift
      await Promise.all([
        setRuntimeConfig('GOOGLE_CLIENT_ID', envGoogleId),
        setRuntimeConfig('GOOGLE_CLIENT_SECRET', envGoogleSecret),
      ]).catch(() => {});
      server.log.info('Google OAuth client config loaded from env (synced to Postgres)');
    } else {
      const [dbGoogleId, dbGoogleSecret] = await Promise.all([
        getRuntimeConfig('GOOGLE_CLIENT_ID'),
        getRuntimeConfig('GOOGLE_CLIENT_SECRET'),
      ]);
      if (dbGoogleId && dbGoogleSecret) {
        oauthClientConfigs.set('google', {
          clientId: dbGoogleId,
          clientSecret: dbGoogleSecret,
          configuredAt: new Date(),
        });
        server.log.info('Google OAuth client config restored from Postgres (no env vars set)');
      }
    }

    // Microsoft: env wins, then DB fallback
    if (envMsId && envMsSecret) {
      oauthClientConfigs.set('microsoft', {
        clientId: envMsId,
        clientSecret: envMsSecret,
        configuredAt: new Date(),
      });
      server.log.info('Microsoft OAuth client config loaded from env');
    } else {
      const [dbMsId, dbMsSecret] = await Promise.all([
        getRuntimeConfig('MS365_CLIENT_ID'),
        getRuntimeConfig('MS365_CLIENT_SECRET'),
      ]);
      if (dbMsId && dbMsSecret) {
        oauthClientConfigs.set('microsoft', {
          clientId: dbMsId,
          clientSecret: dbMsSecret,
          configuredAt: new Date(),
        });
        server.log.info('Microsoft OAuth client config restored from Postgres');
      }
    }

    // LinkedIn: operator's own app — env only.
    const envLiId = process.env.LINKEDIN_CLIENT_ID;
    const envLiSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (envLiId && envLiSecret) {
      oauthClientConfigs.set('linkedin', {
        clientId: envLiId,
        clientSecret: envLiSecret,
        configuredAt: new Date(),
      });
      server.log.info('LinkedIn OAuth client config loaded from env');
    }
  } catch (err) {
    server.log.warn({ err }, 'Could not restore OAuth client configs — using env defaults');
  }

  /**
   * GET /api/connectors/status
   * Returns configuration and connectivity status for each supported OAuth
   * provider without leaking credentials.
   *
   * Providers that have never been configured are returned with
   * `status: 'not_configured'` rather than appearing degraded. This prevents
   * the dashboard from showing providers as errored when they were never set up.
   *
   * Example response:
   *   [
   *     { "provider": "google",    "status": "configured", "configuredAt": "..." },
   *     { "provider": "microsoft", "status": "not_configured" }
   *   ]
   */
  server.get(
    '/status',
    {
      config: { skipAuth: true },
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                provider:     { type: 'string' },
                status:       { type: 'string' },
                configuredAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const providers: Provider[] = ['google', 'microsoft'];
      const result = providers.map((p) => {
        const cfg = oauthClientConfigs.get(p);
        if (!cfg) {
          return { provider: p, status: 'not_configured' };
        }
        return {
          provider: p,
          status: 'configured',
          configuredAt: cfg.configuredAt.toISOString(),
        };
      });
      return reply.status(200).send(result);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Integration API-key configuration endpoints
  // ─────────────────────────────────────────────────────────────────────────────

  /** Map integration IDs to their environment variable names. */
  const INTEGRATION_ENV_MAP: Record<string, string> = {
    n8n: 'N8N_API_KEY',
    notion: 'NOTION_API_KEY',
    airtable: 'AIRTABLE_API_KEY',
    slack: 'SLACK_BOT_TOKEN',
    telegram: 'TELEGRAM_BOT_TOKEN',
    make: 'MAKE_API_KEY',
    stripe: 'STRIPE_SECRET_KEY',
    homeassistant: 'HA_ACCESS_TOKEN',
    gemini: 'GEMINI_API_KEY',
    github: 'GITHUB_TOKEN',
    youtube: 'YOUTUBE_API_KEY',
    spotify: 'SPOTIFY_ACCESS_TOKEN',
    miro: 'MIRO_ACCESS_TOKEN',
    unipile: 'UNIPILE_API_KEY',
  };

  /**
   * Integrations whose host is not fixed (self-hosted / per-account) take an
   * optional Base URL alongside the API key. The UI shows a Base URL field for
   * these and prefills the current value.
   */
  const INTEGRATION_BASEURL_MAP: Record<string, string> = {
    n8n: 'N8N_BASE_URL',
    homeassistant: 'HA_BASE_URL',
    airtable: 'AIRTABLE_BASE_URL',
    unipile: 'UNIPILE_BASE_URL',
  };

  /** Full integration catalog — Google and Microsoft are OAuth-based, the rest use API keys. */
  const INTEGRATION_CATALOG: Array<{
    id: string;
    name: string;
    type: 'oauth' | 'apikey';
    envVar?: string;
  }> = [
    { id: 'google',        name: 'Google Workspace', type: 'oauth' },
    { id: 'linkedin',      name: 'LinkedIn',         type: 'oauth' },
    { id: 'n8n',           name: 'n8n',              type: 'apikey', envVar: 'N8N_API_KEY' },
    { id: 'notion',        name: 'Notion',           type: 'apikey', envVar: 'NOTION_API_KEY' },
    { id: 'airtable',      name: 'Airtable',         type: 'apikey', envVar: 'AIRTABLE_API_KEY' },
    { id: 'slack',         name: 'Slack',            type: 'apikey', envVar: 'SLACK_BOT_TOKEN' },
    { id: 'telegram',      name: 'Telegram',         type: 'apikey', envVar: 'TELEGRAM_BOT_TOKEN' },
    { id: 'make',          name: 'Make',             type: 'apikey', envVar: 'MAKE_API_KEY' },
    { id: 'stripe',        name: 'Stripe',           type: 'apikey', envVar: 'STRIPE_SECRET_KEY' },
    { id: 'homeassistant', name: 'Home Assistant',   type: 'apikey', envVar: 'HA_ACCESS_TOKEN' },
    { id: 'gemini',        name: 'Gemini',           type: 'apikey', envVar: 'GEMINI_API_KEY' },
    { id: 'github',        name: 'GitHub',           type: 'apikey', envVar: 'GITHUB_TOKEN' },
    { id: 'youtube',       name: 'YouTube',          type: 'apikey', envVar: 'YOUTUBE_API_KEY' },
    { id: 'spotify',       name: 'Spotify',          type: 'apikey', envVar: 'SPOTIFY_ACCESS_TOKEN' },
    { id: 'quickbooks',    name: 'QuickBooks Online', type: 'oauth' },
    { id: 'miro',          name: 'Miro',             type: 'apikey', envVar: 'MIRO_ACCESS_TOKEN' },
    { id: 'unipile',       name: 'Unipile (LinkedIn/WhatsApp)', type: 'apikey', envVar: 'UNIPILE_API_KEY' },
    { id: 'meta',          name: 'Meta (Facebook/IG/Threads/WhatsApp)', type: 'apikey', envVar: 'META_APP_ID' },
  ];

  /**
   * GET /api/connectors/integrations
   * Returns configuration status for every integration in the catalog.
   *
   * OAuth providers report "configured" when their client credentials are
   * present. API-key providers report "configured" when their env var is set.
   *
   * Example response:
   *   [
   *     { "id": "google", "name": "Google Workspace", "type": "oauth", "configured": true },
   *     { "id": "n8n",    "name": "n8n",   "type": "apikey", "configured": false, "envVar": "N8N_API_KEY" },
   *     ...
   *   ]
   */
  server.get(
    '/integrations',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:          { type: 'string' },
                name:        { type: 'string' },
                type:        { type: 'string' },
                configured:  { type: 'boolean' },
                envVar:      { type: 'string' },
                needsBaseUrl:{ type: 'boolean' },
                baseUrl:     { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = INTEGRATION_CATALOG.map((entry) => {
        let configured = false;
        if (entry.id === 'quickbooks') {
          // QuickBooks OAuth lives outside the google/microsoft token store —
          // configured means Intuit app credentials are present in the env.
          configured = qboConfigured();
        } else if (entry.type === 'oauth') {
          const provider = entry.id as Provider; // 'google' | 'linkedin'
          configured = oauthClientConfigs.has(provider);
        } else if (entry.envVar) {
          // YouTube shares the Gemini API key — auto-resolve
          if (entry.id === 'youtube' && !process.env.YOUTUBE_API_KEY && process.env.GEMINI_API_KEY) {
            process.env.YOUTUBE_API_KEY = process.env.GEMINI_API_KEY;
          }
          const val = process.env[entry.envVar];
          configured = typeof val === 'string' && val.length > 0;
          if (entry.id === 'unipile') {
            configured = configured && typeof process.env.UNIPILE_BASE_URL === 'string' && process.env.UNIPILE_BASE_URL.length > 0;
          }
        }
        const baseUrlVar = INTEGRATION_BASEURL_MAP[entry.id];
        const baseUrl = baseUrlVar ? (process.env[baseUrlVar] ?? '') : '';
        return {
          id: entry.id,
          name: entry.name,
          type: entry.type,
          configured,
          ...(entry.envVar ? { envVar: entry.envVar } : {}),
          ...(baseUrlVar ? { needsBaseUrl: true, baseUrl } : {}),
        };
      });
      return reply.status(200).send(result);
    },
  );

  /**
   * POST /api/connectors/configure
   * Save an API key for an integration.  Persists to Postgres runtime_config
   * and sets process.env so the key is available immediately.
   *
   * Auth: required (admin-only by convention — the authMiddleware is active).
   *
   * Example request:
   *   POST /api/connectors/configure
   *   { "integration": "n8n", "apiKey": "the-api-key-value" }
   *
   * Example response:
   *   { "status": "ok", "integration": "n8n", "configured": true }
   */
  /** Extra env vars that some integrations need beyond the primary key. */
  const INTEGRATION_EXTRA_KEYS: Record<string, Record<string, string>> = {
    slack: { signingSecret: 'SLACK_SIGNING_SECRET' },
    telegram: { adminChatId: 'TELEGRAM_ADMIN_CHAT_ID' },
  };

  server.post<{ Body: { integration: string; apiKey: string; baseUrl?: string; extraKeys?: Record<string, string> } }>(
    '/configure',
    {
      schema: {
        body: {
          type: 'object',
          required: ['integration', 'apiKey'],
          properties: {
            integration: { type: 'string' },
            apiKey: { type: 'string', minLength: 1 },
            baseUrl: { type: 'string' },
            extraKeys: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              status:      { type: 'string' },
              integration: { type: 'string' },
              configured:  { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { integration: string; apiKey: string; baseUrl?: string; extraKeys?: Record<string, string> } }>, reply: FastifyReply) => {
      const { integration, apiKey, baseUrl, extraKeys } = request.body;
      const envVar = INTEGRATION_ENV_MAP[integration];

      if (!envVar) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unknown integration: ${integration}. Valid: ${Object.keys(INTEGRATION_ENV_MAP).join(', ')}`,
        });
      }

      // Admin-only guard
      const role = request.auth?.role;
      if (role && role !== 'admin' && role !== 'owner') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only admin users can configure integrations',
        });
      }

      try {
        const tenantId = 'default';
        // Save the primary key
        await setRuntimeConfig(envVar, apiKey, tenantId);

        // Save the Base URL for self-hosted / per-account integrations
        const baseUrlVar = INTEGRATION_BASEURL_MAP[integration];
        if (baseUrlVar && typeof baseUrl === 'string' && baseUrl.trim()) {
          await setRuntimeConfig(baseUrlVar, baseUrl.trim().replace(/\/$/, ''), tenantId);
        }

        // Save extra keys if provided
        const extraMap = INTEGRATION_EXTRA_KEYS[integration];
        if (extraKeys && extraMap) {
          for (const [field, value] of Object.entries(extraKeys)) {
            const extraEnvVar = extraMap[field];
            if (extraEnvVar && value) {
              await setRuntimeConfig(extraEnvVar, value, tenantId);
            }
          }
        }
      } catch (err) {
        request.log.error({ err, integration, envVar }, 'Failed to persist integration API key');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to save integration configuration',
        });
      }

      request.log.info(
        { integration, envVar, userId: request.auth?.userId },
        'Integration API key configured',
      );

      return reply.status(200).send({ status: 'ok', integration, configured: true });
    },
  );

  /**
   * DELETE /api/connectors/configure/:integration
   * Remove an API key for an integration.  Deletes from Postgres runtime_config
   * and clears process.env.
   *
   * Auth: required (admin-only).
   *
   * Example:
   *   DELETE /api/connectors/configure/n8n
   *
   * Example response:
   *   { "status": "ok", "integration": "n8n", "configured": false }
   */
  server.delete<{ Params: { integration: string } }>(
    '/configure/:integration',
    {
      schema: {
        params: {
          type: 'object',
          required: ['integration'],
          properties: {
            integration: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              status:      { type: 'string' },
              integration: { type: 'string' },
              configured:  { type: 'boolean' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { integration: string } }>,
      reply: FastifyReply,
    ) => {
      const { integration } = request.params;
      const envVar = INTEGRATION_ENV_MAP[integration];

      if (!envVar) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unknown integration: ${integration}. Valid: ${Object.keys(INTEGRATION_ENV_MAP).join(', ')}`,
        });
      }

      // Admin-only guard
      const role = request.auth?.role;
      if (role && role !== 'admin' && role !== 'owner') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only admin users can configure integrations',
        });
      }

      try {
        const tenantId = 'default';
        await deleteRuntimeConfig(envVar, tenantId);
        const baseUrlVar = INTEGRATION_BASEURL_MAP[integration];
        if (baseUrlVar) await deleteRuntimeConfig(baseUrlVar, tenantId);
        const extraMap = INTEGRATION_EXTRA_KEYS[integration];
        if (extraMap) {
          for (const extraEnvVar of Object.values(extraMap)) {
            await deleteRuntimeConfig(extraEnvVar, tenantId);
          }
        }
      } catch (err) {
        request.log.error({ err, integration, envVar }, 'Failed to delete integration API key');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to remove integration configuration',
        });
      }

      request.log.info(
        { integration, envVar, userId: request.auth?.userId },
        'Integration API key removed',
      );

      return reply.status(200).send({ status: 'ok', integration, configured: false });
    },
  );

  /**
   * GET /api/connectors/accounts
   * List all connected OAuth accounts across all providers.
   *
   * Returns every account stored in boss_oauth_tokens, not just one.
   * Use the email field to target a specific account when calling tools.
   *
   * Example response:
   *   [
   *     {
   *       "accountId": "google-a2Nhaw...",
   *       "provider": "google",
   *       "email": "d.caine@dcaine.com",
   *       "scopes": ["https://www.googleapis.com/auth/gmail.readonly", ...],
   *       "connectedAt": "2025-11-01T12:00:00.000Z"
   *     }
   *   ]
   */
  server.get(
    '/accounts',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:             { type: 'string' },
                provider:       { type: 'string' },
                accountLabel:   { type: 'string' },
                email:          { type: 'string' },
                scopes:         { type: 'array', items: { type: 'string' } },
                tokenExpiresAt: { type: 'string' },
                services: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      service:     { type: 'string' },
                      enabled:     { type: 'boolean' },
                      healthy:     { type: 'boolean' },
                      lastChecked: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let googleTokens: Awaited<ReturnType<typeof getAllTokensForProvider>> = [];
      let microsoftTokens: Awaited<ReturnType<typeof getAllTokensForProvider>> = [];

      try {
        [googleTokens, microsoftTokens] = await Promise.all([
          getAllTokensForProvider('google'),
          getAllTokensForProvider('microsoft'),
        ]);
      } catch (err) {
        request.log.warn({ err }, 'Token store not available — returning empty accounts list');
        return reply.status(200).send([]);
      }

      const checkedAt = new Date().toISOString();
      const accounts = [...googleTokens, ...microsoftTokens]
        // Skip orphan tokens with no resolved email — they have no usable
        // identity and would render as blank, un-disconnectable cards.
        .filter((t) => typeof t.email === 'string' && t.email.length > 0)
        .map((t) => {
          const expiresAt = t.expiresAt ?? new Date(0);
          const tokenHealthy = expiresAt.getTime() - Date.now() > 10 * 60_000;
          const scopes = t.scopes ?? [];
          return {
            id:             `${t.provider}:${t.email}`,
            provider:       t.provider,
            accountLabel:   'primary',
            email:          t.email,
            scopes,
            tokenExpiresAt: expiresAt.toISOString(),
            services:       deriveServiceStatuses(scopes, tokenHealthy, checkedAt),
          };
        });

      return reply.status(200).send(accounts);
    },
  );

  /**
   * POST /api/connectors/accounts/add
   * Start an OAuth flow to connect an additional account for a provider.
   *
   * This is the multi-account entry point. Each call produces a fresh OAuth
   * URL. If email is supplied it is passed as login_hint so the provider's
   * account picker pre-selects the right account. Re-connecting an existing
   * account (same provider + email) simply refreshes its token — the UNIQUE
   * constraint on (provider, email) handles deduplication via ON CONFLICT DO
   * UPDATE in storeToken.
   *
   * Auth: admin only.
   *
   * Example request:
   *   POST /api/connectors/accounts/add
   *   { "provider": "google", "email": "kevin@starrpartners.ai" }
   *
   * Example response:
   *   { "url": "https://accounts.google.com/o/oauth2/v2/auth?...", "state": "abc123" }
   */
  server.post<{ Body: { provider: string; email?: string } }>(
    '/accounts/add',
    {
      schema: {
        body: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', enum: ['google', 'microsoft', 'linkedin'] },
            email: {
              type: 'string',
              description: 'Optional email hint — pre-selects account in provider picker',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              url:   { type: 'string' },
              state: { type: 'string' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { provider: string; email?: string } }>,
      reply: FastifyReply,
    ) => {
      const provider = request.body.provider as Provider;
      const loginHint: string | undefined = request.body.email;

      // Default to the full suite of services. The caller can connect additional
      // accounts with the same scopes — they are already granted on first connect.
      const services: ServiceName[] = ['mail', 'calendar', 'tasks', 'drive', 'contacts'];

      const envRedirectUri = provider === 'google' ? process.env.GOOGLE_REDIRECT_URI : provider === 'linkedin' ? process.env.LINKEDIN_REDIRECT_URI : process.env.MS365_REDIRECT_URI;
      const redirectUri = envRedirectUri ?? `${getBaseUrl(request)}/api/connectors/oauth/${provider}/callback`;
      const scopes = getScopesForServices(provider, services);
      const config = getOAuthConfig(provider, redirectUri, scopes);

      if (!config.clientId || !config.clientSecret) {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: `${provider} OAuth credentials not configured`,
        });
      }

      const { url, state } = buildAuthUrl(config, services, loginHint);

      try {
        await storeAuthState(state.state, provider, services, state.codeVerifier);
      } catch (err) {
        request.log.error({ err, provider }, 'Failed to store OAuth state for accounts/add');
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Token store not available',
        });
      }

      request.log.info(
        { provider, email: loginHint ?? '(any)', userId: request.auth?.userId },
        'Add-account OAuth flow started',
      );

      return reply.status(200).send({ url, state: state.state });
    },
  );

  /**
   * POST /api/connectors/oauth/configure
   * Store OAuth client credentials for a provider. Called during onboarding
   * before a full user session may exist.
   *
   * Credentials are written to process.env and cached in the module-level
   * oauthClientConfigs map so subsequent OAuth start/callback calls pick
   * them up without a server restart.
   *
   * Example request:
   *   POST /api/connectors/oauth/configure
   *   { "provider": "google", "clientId": "xxx.apps.googleusercontent.com",
   *     "clientSecret": "GOCSPX-..." }
   *
   * Example response:
   *   { "provider": "google", "configured": true }
   */
  server.post<{ Body: OAuthConfigureBody }>(
    '/oauth/configure',
    {
      schema: {
        body: oauthConfigureBodySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              configured: { type: 'boolean' },
            },
          },
        },
      },
      // Called during onboarding — auth may not be fully established yet.
      // Still reads the token if present (authMiddleware allows skipAuth routes
      // through, so request.auth will be populated when a token is provided).
      config: { skipAuth: true },
    },
    async (request: FastifyRequest<{ Body: OAuthConfigureBody }>, reply: FastifyReply) => {
      const { provider, clientId, clientSecret } = request.body;

      // Write to process.env so any in-process code that reads env directly
      // also benefits without a restart.
      if (provider === 'google') {
        process.env.GOOGLE_CLIENT_ID = clientId;
        process.env.GOOGLE_CLIENT_SECRET = clientSecret;
      } else {
        process.env.MS365_CLIENT_ID = clientId;
        process.env.MS365_CLIENT_SECRET = clientSecret;
      }

      // Cache in module-level map for getOAuthConfig()
      oauthClientConfigs.set(provider as Provider, {
        clientId,
        clientSecret,
        configuredAt: new Date(),
      });

      // Persist to Postgres so credentials survive container restarts.
      // Failures are non-fatal — the in-process cache and env vars are already set.
      try {
        const tenantId = 'default';
        if (provider === 'google') {
          await setRuntimeConfig('GOOGLE_CLIENT_ID', clientId, tenantId);
          await setRuntimeConfig('GOOGLE_CLIENT_SECRET', clientSecret, tenantId);
        } else {
          await setRuntimeConfig('MS365_CLIENT_ID', clientId, tenantId);
          await setRuntimeConfig('MS365_CLIENT_SECRET', clientSecret, tenantId);
        }
      } catch (err) {
        request.log.warn({ err, provider }, 'Failed to persist OAuth client config to Postgres — config is active in memory only');
      }

      request.log.info(
        { provider, userId: (request as any).auth?.userId ?? 'onboarding' },
        'OAuth client credentials configured',
      );

      return reply.status(200).send({ provider, configured: true });
    },
  );

  /**
   * POST /api/connectors/oauth/:provider/start
   * Begin an OAuth2 PKCE flow.  Returns the authorization URL for the client
   * to redirect the user to.
   *
   * Example request:
   *   POST /api/connectors/oauth/google/start
   *   { "services": ["mail", "calendar"] }
   *
   * Example response:
   *   { "url": "https://accounts.google.com/o/oauth2/v2/auth?...", "state": "..." }
   */
  server.post<{ Params: { provider: string }; Body: OAuthStartBody }>(
    '/oauth/:provider/start',
    {
      schema: {
        params: providerParamSchema,
        body: oauthStartBodySchema,
      },
      config: { skipAuth: true }, // accessible during onboarding before user is created
    },
    async (
      request: FastifyRequest<{ Params: { provider: string }; Body: OAuthStartBody }>,
      reply: FastifyReply,
    ) => {
      const provider = request.params.provider as Provider;
      const services: ServiceName[] = request.body.services ?? ['mail', 'calendar', 'tasks'];
      const loginHint: string | undefined = request.body.email;

      const envRedirectUri = provider === 'google' ? process.env.GOOGLE_REDIRECT_URI : provider === 'linkedin' ? process.env.LINKEDIN_REDIRECT_URI : process.env.MS365_REDIRECT_URI;
      const redirectUri = envRedirectUri ?? `${getBaseUrl(request)}/api/connectors/oauth/${provider}/callback`;
      const scopes = getScopesForServices(provider, services);
      const config = getOAuthConfig(provider, redirectUri, scopes);

      if (!config.clientId || !config.clientSecret) {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: `${provider} OAuth credentials not configured`,
        });
      }

      // buildAuthUrl generates PKCE internally and returns the full AuthState.
      // loginHint pre-selects the account in the provider's account picker.
      const { url, state } = buildAuthUrl(config, services, loginHint);

      // Persist state + PKCE verifier so the callback can validate
      try {
        await storeAuthState(state.state, provider, services, state.codeVerifier);
      } catch (err) {
        request.log.error({ err, provider }, 'Failed to store OAuth state');
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Token store not available',
        });
      }

      request.log.info(
        { provider, userId: request.auth?.userId, services },
        'OAuth flow started',
      );

      return reply.status(200).send({ url, state: state.state });
    },
  );

  /**
   * GET /api/connectors/oauth/:provider/callback
   * Handle the OAuth provider redirect.  Exchanges the code for tokens,
   * stores them, and returns account details.
   *
   * Called by the provider — no Bearer token in this request.
   *
   * Example success response:
   *   { "provider": "google", "email": "user@gmail.com", "scopes": [...] }
   */
  server.get<{ Params: { provider: string }; Querystring: CallbackQuery }>(
    '/oauth/:provider/callback',
    {
      schema: {
        params: providerParamSchema,
        querystring: callbackQuerySchema,
      },
      config: { skipAuth: true }, // provider redirect carries no Bearer token
    },
    async (
      request: FastifyRequest<{
        Params: { provider: string };
        Querystring: CallbackQuery;
      }>,
      reply: FastifyReply,
    ) => {
      const provider = request.params.provider as Provider;
      const { code, state, error } = request.query;

      if (error) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `OAuth denied: ${request.query.error_description ?? error}`,
        });
      }

      if (!code) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing authorization code',
        });
      }

      // Validate and consume the state (prevents CSRF replay)
      let authState: Awaited<ReturnType<typeof consumeAuthState>>;
      try {
        authState = await consumeAuthState(state);
      } catch (err) {
        request.log.error({ err, state }, 'Failed to consume OAuth state');
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Token store not available',
        });
      }

      if (!authState || authState.provider !== provider) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid or expired OAuth state',
        });
      }

      const envRedirectUri2 = provider === 'google' ? process.env.GOOGLE_REDIRECT_URI : provider === 'linkedin' ? process.env.LINKEDIN_REDIRECT_URI : process.env.MS365_REDIRECT_URI;
      const redirectUri = envRedirectUri2 ?? `${getBaseUrl(request)}/api/connectors/oauth/${provider}/callback`;
      const scopes = getScopesForServices(provider, authState.services);
      const config = getOAuthConfig(provider, redirectUri, scopes);

      let tokenResponse: Awaited<ReturnType<typeof exchangeCode>>;
      try {
        tokenResponse = await exchangeCode(config, code, authState.codeVerifier);
      } catch (err) {
        request.log.error({ err, provider }, 'Token exchange with provider failed');
        return reply.status(502).send({
          error: 'Bad Gateway',
          message: 'Failed to exchange authorization code with provider',
        });
      }

      // Resolve the account email. Google exposes a userinfo endpoint; Microsoft
      // returns an id_token we could decode, but we use the same userinfo pattern
      // for consistency. Fall back to empty string so storeToken never blocks.
      let email = '';
      try {
        if (provider === 'google') {
          const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
          });
          if (userinfoRes.ok) {
            const userinfo = await userinfoRes.json() as { email?: string };
            email = userinfo.email ?? '';
          } else {
            request.log.warn(
              { provider, status: userinfoRes.status },
              'Userinfo request returned non-OK status — email will be empty',
            );
          }
        } else if (provider === 'microsoft') {
          const userinfoRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
            headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
          });
          if (userinfoRes.ok) {
            const profile = await userinfoRes.json() as { mail?: string; userPrincipalName?: string };
            email = profile.mail ?? profile.userPrincipalName ?? '';
          } else {
            request.log.warn(
              { provider, status: userinfoRes.status },
              'Graph /me request returned non-OK status — email will be empty',
            );
          }
        } else if (provider === 'linkedin') {
          // OpenID Connect userinfo (needs openid+email scopes). sub is the
          // member URN id — used as the author for posts.
          const userinfoRes = await fetch('https://api.linkedin.com/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
          });
          if (userinfoRes.ok) {
            const profile = await userinfoRes.json() as { email?: string; name?: string; sub?: string };
            email = profile.email ?? (profile.sub ? `linkedin:${profile.sub}` : '');
          } else {
            request.log.warn(
              { provider, status: userinfoRes.status },
              'LinkedIn userinfo returned non-OK status — email will be empty',
            );
          }
        }
      } catch (err) {
        request.log.warn({ err, provider }, 'Failed to fetch user email from provider — storing token without email');
      }

      // Account ID is derived from provider + email when available, falling back
      // to a scope hash so the token is still stored even without an email.
      const accountId = email
        ? `${provider}-${Buffer.from(email).toString('base64url').slice(0, 24)}`
        : `${provider}-${Buffer.from(tokenResponse.scope ?? '').toString('base64url').slice(0, 12)}-${Date.now()}`;

      await storeToken({
        accountId,
        provider,
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken ?? '',
        expiresAt: new Date(Date.now() + (tokenResponse.expiresIn ?? 3600) * 1000),
        scopes,
      });

      request.log.info({ provider, accountId }, 'OAuth account connected');

      // Redirect back to the dashboard. If user came from onboarding,
      // the onboarding page detects the oauth=success param on its own.
      const uiBase = process.env.BOSS_UI_URL || 'https://last-castle.daggertooth-larch.ts.net/boss/ui/';
      const redirectTo = `${uiBase}#/?oauth=success&provider=${provider}`;
      return reply.redirect(redirectTo);
    },
  );

  /**
   * DELETE /api/connectors/accounts/:provider/:email
   * Remove stored OAuth tokens for a specific account.
   *
   * Example:
   *   DELETE /api/connectors/accounts/google/user%40gmail.com
   *
   * Example response:
   *   { "message": "Account disconnected" }
   */
  server.delete<{ Params: { provider: string; email: string } }>(
    '/accounts/:provider/:email',
    {
      schema: {
        params: disconnectParamSchema,
        response: {
          200: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { provider: string; email: string } }>,
      reply: FastifyReply,
    ) => {
      const provider = request.params.provider as Provider;
      const email = decodeURIComponent(request.params.email);

      try {
        await deleteToken(provider, email);
      } catch (err) {
        request.log.error({ err, provider, email }, 'Failed to delete token');
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Token store not available',
        });
      }

      request.log.info({ provider, email, userId: request.auth?.userId }, 'Account disconnected');
      return reply.status(200).send({ message: 'Account disconnected' });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Proxy endpoints for integration workspace views
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/connectors/n8n/workflows
   * Proxy to the n8n API, returns a list of workflows.
   */
  server.get(
    '/n8n/workflows',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const n8nKey = process.env.N8N_API_KEY;
      if (!n8nKey) {
        return reply.status(503).send({ error: 'N8N_API_KEY not configured' });
      }
      const n8nBase = (process.env.N8N_BASE_URL ?? 'http://127.0.0.1:7749').replace(/\/$/, '');
      try {
        // Paginate through all workflows — n8n defaults to 100 per page
        const allWorkflows: unknown[] = [];
        let cursor: string | undefined;

        while (true) {
          const params = new URLSearchParams({ limit: '250' });
          if (cursor) params.set('cursor', cursor);

          const res = await fetch(`${n8nBase}/api/v1/workflows?${params}`, {
            headers: {
              'X-N8N-API-KEY': n8nKey,
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return reply.status(res.status).send({ error: `n8n API error: ${text.substring(0, 300)}` });
          }
          const body = await res.json() as { data?: unknown[]; nextCursor?: string };
          allWorkflows.push(...(body.data ?? []));

          if (!body.nextCursor) break;
          cursor = body.nextCursor;
        }

        return reply.status(200).send(allWorkflows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'n8n proxy error');
        return reply.status(502).send({ error: `Cannot reach n8n: ${msg}` });
      }
    },
  );

  /**
   * POST /api/connectors/n8n/workflows/:id/run
   * Trigger execution of an n8n workflow.
   */
  server.post<{ Params: { id: string } }>(
    '/n8n/workflows/:id/run',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const n8nKey = process.env.N8N_API_KEY;
      if (!n8nKey) {
        return reply.status(503).send({ error: 'N8N_API_KEY not configured' });
      }
      const n8nBase = (process.env.N8N_BASE_URL ?? 'http://127.0.0.1:7749').replace(/\/$/, '');
      const workflowId = request.params.id;
      try {
        const res = await fetch(`${n8nBase}/api/v1/workflows/${encodeURIComponent(workflowId)}/run`, {
          method: 'POST',
          headers: {
            'X-N8N-API-KEY': n8nKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return reply.status(res.status).send({ error: `n8n run error: ${text.substring(0, 300)}` });
        }
        const body = await res.json();
        return reply.status(200).send(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'n8n run proxy error');
        return reply.status(502).send({ error: `Cannot reach n8n: ${msg}` });
      }
    },
  );

  /**
   * GET /api/connectors/airtable/bases
   * Returns all accessible bases with their table metadata.
   */
  server.get(
    '/airtable/bases',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const atKey = process.env.AIRTABLE_API_KEY;
      if (!atKey) {
        return reply.status(503).send({ error: 'AIRTABLE_API_KEY not configured' });
      }
      const AT_BASE = 'https://api.airtable.com/v0';
      const headers = { Authorization: `Bearer ${atKey}`, 'Content-Type': 'application/json' };

      try {
        // Get bases
        const basesRes = await fetch(`${AT_BASE}/meta/bases`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!basesRes.ok) {
          const text = await basesRes.text().catch(() => '');
          return reply.status(basesRes.status).send({ error: `Airtable API error: ${text.substring(0, 300)}` });
        }
        const basesData = await basesRes.json() as {
          bases: Array<{ id: string; name: string; permissionLevel: string }>;
        };
        const bases = basesData.bases ?? [];

        // For each base, get tables (in parallel with a concurrency limit)
        const results = await Promise.all(
          bases.map(async (base) => {
            try {
              const tablesRes = await fetch(`${AT_BASE}/meta/bases/${base.id}/tables`, {
                headers,
                signal: AbortSignal.timeout(15_000),
              });
              if (!tablesRes.ok) {
                return { ...base, tables: [], error: `HTTP ${tablesRes.status}` };
              }
              const tablesData = await tablesRes.json() as {
                tables: Array<{ id: string; name: string; fields?: Array<{ id: string; name: string; type: string }> }>;
              };
              return { ...base, tables: tablesData.tables ?? [] };
            } catch (err) {
              return { ...base, tables: [], error: err instanceof Error ? err.message : String(err) };
            }
          }),
        );

        return reply.status(200).send(results);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'Airtable bases proxy error');
        return reply.status(502).send({ error: `Airtable error: ${msg}` });
      }
    },
  );

  /**
   * GET /api/connectors/airtable/bases/:baseId/tables/:tableName
   * Returns records from a specific Airtable table.
   */
  server.get<{ Params: { baseId: string; tableName: string }; Querystring: { maxRecords?: string } }>(
    '/airtable/bases/:baseId/tables/:tableName',
    async (
      request: FastifyRequest<{ Params: { baseId: string; tableName: string }; Querystring: { maxRecords?: string } }>,
      reply: FastifyReply,
    ) => {
      const atKey = process.env.AIRTABLE_API_KEY;
      if (!atKey) {
        return reply.status(503).send({ error: 'AIRTABLE_API_KEY not configured' });
      }
      const AT_BASE = 'https://api.airtable.com/v0';
      const { baseId, tableName } = request.params;
      const maxRecords = Math.min(Math.max(Number(request.query.maxRecords ?? '100'), 1), 100);

      try {
        const encodedTable = encodeURIComponent(tableName);
        const res = await fetch(
          `${AT_BASE}/${encodeURIComponent(baseId)}/${encodedTable}?maxRecords=${maxRecords}`,
          {
            headers: { Authorization: `Bearer ${atKey}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return reply.status(res.status).send({ error: `Airtable API error: ${text.substring(0, 300)}` });
        }
        const body = await res.json();
        return reply.status(200).send(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'Airtable records proxy error');
        return reply.status(502).send({ error: `Airtable error: ${msg}` });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Slack approved channels management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/connectors/slack/channels
   * Returns the approved Slack channel list. Empty array means all channels allowed.
   */
  server.get('/slack/channels', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const tenantId = 'default';
      const value = await getRuntimeConfig('SLACK_APPROVED_CHANNELS', tenantId);
      const channels = value ? JSON.parse(value) : [];
      return reply.status(200).send({ channels });
    } catch {
      return reply.status(200).send({ channels: [] });
    }
  });

  /**
   * PUT /api/connectors/slack/channels
   * Set the approved Slack channel list. Pass channel names or IDs.
   * Empty array = allow all channels.
   *
   * Example: { "channels": ["#general", "#boss-alerts", "C04ABCD1234"] }
   */
  server.put<{ Body: { channels: string[] } }>(
    '/slack/channels',
    {
      schema: {
        body: {
          type: 'object',
          required: ['channels'],
          properties: {
            channels: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { channels: string[] } }>, reply: FastifyReply) => {
      const role = request.auth?.role;
      if (role && role !== 'admin' && role !== 'owner') {
        return reply.status(403).send({ error: 'Admin only' });
      }

      const { channels } = request.body;
      const tenantId = 'default';
      await setRuntimeConfig('SLACK_APPROVED_CHANNELS', JSON.stringify(channels), tenantId);

      request.log.info({ channels, userId: request.auth?.userId }, 'Slack approved channels updated');
      return reply.status(200).send({ status: 'ok', channels });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // QuickBooks Online OAuth + Connection Management
  //
  // Token lifecycle (rotating refresh tokens, runtime_config persistence)
  // lives in tools/quickbooks-auth.ts. Intuit's callback carries a realmId
  // query param identifying the connected company — it is stored alongside
  // the tokens and required on every API call.
  //
  // SECURITY: states are only minted on the AUTHENTICATED /quickbooks/connect
  // route (deliberately outside the public /oauth prefix). The callback must
  // stay public for Intuit to reach it, so a valid state is the authorization
  // bearer — without this, any anonymous caller could complete the flow with
  // their own Intuit account and silently rebind the books.
  // ─────────────────────────────────────────────────────────────────────────────

  const qboPendingStates = new Map<string, number>();
  // 30 min: the authorize URL is handed to a human (often via chat) who may
  // not click immediately; still short enough that a leaked state is useless.
  const QBO_STATE_TTL_MS = 30 * 60_000;

  /**
   * GET /api/connectors/quickbooks/connect
   * Returns the Intuit authorize URL to open in a browser. Auth required
   * (admin/owner — rebinding the accounting connection is an admin action);
   * NOT under /oauth so the auth middleware's public-path list doesn't apply.
   */
  server.get('/quickbooks/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!qboConfigured()) {
      return reply.status(503).send({ error: 'QuickBooks not configured — set QB_CLIENT_ID and QB_CLIENT_SECRET' });
    }

    // Admin-only guard (same convention as POST /configure)
    const role = request.auth?.role;
    if (role && role !== 'admin' && role !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only admin users can connect QuickBooks',
      });
    }

    // Prune expired states so the map can't grow unbounded
    const now = Date.now();
    for (const [st, issued] of qboPendingStates) {
      if (now - issued > QBO_STATE_TTL_MS) qboPendingStates.delete(st);
    }

    const state = crypto.randomBytes(16).toString('hex');
    qboPendingStates.set(state, now);

    const url = `${QBO_AUTHORIZE_ENDPOINT}?${new URLSearchParams({
      client_id: process.env.QB_CLIENT_ID!,
      response_type: 'code',
      scope: QBO_SCOPE,
      redirect_uri: qboRedirectUri(),
      state,
    })}`;

    return reply.status(200).send({ url, state });
  });

  server.get('/oauth/quickbooks/callback', {
    config: { skipAuth: true },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { code, state, realmId, error: oauthError } = request.query as Record<string, string>;

    if (oauthError || !code || !realmId) {
      request.log.warn({ oauthError, hasCode: !!code, hasRealm: !!realmId }, 'QuickBooks OAuth callback rejected');
      return reply.redirect('/boss/ui/#/?oauth=error&provider=quickbooks');
    }

    const issued = state ? qboPendingStates.get(state) : undefined;
    qboPendingStates.delete(state ?? '');
    if (issued === undefined || Date.now() - issued > QBO_STATE_TTL_MS) {
      request.log.warn('QuickBooks OAuth callback: unknown or expired state');
      return reply.redirect('/boss/ui/#/?oauth=error&provider=quickbooks');
    }

    try {
      // Surface company rebinds loudly — a realm change means the books the
      // brain reads just switched to a different QuickBooks company.
      const previousRealm = await getRuntimeConfig('QB_REALM_ID', 'default');
      if (previousRealm && previousRealm !== realmId) {
        request.log.warn({ previousRealm, realmId }, 'QuickBooks connection rebound to a DIFFERENT company');
      }
      const tokens = await exchangeQboCode(code);
      await storeQboTokens(tokens, realmId);
      request.log.info({ realmId }, 'QuickBooks OAuth connected');
      return reply.redirect('/boss/ui/#/?oauth=success&provider=quickbooks');
    } catch (err) {
      request.log.error({ err }, 'QuickBooks OAuth callback error');
      return reply.redirect('/boss/ui/#/?oauth=error&provider=quickbooks');
    }
  });

  /**
   * GET /api/connectors/quickbooks/status
   * Reports whether QuickBooks is configured (app credentials present) and
   * connected (refresh token + realm ID stored).
   */
  server.get('/quickbooks/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const configured = qboConfigured();
    const connected = configured && (await qboConnected());
    const realmId = connected ? await getRuntimeConfig('QB_REALM_ID', 'default') : null;
    return reply.send({
      configured,
      connected,
      environment: process.env.QB_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      ...(realmId ? { realmId } : {}),
    });
  });

  /**
   * GET /api/connectors/quickbooks/financial-snapshot
   * Structured financial numbers from the books (bank balances, P&L MTD,
   * open AR). boss_financial_reason imports the function directly; this REST
   * surface serves any other stack. The BOS API is the only holder of the
   * rotating Intuit tokens.
   * Auth required (internal callers use trusted-IP + X-BOSS-Internal).
   */
  server.get('/quickbooks/financial-snapshot', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!qboConfigured() || !(await qboConnected())) {
      return reply.status(503).send({ error: 'QuickBooks not connected' });
    }
    try {
      const snapshot = await getQboFinancialSnapshot();
      return reply.status(200).send(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }
  });

  /**
   * POST /api/connectors/quickbooks/disconnect
   * Revokes the connection at Intuit (best-effort) and clears stored tokens.
   * Admin-only — this requires a full OAuth redo to recover.
   */
  server.post('/quickbooks/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
    const role = request.auth?.role;
    if (role && role !== 'admin' && role !== 'owner') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only admin users can disconnect QuickBooks',
      });
    }
    await disconnectQbo();
    request.log.info({ userId: request.auth?.userId }, 'QuickBooks disconnected');
    return reply.status(200).send({ status: 'ok', connected: false });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Spotify OAuth + Token Management
  // ─────────────────────────────────────────────────────────────────────────────

  server.get('/oauth/spotify/start', {
    config: { skipAuth: true },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return reply.status(503).send({ error: 'Spotify not configured' });
    }

    const scopes = [
      'streaming',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'user-read-email',
      'user-read-private',
      'user-library-read',
      'user-library-modify',
      'user-read-recently-played',
      'user-top-read',
      'playlist-read-private',
      'playlist-read-collaborative',
      'playlist-modify-public',
      'playlist-modify-private',
    ].join(' ');

    const state = crypto.randomBytes(16).toString('hex');
    const url = `https://accounts.spotify.com/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
      show_dialog: 'true',
    })}`;

    return reply.status(200).send({ url, state });
  });

  server.get('/oauth/spotify/callback', {
    config: { skipAuth: true },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { code, error: oauthError } = request.query as Record<string, string>;

    if (oauthError || !code) {
      return reply.redirect('/boss/ui/#/?oauth=error&provider=spotify');
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID!;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI!;

    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });

      if (!tokenRes.ok) {
        request.log.error({ status: tokenRes.status }, 'Spotify token exchange failed');
        return reply.redirect('/boss/ui/#/?oauth=error&provider=spotify');
      }

      const tokenData = await tokenRes.json() as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
      };

      // Store tokens
      const tenantId = 'default';
      await setRuntimeConfig('SPOTIFY_ACCESS_TOKEN', tokenData.access_token, tenantId);
      await setRuntimeConfig('SPOTIFY_REFRESH_TOKEN', tokenData.refresh_token, tenantId);
      await setRuntimeConfig('SPOTIFY_TOKEN_EXPIRES', String(Date.now() + tokenData.expires_in * 1000), tenantId);

      request.log.info('Spotify OAuth connected');
      return reply.redirect('/boss/ui/#/?oauth=success&provider=spotify');
    } catch (err) {
      request.log.error({ err }, 'Spotify OAuth callback error');
      return reply.redirect('/boss/ui/#/?oauth=error&provider=spotify');
    }
  });

  /**
   * GET /api/connectors/spotify/token
   * Returns a fresh Spotify access token for the Web Playback SDK.
   * Auto-refreshes if expired.
   */
  server.get('/spotify/token', async (_request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = 'default';
    let accessToken = await getRuntimeConfig('SPOTIFY_ACCESS_TOKEN', tenantId);
    const refreshToken = await getRuntimeConfig('SPOTIFY_REFRESH_TOKEN', tenantId);
    const expiresStr = await getRuntimeConfig('SPOTIFY_TOKEN_EXPIRES', tenantId);

    if (!accessToken || !refreshToken) {
      return reply.status(401).send({ error: 'Spotify not connected. Start OAuth flow first.' });
    }

    // Refresh if expired or expiring in next 60 seconds
    const expires = parseInt(expiresStr || '0', 10);
    if (Date.now() > expires - 60_000) {
      const clientId = process.env.SPOTIFY_CLIENT_ID!;
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

      const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });

      if (refreshRes.ok) {
        const data = await refreshRes.json() as { access_token: string; expires_in: number };
        accessToken = data.access_token;
        await setRuntimeConfig('SPOTIFY_ACCESS_TOKEN', accessToken, tenantId);
        await setRuntimeConfig('SPOTIFY_TOKEN_EXPIRES', String(Date.now() + data.expires_in * 1000), tenantId);
      } else {
        return reply.status(401).send({ error: 'Spotify token refresh failed' });
      }
    }

    return reply.status(200).send({ accessToken });
  });

  /**
   * POST /api/connectors/spotify/playback
   * Control Spotify playback: play, pause, next, previous
   */
  server.post<{ Body: { action: string; uri?: string } }>('/spotify/playback', {
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'shuffle', 'transfer'] },
          uri: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: { action: string; uri?: string } }>, reply: FastifyReply) => {
    const tenantId = 'default';
    let accessToken = await getRuntimeConfig('SPOTIFY_ACCESS_TOKEN', tenantId);
    if (!accessToken) return reply.status(401).send({ error: 'Spotify not connected' });

    // Refresh if needed
    const expiresStr = await getRuntimeConfig('SPOTIFY_TOKEN_EXPIRES', tenantId);
    if (Date.now() > parseInt(expiresStr || '0', 10) - 60_000) {
      const tokenRes = await fetch(`http://127.0.0.1:${process.env.PORT || 8010}/api/connectors/spotify/token`, {
        headers: { 'X-BOSS-Internal': 'true' },
      });
      if (tokenRes.ok) {
        const data = await tokenRes.json() as { accessToken: string };
        accessToken = data.accessToken;
      }
    }

    const headers = { Authorization: `Bearer ${accessToken}` };
    const { action, uri } = request.body;
    let url: string;
    let method = 'PUT';

    const getPlaybackDeviceId = async (): Promise<string | null> => {
      const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', { headers });
      if (!devRes.ok) return null;
      const devData = await devRes.json() as {
        devices: Array<{ id: string; is_active: boolean }>;
      };
      const active = devData.devices.find((d) => d.is_active);
      if (active?.id) return active.id;
      const fallback = devData.devices.find((d) => d.id);
      if (!fallback?.id) return null;
      await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [fallback.id], play: false }),
      });
      await new Promise((r) => setTimeout(r, 350));
      return fallback.id;
    };

    const withDeviceId = (baseUrl: string, deviceId: string | null): string => {
      if (!deviceId) return baseUrl;
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}device_id=${encodeURIComponent(deviceId)}`;
    };

    switch (action) {
      case 'play':
        url = 'https://api.spotify.com/v1/me/player/play';
        break;
      case 'pause':
        url = 'https://api.spotify.com/v1/me/player/pause';
        break;
      case 'next':
        url = 'https://api.spotify.com/v1/me/player/next';
        method = 'POST';
        break;
      case 'previous':
        url = 'https://api.spotify.com/v1/me/player/previous';
        method = 'POST';
        break;
      case 'shuffle':
        url = 'https://api.spotify.com/v1/me/player/shuffle?state=true';
        method = 'PUT';
        break;
      case 'transfer': {
        // Transfer playback to a device
        const deviceId = uri; // reuse uri field for device_id
        if (!deviceId) return reply.status(400).send({ error: 'uri (device_id) required for transfer' });
        const txRes = await fetch('https://api.spotify.com/v1/me/player', {
          method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_ids: [deviceId], play: true }),
        });
        return reply.status(txRes.status === 204 || txRes.ok ? 200 : txRes.status).send({ status: 'ok', action: 'transfer' });
      }
      default:
        return reply.status(400).send({ error: `Unknown action: ${action}` });
    }

    const deviceId = ['play', 'pause', 'next', 'previous'].includes(action)
      ? await getPlaybackDeviceId()
      : null;
    if (['play', 'pause', 'next', 'previous'].includes(action) && !deviceId) {
      return reply.status(404).send({ error: 'No Spotify device available' });
    }
    url = withDeviceId(url, deviceId);

    // For play with a URI, send either a context URI or a single track URI.
    // Plain play with no body resumes the current paused playback.
    let playBody: string | undefined;
    if (action === 'play' && uri) {
      playBody = uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:')
        ? JSON.stringify({ uris: [uri] })
        : JSON.stringify({ context_uri: uri });
    }
    const res = await fetch(url, {
      method,
      headers: playBody ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(playBody ? { body: playBody } : {}),
    });

    if (res.status === 204 || res.ok) {
      return reply.status(200).send({ status: 'ok', action });
    }

    const err = await res.text().catch(() => '');
    return reply.status(res.status).send({ error: err.slice(0, 200) });
  });

  /**
   * Internal helper: fresh Spotify access token with auto-refresh.
   * Returns null if not connected or refresh failed.
   */
  async function getSpotifyAccessToken(): Promise<string | null> {
    const tenantId = 'default';
    const accessToken = await getRuntimeConfig('SPOTIFY_ACCESS_TOKEN', tenantId);
    const refreshToken = await getRuntimeConfig('SPOTIFY_REFRESH_TOKEN', tenantId);
    const expiresStr = await getRuntimeConfig('SPOTIFY_TOKEN_EXPIRES', tenantId);
    if (!accessToken || !refreshToken) return null;

    const expires = parseInt(expiresStr || '0', 10);
    if (Date.now() <= expires - 60_000) return accessToken;

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!refreshRes.ok) return null;
    const data = await refreshRes.json() as { access_token: string; expires_in: number };
    await setRuntimeConfig('SPOTIFY_ACCESS_TOKEN', data.access_token, tenantId);
    await setRuntimeConfig('SPOTIFY_TOKEN_EXPIRES', String(Date.now() + data.expires_in * 1000), tenantId);
    return data.access_token;
  }

  /**
   * GET /api/connectors/spotify/status
   * Reports whether Spotify is configured (env vars present) and connected (tokens stored).
   */
  server.get('/spotify/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const configured = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET && process.env.SPOTIFY_REDIRECT_URI);
    const tenantId = 'default';
    const hasRefresh = !!(await getRuntimeConfig('SPOTIFY_REFRESH_TOKEN', tenantId));
    return reply.send({ configured, connected: configured && hasRefresh });
  });

  /**
   * GET /api/connectors/spotify/playlists
   * Returns the authenticated user's playlists (name, id, image, uri).
   */
  server.get('/spotify/playlists', async (_request: FastifyRequest, reply: FastifyReply) => {
    const token = await getSpotifyAccessToken();
    if (!token) return reply.status(401).send({ error: 'Spotify not connected' });

    const items: Array<{ id: string; name: string; uri: string; image: string | null; owner: string; trackCount: number }> = [];
    let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';
    while (url) {
      const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        return reply.status(r.status).send({ error: errText.slice(0, 200) });
      }
      const data = await r.json() as {
        items: Array<{
          id?: string;
          name?: string;
          uri?: string;
          images?: Array<{ url: string }> | null;
          owner?: { display_name?: string | null } | null;
          tracks?: { total?: number } | null;
        } | null>;
        next: string | null;
      };
      for (const p of data.items) {
        if (!p?.id || !p.uri) continue;
        items.push({
          id: p.id,
          name: p.name ?? '(untitled)',
          uri: p.uri,
          image: p.images?.[0]?.url ?? null,
          owner: p.owner?.display_name ?? '',
          trackCount: p.tracks?.total ?? 0,
        });
      }
      url = data.next;
      if (items.length >= 200) break;
    }
    return reply.send({ playlists: items });
  });

  /**
   * GET /api/connectors/spotify/current
   * Returns currently playing context (or last) — used to default the embed
   * to whatever the user was last listening to on any device.
   */
  server.get('/spotify/current', async (_request: FastifyRequest, reply: FastifyReply) => {
    const token = await getSpotifyAccessToken();
    if (!token) return reply.status(401).send({ error: 'Spotify not connected' });

    // Try current playback first
    const cur = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (cur.status === 200) {
      const data = await cur.json() as {
        is_playing: boolean;
        context: { uri: string; type: string } | null;
        item: { uri: string; name: string; album?: { uri: string; name: string }; artists?: Array<{ name: string }> } | null;
        device: { name: string; type: string } | null;
      };
      const uri = data.context?.uri ?? data.item?.album?.uri ?? data.item?.uri ?? null;
      if (uri) {
        return reply.send({
          uri,
          source: 'current',
          isPlaying: data.is_playing,
          itemName: data.item?.name ?? null,
          itemArtist: data.item?.artists?.[0]?.name ?? null,
          contextType: data.context?.type ?? null,
          deviceName: data.device?.name ?? null,
        });
      }
    }

    // Fallback to recently played
    const rec = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rec.ok) {
      return reply.status(rec.status).send({ error: 'no recent playback' });
    }
    const data = await rec.json() as {
      items: Array<{
        track: { uri: string; name: string; album?: { uri: string; name: string }; artists?: Array<{ name: string }> };
        context: { uri: string; type: string } | null;
        played_at: string;
      }>;
    };
    const last = data.items[0];
    if (!last) return reply.status(204).send();
    const uri = last.context?.uri ?? last.track.album?.uri ?? last.track.uri;
    return reply.send({
      uri,
      source: 'recent',
      isPlaying: false,
      itemName: last.track.name,
      itemArtist: last.track.artists?.[0]?.name ?? null,
      contextType: last.context?.type ?? 'track',
      deviceName: null,
      playedAt: last.played_at,
    });
  });

  /**
   * GET /api/connectors/spotify/now-playing
   * Live state across any device — the dock polls this every few seconds.
   * Falls back to recently-played if nothing is currently playing.
   */
  server.get('/spotify/now-playing', async (_request: FastifyRequest, reply: FastifyReply) => {
    const token = await getSpotifyAccessToken();
    if (!token) return reply.status(401).send({ error: 'Spotify not connected' });

    const cur = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (cur.status === 200) {
      const d = await cur.json() as {
        is_playing: boolean;
        progress_ms: number | null;
        timestamp: number;
        shuffle_state: boolean;
        repeat_state: string;
        context: { uri: string; type: string } | null;
        item: {
          uri: string;
          name: string;
          duration_ms: number;
          album: { uri: string; name: string; images?: Array<{ url: string; width: number; height: number }> };
          artists: Array<{ name: string }>;
        } | null;
        device: { id: string; name: string; type: string; volume_percent: number; is_active: boolean } | null;
      };
      return reply.send({
        source: 'current',
        isPlaying: d.is_playing,
        progressMs: d.progress_ms,
        timestamp: d.timestamp,
        shuffle: d.shuffle_state,
        repeat: d.repeat_state,
        context: d.context,
        track: d.item ? {
          uri: d.item.uri,
          name: d.item.name,
          durationMs: d.item.duration_ms,
          albumName: d.item.album.name,
          albumUri: d.item.album.uri,
          image: d.item.album.images?.[0]?.url ?? null,
          artists: d.item.artists.map((a) => a.name),
        } : null,
        device: d.device ? {
          id: d.device.id,
          name: d.device.name,
          type: d.device.type,
          volume: d.device.volume_percent,
          isActive: d.device.is_active,
        } : null,
      });
    }

    // Nothing currently playing → return last played track so the dock
    // shows context. Pressing play with this URI will resume.
    const rec = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rec.ok) return reply.status(204).send();
    const data = await rec.json() as {
      items: Array<{
        track: {
          uri: string; name: string; duration_ms: number;
          album: { uri: string; name: string; images?: Array<{ url: string }> };
          artists: Array<{ name: string }>;
        };
        context: { uri: string; type: string } | null;
        played_at: string;
      }>;
    };
    const last = data.items[0];
    if (!last) return reply.status(204).send();
    return reply.send({
      source: 'recent',
      isPlaying: false,
      progressMs: 0,
      timestamp: Date.parse(last.played_at),
      shuffle: false,
      repeat: 'off',
      context: last.context,
      track: {
        uri: last.track.uri,
        name: last.track.name,
        durationMs: last.track.duration_ms,
        albumName: last.track.album.name,
        albumUri: last.track.album.uri,
        image: last.track.album.images?.[0]?.url ?? null,
        artists: last.track.artists.map((a) => a.name),
      },
      device: null,
    });
  });

  /**
   * GET /api/connectors/automations/status
   * Aggregator for the Dashboard AutomationsCard. Hits each automation
   * platform's API in parallel and returns the workflow / scenario
   * total + active counts. Designed to be called once on Dashboard
   * load — keeps the frontend free of per-platform fetch logic and
   * keeps API keys server-side only.
   *
   * Response shape:
   *   {
   *     n8n:  { configured: bool, status: { total, active } | null, error: string | null },
   *     make: { configured: bool, status: { total, active } | null, error: string | null },
   *   }
   *
   * `configured` reflects whether the env vars are present. `status`
   * is null when either not configured or the upstream call failed
   * (in which case `error` carries the reason). The frontend renders
   * "not configured" / "—" / real numbers based on that triple.
   *
   * v1.5.14 — first slice of the AutomationsCard real-data wiring.
   * Make currently requires both MAKE_API_KEY + MAKE_BASE_URL since
   * Make's region-prefixed hostname (e.g., us1/eu1.make.com) varies
   * per workspace.
   */
  server.get(
    '/automations/status',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      type PlatformStatus = {
        configured: boolean;
        status: { total: number; active: number } | null;
        error: string | null;
      };

      const fetchN8n = async (): Promise<PlatformStatus> => {
        const key = process.env.N8N_API_KEY;
        if (!key) return { configured: false, status: null, error: null };
        const base = (process.env.N8N_BASE_URL ?? 'http://127.0.0.1:7749').replace(/\/$/, '');
        try {
          const res = await fetch(`${base}/api/v1/workflows?limit=250`, {
            headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) {
            return { configured: true, status: null, error: `n8n HTTP ${res.status}` };
          }
          const body = (await res.json()) as { data?: Array<{ active?: boolean }> };
          const list = Array.isArray(body.data) ? body.data : [];
          return {
            configured: true,
            status: {
              total: list.length,
              active: list.filter((w) => w.active === true).length,
            },
            error: null,
          };
        } catch (err) {
          return {
            configured: true,
            status: null,
            error: err instanceof Error ? err.message : 'unreachable',
          };
        }
      };

      const fetchMake = async (): Promise<PlatformStatus> => {
        const key = process.env.MAKE_API_KEY;
        const base = process.env.MAKE_BASE_URL;
        if (!key || !base) return { configured: false, status: null, error: null };
        // Make's /api/v2/scenarios requires teamId OR organizationId.
        // We accept either MAKE_TEAM_ID or MAKE_ORG_ID; org is the
        // common case for self-managed workspaces.
        const orgId = process.env.MAKE_ORG_ID;
        const teamId = process.env.MAKE_TEAM_ID;
        if (!orgId && !teamId) {
          return {
            configured: true,
            status: null,
            error: 'MAKE_ORG_ID or MAKE_TEAM_ID required',
          };
        }
        const params = new URLSearchParams();
        if (orgId) params.set('organizationId', orgId);
        if (teamId) params.set('teamId', teamId);
        try {
          const url = `${base.replace(/\/$/, '')}/api/v2/scenarios?${params}`;
          const res = await fetch(url, {
            headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) {
            return { configured: true, status: null, error: `make HTTP ${res.status}` };
          }
          const body = (await res.json()) as {
            scenarios?: Array<{ isActive?: boolean; active?: boolean }>;
          };
          const list = Array.isArray(body.scenarios) ? body.scenarios : [];
          return {
            configured: true,
            status: {
              total: list.length,
              active: list.filter((s) => s.isActive === true || s.active === true).length,
            },
            error: null,
          };
        } catch (err) {
          return {
            configured: true,
            status: null,
            error: err instanceof Error ? err.message : 'unreachable',
          };
        }
      };

      const [n8n, make] = await Promise.all([fetchN8n(), fetchMake()]);
      return reply.send({ n8n, make });
    },
  );

  /**
   * GET /api/connectors/spotify/devices
   * List available Spotify Connect devices (camelCase shape).
   */
  server.get('/spotify/devices', async (_request: FastifyRequest, reply: FastifyReply) => {
    const token = await getSpotifyAccessToken();
    if (!token) return reply.status(401).send({ error: 'Spotify not connected' });
    const r = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return reply.status(r.status).send({ error: 'Failed to get devices' });
    const data = await r.json() as {
      devices: Array<{ id: string; name: string; type: string; is_active: boolean; volume_percent: number }>;
    };
    return reply.send({
      devices: data.devices.map((d) => ({
        id: d.id, name: d.name, type: d.type, isActive: d.is_active, volume: d.volume_percent,
      })),
    });
  });
}

/**
 * MCP OAuth 2.1 client — the PKCE flow for remote MCP servers.
 *
 * Remote MCP servers (Mygentic Connect, Notion, Linear, …) do not accept a
 * plain API key. They speak OAuth 2.1 with PKCE, and they advertise their
 * endpoints through two discovery documents:
 *
 *   RFC 9728  /.well-known/oauth-protected-resource   → names the auth server
 *   RFC 8414  /.well-known/oauth-authorization-server → the endpoints
 *
 * Most MCP servers also support RFC 7591 dynamic client registration, so we
 * never need a client_id provisioned by hand.
 *
 * This module is transport-only: it discovers, registers, builds authorize
 * URLs, and exchanges codes. It does NOT store anything — persistence lives in
 * mcp-registry.ts, and the resulting tokens are handed to an Anthropic vault
 * (see managed-agent.ts) which owns refresh from then on.
 */

import crypto from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  /** RFC 8707 resource indicator — the MCP server's canonical URI. */
  resource?: string;
  /** True when the endpoints were guessed rather than discovered. */
  guessed: boolean;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry, ISO 8601. Undefined when the server sends no expires_in. */
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

const FETCH_TIMEOUT_MS = 15_000;

// ── Small helpers ────────────────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

function asStringArray(obj: unknown, key: string): string[] | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const value = (obj as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length ? out : undefined;
}

/**
 * Build the well-known URL for a resource per RFC 9728 §3.1: the well-known
 * segment is inserted after the host, and the resource's path is appended.
 * `https://mcp.example.com/mcp` → `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`
 */
function wellKnownUrl(serverUrl: string, suffix: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const candidates = [`${url.origin}/.well-known/${suffix}${path}`];
  // Servers that ignore the path-aware form still answer at the bare origin.
  if (path) candidates.push(`${url.origin}/.well-known/${suffix}`);
  return candidates;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover the OAuth endpoints protecting an MCP server.
 *
 * Falls back to the conventional `/authorize` + `/token` paths on the server's
 * own origin when the server publishes no metadata — several MCP servers in the
 * wild skip discovery entirely. `guessed` records which path we took so callers
 * can surface a clearer error if the flow later fails.
 */
export async function discoverOAuth(serverUrl: string): Promise<OAuthEndpoints> {
  let asMetadataUrls: string[] = [];
  let resource: string | undefined;

  // Step 1 — protected resource metadata names the authorization server(s).
  for (const candidate of wellKnownUrl(serverUrl, 'oauth-protected-resource')) {
    const prm = await fetchJson(candidate);
    if (!prm) continue;
    resource = asString(prm, 'resource') ?? serverUrl;
    const servers = asStringArray(prm, 'authorization_servers');
    if (servers?.length) {
      asMetadataUrls = servers.flatMap((issuer) => [
        ...wellKnownUrl(issuer, 'oauth-authorization-server'),
        ...wellKnownUrl(issuer, 'openid-configuration'),
      ]);
    }
    break;
  }

  // Step 2 — no resource metadata? Try the MCP server's own origin as issuer.
  if (!asMetadataUrls.length) {
    asMetadataUrls = [
      ...wellKnownUrl(serverUrl, 'oauth-authorization-server'),
      ...wellKnownUrl(serverUrl, 'openid-configuration'),
    ];
  }

  for (const candidate of asMetadataUrls) {
    const meta = await fetchJson(candidate);
    if (!meta) continue;
    const authorizationEndpoint = asString(meta, 'authorization_endpoint');
    const tokenEndpoint = asString(meta, 'token_endpoint');
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    return {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: asString(meta, 'registration_endpoint'),
      scopesSupported: asStringArray(meta, 'scopes_supported'),
      resource: resource ?? serverUrl,
      guessed: false,
    };
  }

  // Step 3 — conventional fallback.
  const origin = new URL(serverUrl).origin;
  return {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
    resource: resource ?? serverUrl,
    guessed: true,
  };
}

// ── Dynamic client registration (RFC 7591) ───────────────────────────────────

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<RegisteredClient | null> {
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  const registered = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const clientId = asString(registered, 'client_id');
  if (!clientId) return null;
  return { clientId, clientSecret: asString(registered, 'client_secret') };
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce(): Pkce {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64url(crypto.randomBytes(24));
}

// ── Authorize + token exchange ───────────────────────────────────────────────

export function buildAuthorizeUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.scope) url.searchParams.set('scope', params.scope);
  // RFC 8707 — tells the AS which resource the token is for. MCP servers that
  // implement it reject tokens minted without it.
  if (params.resource) url.searchParams.set('resource', params.resource);
  return url.toString();
}

/**
 * Exchange an authorization code for tokens. Throws with the provider's own
 * error text on failure so the callback page can show something actionable.
 */
export async function exchangeCode(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
}): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  if (params.resource) form.set('resource', params.resource);

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (params.clientSecret) {
    const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(params.tokenEndpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token endpoint returned HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }

  const accessToken = asString(payload, 'access_token');
  if (!accessToken) throw new Error('token response contained no access_token');

  const expiresIn = (payload as Record<string, unknown>).expires_in;
  const expiresAt =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : undefined;

  return {
    accessToken,
    refreshToken: asString(payload, 'refresh_token'),
    expiresAt,
    scope: asString(payload, 'scope'),
    tokenType: asString(payload, 'token_type'),
  };
}

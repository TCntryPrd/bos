/**
 * Shared OAuth2 flow -- works for both Microsoft and Google.
 * Implements PKCE (RFC 7636) for all flows.
 *
 * SECURITY:
 * - PKCE code_verifier/code_challenge on every auth request
 * - No tokens logged in any code path
 * - Error responses sanitized before logging
 */

import crypto from 'node:crypto';
import { type OAuthConfig, type Provider, ConnectorError } from '../types.js';
import { logger } from '../logger.js';

// -- Scope Definitions -------------------------------------------------------

const GOOGLE_SCOPES: Record<string, string[]> = {
  mail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  drive: ['https://www.googleapis.com/auth/drive'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'],
  chat: [
    'https://www.googleapis.com/auth/chat.messages',
    'https://www.googleapis.com/auth/chat.spaces.readonly',
  ],
  profile: [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
};

const MICROSOFT_SCOPES: Record<string, string[]> = {
  mail: ['Mail.ReadWrite', 'Mail.Send'],
  calendar: ['Calendars.ReadWrite'],
  tasks: ['Tasks.ReadWrite'],
  drive: ['Files.ReadWrite.All'],
  contacts: ['Contacts.Read'],
  teams: ['Chat.ReadWrite', 'ChannelMessage.Send'],
  profile: ['User.Read'],
};

// LinkedIn scopes are gated by the app's enabled Products. Defaults cover
// "Sign In with LinkedIn (OpenID Connect)" + "Share on LinkedIn". Override the
// whole set with the LINKEDIN_SCOPES env (space-separated) without a rebuild.
const LINKEDIN_SCOPES: Record<string, string[]> = {
  profile: ['openid', 'profile', 'email'],
  post: ['w_member_social'],
  share: ['w_member_social'],
};

export function getScopesForServices(provider: Provider, services: string[]): string[] {
  if (provider === 'linkedin') {
    const envScopes = (process.env.LINKEDIN_SCOPES ?? '').trim();
    if (envScopes) return envScopes.split(/\s+/);
    const scopes = new Set<string>(LINKEDIN_SCOPES.profile);
    for (const service of (services.length ? services : ['post'])) {
      for (const s of LINKEDIN_SCOPES[service] ?? []) scopes.add(s);
    }
    return [...scopes];
  }
  const scopeMap = provider === 'google' ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
  const scopes = new Set<string>();
  for (const s of scopeMap.profile ?? []) scopes.add(s);
  for (const service of services) {
    for (const s of scopeMap[service] ?? []) scopes.add(s);
  }
  if (provider === 'microsoft') scopes.add('offline_access');
  return [...scopes];
}

// -- URLs ---------------------------------------------------------------------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

// -- PKCE (RFC 7636) ---------------------------------------------------------

/**
 * Generate a cryptographically random code_verifier and its S256 challenge.
 * The verifier must be stored server-side and sent during token exchange.
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // RFC 7636: 43-128 chars, unreserved characters. 64 bytes -> 86 base64url chars.
  const codeVerifier = crypto.randomBytes(64)
    .toString('base64url')
    .slice(0, 128);
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

export interface AuthState {
  state: string;
  codeVerifier: string;   // PKCE verifier -- must be stored and used at exchange
  provider: Provider;
  services: string[];
  createdAt: Date;
}

export function buildAuthUrl(
  config: OAuthConfig,
  services: string[],
  loginHint?: string,
): { url: string; state: AuthState } {
  const { codeVerifier, codeChallenge } = generatePKCE();

  const state: AuthState = {
    state: crypto.randomBytes(32).toString('hex'),
    codeVerifier,
    provider: config.provider,
    services,
    createdAt: new Date(),
  };

  const scopes = getScopesForServices(config.provider, services);
  const baseUrl =
    config.provider === 'google' ? GOOGLE_AUTH_URL
    : config.provider === 'linkedin' ? LINKEDIN_AUTH_URL
    : MICROSOFT_AUTH_URL;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: state.state,
  });

  // LinkedIn does not support PKCE — only Google/Microsoft get the challenge.
  if (config.provider !== 'linkedin') {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  if (config.provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent select_account');
    if (loginHint) params.set('login_hint', loginHint);
  } else if (config.provider === 'microsoft') {
    params.set('prompt', 'select_account');
    if (loginHint) params.set('login_hint', loginHint);
  }
  // LinkedIn: no access_type/prompt — they reject unknown auth params.

  const url = `${baseUrl}?${params.toString()}`;
  // SECURITY: Never log the URL (contains client_id, scopes, PKCE challenge)
  logger.info({ provider: config.provider, services }, 'Built auth URL');
  return { url, state };
}

// -- Token Exchange -----------------------------------------------------------

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  tokenType: string;
}

/**
 * Exchange authorization code for tokens.
 * SECURITY: Includes PKCE code_verifier per RFC 7636.
 */
export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const tokenUrl =
    config.provider === 'google' ? GOOGLE_TOKEN_URL
    : config.provider === 'linkedin' ? LINKEDIN_TOKEN_URL
    : MICROSOFT_TOKEN_URL;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
  // PKCE verifier only for providers that issued a challenge (not LinkedIn).
  if (config.provider !== 'linkedin') body.set('code_verifier', codeVerifier);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    // SECURITY: Parse error but never log raw response body (may contain tokens/codes)
    let errorCode = 'unknown';
    try {
      const errJson = await response.json() as Record<string, unknown>;
      errorCode = (errJson.error as string) || 'unknown';
    } catch {
      // If JSON parsing fails, use status code only
    }
    logger.error(
      { provider: config.provider, status: response.status, errorCode },
      'Token exchange failed',
    );
    throw new ConnectorError(
      `Token exchange failed: ${response.status}`,
      config.provider, 'TOKEN_EXCHANGE_FAILED', response.status,
    );
  }

  const data = await response.json() as Record<string, unknown>;
  // SECURITY: Log success without any token data
  logger.info({ provider: config.provider }, 'Token exchange successful');

  return {
    accessToken: data.access_token as string,
    // LinkedIn standard apps issue no refresh token (60-day access token);
    // coalesce so the token store gets a string, not undefined.
    refreshToken: (data.refresh_token as string) ?? '',
    expiresIn: data.expires_in as number,
    scope: (data.scope as string) ?? '',
    tokenType: (data.token_type as string) ?? 'Bearer',
  };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const tokenUrl =
    config.provider === 'google' ? GOOGLE_TOKEN_URL
    : config.provider === 'linkedin' ? LINKEDIN_TOKEN_URL
    : MICROSOFT_TOKEN_URL;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    // SECURITY: Only log error code, never the raw response body
    let errorCode = 'unknown';
    try {
      const errJson = await response.json() as Record<string, unknown>;
      errorCode = (errJson.error as string) || 'unknown';
    } catch {
      // Status code is sufficient
    }

    // Handle revoked tokens gracefully: 400 with invalid_grant means
    // the refresh token was revoked or expired permanently
    const isRevoked = response.status === 400 && errorCode === 'invalid_grant';
    if (isRevoked) {
      logger.warn(
        { provider: config.provider },
        'Refresh token revoked or expired -- user must re-authenticate',
      );
    } else {
      logger.error(
        { provider: config.provider, status: response.status, errorCode },
        'Token refresh failed',
      );
    }

    throw new ConnectorError(
      isRevoked
        ? 'Refresh token revoked -- re-authentication required'
        : `Token refresh failed: ${response.status}`,
      config.provider,
      isRevoked ? 'TOKEN_REVOKED' : 'TOKEN_REFRESH_FAILED',
      response.status,
    );
  }

  const data = await response.json() as Record<string, unknown>;
  logger.info({ provider: config.provider }, 'Token refreshed');

  return {
    accessToken: data.access_token as string,
    expiresIn: data.expires_in as number,
  };
}

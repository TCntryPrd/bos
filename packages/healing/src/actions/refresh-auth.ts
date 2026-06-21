/**
 * Refresh-auth action — rotate expired OAuth tokens.
 *
 * When a connector health check fails due to 401/403, this action:
 *   1. Locates the expired token for the given tenant + provider
 *   2. Uses the stored refresh_token to obtain a new access_token
 *   3. Persists the refreshed token back to the token store
 *   4. Returns success/failure for the diagnostic log
 *
 * The actual OAuth flow is delegated to the connector layer.
 * This module provides the healing-layer interface.
 */

export type OAuthProvider = 'microsoft' | 'google';

export interface RefreshAuthOptions {
  tenantId: string;
  provider: OAuthProvider;
  /** Override the token store endpoint if not using the default BOS API. */
  apiBaseUrl?: string;
  /** Internal API key for the BOS self-healing endpoint. */
  apiKey?: string;
  timeoutMs?: number;
}

export interface RefreshAuthResult {
  success: boolean;
  provider: OAuthProvider;
  tenantId: string;
  message: string;
  /** New token expiry, if available. */
  expiresAt?: Date;
  durationMs: number;
}

/**
 * Trigger an OAuth token refresh via the BOS internal API.
 * The API layer has the refresh_token and connector details — healing just calls the endpoint.
 */
export async function refreshAuth(options: RefreshAuthOptions): Promise<RefreshAuthResult> {
  const start = Date.now();
  const baseUrl = (options.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const timeout = options.timeoutMs ?? 15_000;

  try {
    const res = await fetch(
      `${baseUrl}/internal/connectors/${options.provider}/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { 'x-boss-api-key': options.apiKey } : {}),
        },
        body: JSON.stringify({ tenantId: options.tenantId }),
        signal: AbortSignal.timeout(timeout),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        success: false,
        provider: options.provider,
        tenantId: options.tenantId,
        message: `Refresh failed — API returned ${res.status}: ${body}`,
        durationMs: Date.now() - start,
      };
    }

    const data = (await res.json()) as { expiresAt?: string };

    return {
      success: true,
      provider: options.provider,
      tenantId: options.tenantId,
      message: `Token refreshed for ${options.provider} (tenant: ${options.tenantId})`,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      provider: options.provider,
      tenantId: options.tenantId,
      message: `Refresh error: ${message}`,
      durationMs: Date.now() - start,
    };
  }
}

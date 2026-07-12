/**
 * Google API base client — shared HTTP helpers for all Google service connectors.
 */

import type { OAuthConfig } from '../types.js';
import { ConnectorError } from '../types.js';
import { getValidToken, getValidTokenByAccountId, getAllValidTokens } from '../auth/refresh.js';
import { logger } from '../logger.js';

const GOOGLE_API_BASE = 'https://www.googleapis.com';

export interface GoogleClientConfig {
  oauth: OAuthConfig;
}

export class GoogleClient {
  constructor(private config: GoogleClientConfig) {}

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    opts?: { email?: string; accountId?: string },
  ): Promise<T> {
    const token = await this.resolveToken(opts);
    const url = new URL(path.startsWith('http') ? path : `${GOOGLE_API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return this.handleResponse<T>(response);
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: { email?: string; accountId?: string; contentType?: string },
  ): Promise<T> {
    const token = await this.resolveToken(opts);
    const url = path.startsWith('http') ? path : `${GOOGLE_API_BASE}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': opts?.contentType ?? 'application/json',
      },
      body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    return this.handleResponse<T>(response);
  }

  async patch<T = unknown>(
    path: string,
    body: unknown,
    opts?: { email?: string; accountId?: string },
  ): Promise<T> {
    const token = await this.resolveToken(opts);
    const url = path.startsWith('http') ? path : `${GOOGLE_API_BASE}${path}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response);
  }

  async delete(path: string, opts?: { email?: string; accountId?: string }): Promise<void> {
    const token = await this.resolveToken(opts);
    const url = path.startsWith('http') ? path : `${GOOGLE_API_BASE}${path}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 204) await this.handleError(response);
  }

  async getAllTokens(): Promise<{ email: string; accountId: string; accessToken: string }[]> {
    return getAllValidTokens(this.config.oauth);
  }

  private async resolveToken(opts?: { email?: string; accountId?: string }): Promise<string> {
    if (opts?.accountId) return getValidTokenByAccountId(this.config.oauth, opts.accountId);
    if (opts?.email) return getValidToken(this.config.oauth, opts.email);
    const tokens = await getAllValidTokens(this.config.oauth);
    if (tokens.length === 0) throw new ConnectorError('No Google accounts connected', 'google', 'NOT_CONNECTED');
    return tokens[0].accessToken;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) await this.handleError(response);
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async handleError(response: Response): Promise<never> {
    const body = await response.text();
    logger.error({ status: response.status, body }, 'Google API error');
    throw new ConnectorError(`Google API error: ${response.status} ${body}`, 'google', 'API_ERROR', response.status);
  }
}

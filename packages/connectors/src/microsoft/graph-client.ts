/**
 * Microsoft Graph API base client.
 * Handles authenticated requests to the Microsoft Graph API.
 */

import type { OAuthConfig } from '../types.js';
import { ConnectorError } from '../types.js';
import { getValidToken, getValidTokenByAccountId, getAllValidTokens } from '../auth/refresh.js';
import { logger } from '../logger.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphClientConfig {
  oauth: OAuthConfig;
}

export class GraphClient {
  constructor(private config: GraphClientConfig) {}

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    opts?: { email?: string; accountId?: string },
  ): Promise<T> {
    const token = await this.resolveToken(opts);
    const url = new URL(`${GRAPH_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    return this.handleResponse<T>(response);
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: { email?: string; accountId?: string; contentType?: string },
  ): Promise<T> {
    const token = await this.resolveToken(opts);

    const response = await fetch(`${GRAPH_BASE}${path}`, {
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

    const response = await fetch(`${GRAPH_BASE}${path}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    return this.handleResponse<T>(response);
  }

  async delete(
    path: string,
    opts?: { email?: string; accountId?: string },
  ): Promise<void> {
    const token = await this.resolveToken(opts);

    const response = await fetch(`${GRAPH_BASE}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok && response.status !== 204) {
      await this.handleError(response);
    }
  }

  /**
   * Upload content with PUT (used for OneDrive).
   */
  async put<T = unknown>(
    path: string,
    body: Buffer | string,
    opts?: { email?: string; accountId?: string; contentType?: string },
  ): Promise<T> {
    const token = await this.resolveToken(opts);

    const response = await fetch(`${GRAPH_BASE}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': opts?.contentType ?? 'application/octet-stream',
      },
      body,
    });

    return this.handleResponse<T>(response);
  }

  async getAllTokens(): Promise<{ email: string; accountId: string; accessToken: string }[]> {
    return getAllValidTokens(this.config.oauth);
  }

  // ── Internal ────────────────────────────────────────────────────

  private async resolveToken(opts?: { email?: string; accountId?: string }): Promise<string> {
    if (opts?.accountId) {
      return getValidTokenByAccountId(this.config.oauth, opts.accountId);
    }
    if (opts?.email) {
      return getValidToken(this.config.oauth, opts.email);
    }
    const tokens = await getAllValidTokens(this.config.oauth);
    if (tokens.length === 0) {
      throw new ConnectorError('No Microsoft accounts connected', 'microsoft', 'NOT_CONNECTED');
    }
    return tokens[0].accessToken;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      await this.handleError(response);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async handleError(response: Response): Promise<never> {
    const body = await response.text();
    logger.error({ status: response.status, body }, 'Graph API error');
    throw new ConnectorError(
      `Graph API error: ${response.status} ${body}`,
      'microsoft',
      'API_ERROR',
      response.status,
    );
  }
}

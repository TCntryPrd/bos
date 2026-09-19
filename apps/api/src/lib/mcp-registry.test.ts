/**
 * Tests for the pure parts of the MCP registry.
 *
 * The CRUD helpers need a live pool, so what's pinned here is the token-expiry
 * logic that decides whether BOS considers a connection usable — the thing that
 * gates every managed-agent run.
 */

import { describe, it, expect } from 'vitest';
import { isAuthenticated, type McpConnection } from './mcp-registry.js';

function connection(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    id: 'mcp_test',
    name: 'mygentic',
    transport: 'http',
    serverUrl: 'https://mcp.example.com/mcp',
    command: null,
    args: null,
    loginUrl: null,
    tokenEnv: null,
    configPath: null,
    description: null,
    enabled: true,
    oauthClientId: null,
    oauthClientSecret: null,
    oauthAuthorizeEndpoint: null,
    oauthTokenEndpoint: null,
    oauthRegistrationEndpoint: null,
    oauthScope: null,
    oauthResource: null,
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
    authenticatedAt: null,
    vaultCredentialId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('isAuthenticated', () => {
  it('is false without an access token', () => {
    expect(isAuthenticated(connection())).toBe(false);
  });

  it('is true for a token with no stated expiry', () => {
    expect(isAuthenticated(connection({ accessToken: 'at' }))).toBe(true);
  });

  it('is true for a token expiring in the future', () => {
    const conn = connection({ accessToken: 'at', tokenExpiresAt: new Date(Date.now() + 60_000) });
    expect(isAuthenticated(conn)).toBe(true);
  });

  it('is false for an expired token', () => {
    const conn = connection({ accessToken: 'at', tokenExpiresAt: new Date(Date.now() - 1_000) });
    expect(isAuthenticated(conn)).toBe(false);
  });
});

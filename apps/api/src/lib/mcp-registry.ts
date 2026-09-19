/**
 * MCP connection registry — Postgres-backed store for remote MCP servers.
 *
 * This is what the Global MCP tab in Settings reads and writes. Each row is one
 * MCP server BOS can reach, plus (for OAuth servers) the discovered endpoints,
 * the dynamically registered client, and the tokens from the PKCE flow.
 *
 * Tokens are stored here only long enough to hand to an Anthropic vault, which
 * owns refresh from then on (see managed-agent.ts). We keep the refresh token
 * so the vault credential can be rebuilt without a fresh browser login.
 */

import crypto from 'node:crypto';
import { getPool } from '../db.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpConnection {
  id: string;
  name: string;
  transport: McpTransport;
  serverUrl: string | null;
  command: string | null;
  args: string | null;
  loginUrl: string | null;
  tokenEnv: string | null;
  configPath: string | null;
  description: string | null;
  enabled: boolean;
  // OAuth state
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  oauthAuthorizeEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  oauthRegistrationEndpoint: string | null;
  oauthScope: string | null;
  oauthResource: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  authenticatedAt: Date | null;
  vaultCredentialId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMcpConnection {
  name: string;
  transport: McpTransport;
  serverUrl?: string;
  command?: string;
  args?: string;
  loginUrl?: string;
  tokenEnv?: string;
  configPath?: string;
  description?: string;
  enabled?: boolean;
}

// ── Schema ───────────────────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

/**
 * Create the MCP tables if they are missing. Idempotent and additive, matching
 * the deploy/reconcile-schema.sh contract, so a running API repairs its own
 * schema rather than depending on a deploy step having been run.
 */
export function ensureMcpSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_mcp_connections (
          id                          text PRIMARY KEY,
          name                        text NOT NULL UNIQUE,
          transport                   text NOT NULL DEFAULT 'http',
          server_url                  text,
          command                     text,
          args                        text,
          login_url                   text,
          token_env                   text,
          config_path                 text,
          description                 text,
          enabled                     boolean NOT NULL DEFAULT true,
          oauth_client_id             text,
          oauth_client_secret         text,
          oauth_authorize_endpoint    text,
          oauth_token_endpoint        text,
          oauth_registration_endpoint text,
          oauth_scope                 text,
          oauth_resource              text,
          access_token                text,
          refresh_token               text,
          token_expires_at            timestamptz,
          authenticated_at            timestamptz,
          vault_credential_id         text,
          created_at                  timestamptz NOT NULL DEFAULT now(),
          updated_at                  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_mcp_oauth_state (
          state         text PRIMARY KEY,
          connection_id text NOT NULL,
          code_verifier text NOT NULL,
          redirect_uri  text NOT NULL,
          created_at    timestamptz NOT NULL DEFAULT now()
        )
      `);
    })().catch((err) => {
      schemaReady = null; // allow a retry on the next call
      throw err;
    });
  }
  return schemaReady;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(row: any): McpConnection {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    serverUrl: row.server_url,
    command: row.command,
    args: row.args,
    loginUrl: row.login_url,
    tokenEnv: row.token_env,
    configPath: row.config_path,
    description: row.description,
    enabled: row.enabled,
    oauthClientId: row.oauth_client_id,
    oauthClientSecret: row.oauth_client_secret,
    oauthAuthorizeEndpoint: row.oauth_authorize_endpoint,
    oauthTokenEndpoint: row.oauth_token_endpoint,
    oauthRegistrationEndpoint: row.oauth_registration_endpoint,
    oauthScope: row.oauth_scope,
    oauthResource: row.oauth_resource,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    authenticatedAt: row.authenticated_at,
    vaultCredentialId: row.vault_credential_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listConnections(): Promise<McpConnection[]> {
  await ensureMcpSchema();
  const { rows } = await getPool().query('SELECT * FROM boss_mcp_connections ORDER BY name');
  return rows.map(mapRow);
}

export async function getConnection(id: string): Promise<McpConnection | null> {
  await ensureMcpSchema();
  const { rows } = await getPool().query('SELECT * FROM boss_mcp_connections WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function getConnectionByName(name: string): Promise<McpConnection | null> {
  await ensureMcpSchema();
  const { rows } = await getPool().query('SELECT * FROM boss_mcp_connections WHERE name = $1', [name]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createConnection(input: NewMcpConnection): Promise<McpConnection> {
  await ensureMcpSchema();
  const id = `mcp_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const { rows } = await getPool().query(
    `INSERT INTO boss_mcp_connections
       (id, name, transport, server_url, command, args, login_url, token_env,
        config_path, description, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (name) DO UPDATE SET
       transport = EXCLUDED.transport,
       server_url = EXCLUDED.server_url,
       command = EXCLUDED.command,
       args = EXCLUDED.args,
       login_url = EXCLUDED.login_url,
       token_env = EXCLUDED.token_env,
       config_path = EXCLUDED.config_path,
       description = EXCLUDED.description,
       enabled = EXCLUDED.enabled,
       -- Tokens and the discovered endpoints belong to the OLD server URL. If
       -- the URL moved, drop them so the connection reads as "needs login"
       -- rather than handing the vault a credential minted for somewhere else.
       oauth_authorize_endpoint = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                                  THEN NULL ELSE boss_mcp_connections.oauth_authorize_endpoint END,
       oauth_token_endpoint = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                              THEN NULL ELSE boss_mcp_connections.oauth_token_endpoint END,
       oauth_registration_endpoint = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                                     THEN NULL ELSE boss_mcp_connections.oauth_registration_endpoint END,
       oauth_client_id = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                         THEN NULL ELSE boss_mcp_connections.oauth_client_id END,
       oauth_client_secret = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                             THEN NULL ELSE boss_mcp_connections.oauth_client_secret END,
       oauth_resource = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                        THEN NULL ELSE boss_mcp_connections.oauth_resource END,
       access_token = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                      THEN NULL ELSE boss_mcp_connections.access_token END,
       refresh_token = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                       THEN NULL ELSE boss_mcp_connections.refresh_token END,
       token_expires_at = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                          THEN NULL ELSE boss_mcp_connections.token_expires_at END,
       authenticated_at = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                          THEN NULL ELSE boss_mcp_connections.authenticated_at END,
       vault_credential_id = CASE WHEN boss_mcp_connections.server_url IS DISTINCT FROM EXCLUDED.server_url
                             THEN NULL ELSE boss_mcp_connections.vault_credential_id END,
       updated_at = now()
     RETURNING *`,
    [
      id,
      input.name,
      input.transport,
      input.serverUrl || null,
      input.command || null,
      input.args || null,
      input.loginUrl || null,
      input.tokenEnv || null,
      input.configPath || null,
      input.description || null,
      input.enabled ?? true,
    ],
  );
  return mapRow(rows[0]);
}

export async function deleteConnection(id: string): Promise<boolean> {
  await ensureMcpSchema();
  const res = await getPool().query('DELETE FROM boss_mcp_connections WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

// ── OAuth persistence ────────────────────────────────────────────────────────

export async function saveDiscovery(
  id: string,
  discovery: {
    authorizeEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    scope?: string;
    resource?: string;
    clientId?: string;
    clientSecret?: string;
  },
): Promise<void> {
  await ensureMcpSchema();
  await getPool().query(
    `UPDATE boss_mcp_connections SET
       oauth_authorize_endpoint = $2,
       oauth_token_endpoint = $3,
       oauth_registration_endpoint = COALESCE($4, oauth_registration_endpoint),
       oauth_scope = COALESCE($5, oauth_scope),
       oauth_resource = COALESCE($6, oauth_resource),
       oauth_client_id = COALESCE($7, oauth_client_id),
       oauth_client_secret = COALESCE($8, oauth_client_secret),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      discovery.authorizeEndpoint,
      discovery.tokenEndpoint,
      discovery.registrationEndpoint ?? null,
      discovery.scope ?? null,
      discovery.resource ?? null,
      discovery.clientId ?? null,
      discovery.clientSecret ?? null,
    ],
  );
}

export async function saveOAuthState(params: {
  state: string;
  connectionId: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<void> {
  await ensureMcpSchema();
  const pool = getPool();
  // Expire anything older than 15 minutes so abandoned logins don't pile up.
  await pool.query("DELETE FROM boss_mcp_oauth_state WHERE created_at < now() - interval '15 minutes'");
  await pool.query(
    `INSERT INTO boss_mcp_oauth_state (state, connection_id, code_verifier, redirect_uri)
     VALUES ($1,$2,$3,$4)`,
    [params.state, params.connectionId, params.codeVerifier, params.redirectUri],
  );
}

export interface ConsumedState {
  connectionId: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Read-and-delete: a state parameter is single-use by definition. */
export async function consumeOAuthState(state: string): Promise<ConsumedState | null> {
  await ensureMcpSchema();
  const { rows } = await getPool().query(
    `DELETE FROM boss_mcp_oauth_state
      WHERE state = $1 AND created_at > now() - interval '15 minutes'
      RETURNING connection_id, code_verifier, redirect_uri`,
    [state],
  );
  if (!rows.length) return null;
  return {
    connectionId: rows[0].connection_id,
    codeVerifier: rows[0].code_verifier,
    redirectUri: rows[0].redirect_uri,
  };
}

export async function saveTokens(
  id: string,
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string },
): Promise<void> {
  await ensureMcpSchema();
  await getPool().query(
    `UPDATE boss_mcp_connections SET
       access_token = $2,
       refresh_token = COALESCE($3, refresh_token),
       token_expires_at = $4,
       oauth_scope = COALESCE($5, oauth_scope),
       authenticated_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [id, tokens.accessToken, tokens.refreshToken ?? null, tokens.expiresAt ?? null, tokens.scope ?? null],
  );
}

export async function saveVaultCredentialId(id: string, credentialId: string): Promise<void> {
  await ensureMcpSchema();
  await getPool().query(
    'UPDATE boss_mcp_connections SET vault_credential_id = $2, updated_at = now() WHERE id = $1',
    [id, credentialId],
  );
}

// ── Derived state ────────────────────────────────────────────────────────────

/** A connection counts as authenticated when it holds a token that has not expired. */
export function isAuthenticated(conn: McpConnection): boolean {
  if (!conn.accessToken) return false;
  if (!conn.tokenExpiresAt) return true;
  return conn.tokenExpiresAt.getTime() > Date.now();
}

/**
 * Seed the Mygentic connection from the environment on first boot so a fresh
 * install has something to log into without hand-entering the URL.
 */
export async function seedFromEnv(): Promise<void> {
  const url = process.env.MYGENTIC_MCP_URL;
  if (!url) return;
  const existing = await getConnectionByName('mygentic');
  if (existing) return;
  await createConnection({
    name: 'mygentic',
    transport: 'http',
    serverUrl: url,
    description: 'Mygentic Connect — seeded from MYGENTIC_MCP_URL',
    enabled: true,
  });
}

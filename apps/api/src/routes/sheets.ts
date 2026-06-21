/**
 * Sheets Agent routes — /api/sheets/*
 *
 * HTTP interface for Google Sheets operations using stored OAuth tokens.
 * Used by outreach agents to update the master outreach tracking sheet.
 *
 *   GET  /api/sheets/read              — read cell values from a sheet range
 *   POST /api/sheets/update            — update cell values in a sheet range
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import crypto from 'node:crypto';

// ── Token helpers (mirrors email-agent.ts) ────────────────────────────────────

const _ALGORITHM = 'aes-256-gcm';
const _IV_LENGTH = 16;
const _AUTH_TAG_LENGTH = 16;

function _getEncryptionKey(): Buffer {
  const key = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be set');
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

function _decryptToken(encryptedText: string): string {
  const key = _getEncryptionKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(_ALGORITHM, key, iv, { authTagLength: _AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  let out = decipher.update(ciphertext, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

function _encryptToken(plaintext: string): string {
  const key = _getEncryptionKey();
  const iv = crypto.randomBytes(_IV_LENGTH);
  const cipher = crypto.createCipheriv(_ALGORITHM, key, iv, { authTagLength: _AUTH_TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

interface GoogleTokenRow {
  account_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

async function _getGoogleToken(email: string): Promise<{
  accessToken: string;
  accountId: string;
  email: string;
  refreshToken: string;
}> {
  const pool = getPool();
  const result = await pool.query<GoogleTokenRow>(
    `SELECT account_id, email, access_token, refresh_token, expires_at
       FROM boss_oauth_tokens
      WHERE provider = 'google' AND email = $1`,
    [email],
  );
  if (result.rows.length === 0) {
    throw new Error(`No Google OAuth token found for ${email}. Connect the account via Settings first.`);
  }
  const row = result.rows[0];
  return {
    accountId: row.account_id,
    email: row.email,
    accessToken: _decryptToken(row.access_token),
    refreshToken: _decryptToken(row.refresh_token),
  };
}

async function _refreshGoogleToken(accountId: string, refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  const newAccessToken = data.access_token;
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
  const pool = getPool();
  await pool.query(
    `UPDATE boss_oauth_tokens SET access_token = $1, expires_at = $2, updated_at = now() WHERE account_id = $3`,
    [_encryptToken(newAccessToken), expiresAt.toISOString(), accountId],
  );
  return newAccessToken;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function sheetsRoutes(server: FastifyInstance) {
  /**
   * GET /api/sheets/read
   * Read cell values from a Google Sheet range.
   *
   * Query params:
   *   account       — Google account email (e.g. d.caine@dcaine.com)
   *   spreadsheetId — Sheet ID
   *   range         — A1 notation range (e.g. Sheet1!A1:Z100)
   *
   * Example response:
   *   { "range": "Sheet1!A1:Z10", "values": [["Name", "Email", ...], ...] }
   */
  server.get<{
    Querystring: { account: string; spreadsheetId: string; range: string };
  }>(
    '/read',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['account', 'spreadsheetId', 'range'],
          properties: {
            account:       { type: 'string', minLength: 1 },
            spreadsheetId: { type: 'string', minLength: 1 },
            range:         { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { account: string; spreadsheetId: string; range: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { account, spreadsheetId, range } = request.query;

      let token: Awaited<ReturnType<typeof _getGoogleToken>>;
      try {
        token = await _getGoogleToken(account);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: 'Google account not connected', message: msg });
      }

      const doRead = async (accessToken: string) => {
        return fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
      };

      let res = await doRead(token.accessToken);
      if (res.status === 401) {
        token.accessToken = await _refreshGoogleToken(token.accountId, token.refreshToken);
        res = await doRead(token.accessToken);
      }
      if (!res.ok) {
        const text = await res.text();
        return reply.status(502).send({ error: 'Sheets read failed', message: text });
      }

      const data = await res.json() as { range: string; values?: string[][] };
      request.log.info({ account, spreadsheetId, range }, 'sheets: read complete');
      return reply.status(200).send({ range: data.range, values: data.values ?? [] });
    },
  );

  /**
   * POST /api/sheets/update
   * Update cell values in a Google Sheet range (valueInputOption=USER_ENTERED).
   * Used by outreach-followup agent to update reply dates and follow-up status.
   *
   * Example request:
   *   {
   *     "account": "d.caine@dcaine.com",
   *     "spreadsheetId": "1Z1ZReCWmFr8e_OgrlUZ_Ee1c86B69AEXjGcp2fd3gjU",
   *     "updates": [
   *       { "range": "Sheet1!S42", "values": [["2026-04-05"]] },
   *       { "range": "Sheet1!T42", "values": [["Follow-up needed"]] }
   *     ]
   *   }
   *
   * Example response:
   *   { "updatedCells": 2, "updatedRanges": ["Sheet1!S42", "Sheet1!T42"] }
   */
  server.post<{
    Body: {
      account: string;
      spreadsheetId: string;
      updates: Array<{ range: string; values: string[][] }>;
    };
  }>(
    '/update',
    {
      schema: {
        body: {
          type: 'object',
          required: ['account', 'spreadsheetId', 'updates'],
          properties: {
            account:       { type: 'string', minLength: 1 },
            spreadsheetId: { type: 'string', minLength: 1 },
            updates: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['range', 'values'],
                properties: {
                  range:  { type: 'string', minLength: 1 },
                  values: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: {
          account: string;
          spreadsheetId: string;
          updates: Array<{ range: string; values: string[][] }>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { account, spreadsheetId, updates } = request.body;

      let token: Awaited<ReturnType<typeof _getGoogleToken>>;
      try {
        token = await _getGoogleToken(account);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: 'Google account not connected', message: msg });
      }

      const batchBody = {
        valueInputOption: 'USER_ENTERED',
        data: updates.map((u) => ({ range: u.range, values: u.values })),
      };

      const doUpdate = async (accessToken: string) => {
        return fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(batchBody),
          },
        );
      };

      let res = await doUpdate(token.accessToken);
      if (res.status === 401) {
        token.accessToken = await _refreshGoogleToken(token.accountId, token.refreshToken);
        res = await doUpdate(token.accessToken);
      }
      if (!res.ok) {
        const text = await res.text();
        return reply.status(502).send({ error: 'Sheets update failed', message: text });
      }

      const data = await res.json() as {
        totalUpdatedCells?: number;
        responses?: Array<{ updatedRange: string }>;
      };

      const updatedRanges = (data.responses ?? []).map((r) => r.updatedRange);
      request.log.info(
        { account, spreadsheetId, updatedCells: data.totalUpdatedCells, updatedRanges },
        'sheets: batch update complete',
      );

      return reply.status(200).send({
        updatedCells: data.totalUpdatedCells ?? 0,
        updatedRanges,
      });
    },
  );
}

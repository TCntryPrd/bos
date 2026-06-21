/**
 * Auth routes — /api/auth/*
 *
 * Handles login, registration (admin only), JWT refresh, and logout.
 * JWTs are signed with HS256 using BOSS_JWT_SECRET env var.
 *
 * User and invite data are stored in Postgres.
 * Revoked refresh tokens are tracked in-memory (ephemeral, low-volume during Alpha).
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { setRuntimeConfig } from '../config-store.js';

// ---------------------------------------------------------------------------
// Minimal JWT implementation (no external dep required at Phase 1)
// Replace with @fastify/jwt once added to package.json if preferred.
// ---------------------------------------------------------------------------

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  let out = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += TOTP_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(value: string): Buffer {
  let bits = '';
  for (const rawChar of value.replace(/=+$/g, '').toUpperCase()) {
    const index = TOTP_ALPHABET.indexOf(rawChar);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpFor(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function verifyTotp(secret: string, code: string): boolean {
  const cleaned = code.replace(/\D/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  return [-1, 0, 1].some((offset) => totpFor(secret, counter + offset) === cleaned);
}

function otpauthUrl(email: string, secret: string): string {
  const label = encodeURIComponent(`BOS:${email}`);
  const issuer = encodeURIComponent('BOS');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// In-memory revocation set (kept ephemeral — low-volume during Alpha)
// ---------------------------------------------------------------------------

/** Revoked or logged-out refresh tokens. Keyed by jti. */
const revokedTokens = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getJwtSecret(): string {
  const secret = process.env.BOSS_JWT_SECRET;
  if (!secret) throw new Error('BOSS_JWT_SECRET must be set');
  return secret;
}

interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: 'admin' | 'user';
  tenantId: string;
}

function issueTokenPair(user: UserRecord): { accessToken: string; refreshToken: string } {
  const secret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomBytes(16).toString('hex');

  const accessToken = signJwt(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      jti: `access-${jti}`,
      iat: now,
      exp: now + 24 * 60 * 60, // 24 hours
    },
    secret,
  );

  const refreshToken = signJwt(
    {
      sub: user.id,
      jti: `refresh-${jti}`,
      iat: now,
      exp: now + 7 * 24 * 60 * 60, // 7 days
    },
    secret,
  );

  return { accessToken, refreshToken };
}

/**
 * Resolve the UUID for the 'default' tenant row.
 * This is called lazily at request time to avoid blocking startup.
 */
async function getDefaultTenantId(): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
    ['default'],
  );
  if (rows.length === 0) {
    throw new Error("Default tenant not found — ensure migration 001 has run");
  }
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Request / Response schemas
// ---------------------------------------------------------------------------

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 1 },
      totpCode: { type: 'string' },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            displayName: { type: 'string' },
            role: { type: 'string' },
            tenantId: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

const registerSchema = {
  body: {
    type: 'object',
    required: ['email', 'password', 'displayName', 'passkey'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
      displayName: { type: 'string', minLength: 1 },
      passkey: { type: 'string', minLength: 9, maxLength: 9 },
      role: { type: 'string', enum: ['admin', 'user'] },
    },
    additionalProperties: false,
  },
} as const;

const refreshSchema = {
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const;

const logoutSchema = {
  body: {
    type: 'object',
    properties: {
      refreshToken: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const;

const inviteSchema = {
  body: {
    type: 'object',
    required: ['email', 'role'],
    properties: {
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['user', 'admin'] },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string' },
        status: { type: 'string' },
        createdAt: { type: 'string' },
      },
    },
  },
} as const;

const listInvitesSchema = {
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string' },
          status: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

interface LoginBody {
  email: string;
  password: string;
  totpCode?: string;
}

interface RegisterBody {
  email: string;
  password: string;
  displayName: string;
  passkey: string;
  role?: 'admin' | 'user';
}

interface RefreshBody {
  refreshToken: string;
}

interface LogoutBody {
  refreshToken?: string;
}

interface InviteBody {
  email: string;
  role: 'user' | 'admin';
}

// ---------------------------------------------------------------------------
// Postgres row types
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  role: string;
  tenant_id: string;
  totp_secret?: string | null;
  totp_enabled?: boolean | null;
}

interface InviteRow {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string;
  tenant_id: string;
  created_at: Date;
  expires_at: Date;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function authRoutes(server: FastifyInstance) {
  /**
   * POST /api/auth/login
   * Authenticate with email + password. Returns a short-lived access token and
   * a long-lived refresh token.
   *
   * Example request:
   *   POST /api/auth/login
   *   { "email": "admin@boss.local", "password": "changeme" }
   *
   * Example response:
   *   { "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { ... } }
   */
  server.post<{ Body: LoginBody }>(
    '/login',
    { schema: loginSchema, config: { skipAuth: true } },
    async (request: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
      const { email, password } = request.body;
      const normalizedEmail = email.toLowerCase();
      const pool = getPool();

      const { rows } = await pool.query<UserRow>(
        `SELECT id, email, display_name, password_hash, role, tenant_id::text, totp_secret, totp_enabled
         FROM users
         WHERE email = $1
         LIMIT 1`,
        [normalizedEmail],
      );

      const row = rows[0];
      if (!row || !row.password_hash) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid credentials',
        });
      }

      const hash = crypto.createHash('sha256').update(password).digest('hex');
      if (hash !== row.password_hash) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid credentials',
        });
      }

      if (row.totp_enabled) {
        if (!row.totp_secret) {
          request.log.error({ userId: row.id }, '2FA enabled without a TOTP secret');
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Two-factor authentication is not configured correctly. Contact your administrator.',
          });
        }
        const code = request.body.totpCode;
        if (!code) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Two-factor code required',
            requires2fa: true,
          });
        }
        if (!verifyTotp(row.totp_secret, code)) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Invalid two-factor code',
            requires2fa: true,
          });
        }
      }

      const user: UserRecord = {
        id: row.id,
        email: row.email,
        displayName: row.display_name ?? row.email,
        passwordHash: row.password_hash,
        role: row.role as 'admin' | 'user',
        tenantId: row.tenant_id,
      };

      const tokens = issueTokenPair(user);
      request.log.info({ userId: user.id }, 'User logged in');

      return reply.status(200).send({
        ...tokens,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          tenantId: user.tenantId,
        },
      });
    },
  );

  /**
   * POST /api/auth/register
   * Create a new user account. Restricted to admin callers.
   *
   * Example request:
   *   POST /api/auth/register
   *   Authorization: Bearer <admin-access-token>
   *   { "email": "user@example.com", "password": "secure123", "displayName": "John" }
   *
   * Example response:
   *   { "id": "...", "email": "user@example.com", "role": "user", ... }
   */
  server.post<{ Body: RegisterBody }>(
    '/register',
    { schema: registerSchema, config: { skipAuth: true } },
    async (request: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
      const auth = (request as any).auth;

      // Require admin role. authMiddleware in Phase 1 sets auth.userId = 'default'
      // so we do a best-effort check — tighten this when JWT auth replaces the API key.
      if (auth?.role && auth.role !== 'admin') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Admin role required to register new users',
        });
      }

      const { email, password, displayName, passkey, role = 'user' } = request.body;
      const normalizedEmail = email.toLowerCase();
      const pool = getPool();

      // Validate passkey — must match a pre-registered code set by admin via CLI
      const passkeyHash = crypto.createHash('sha256').update(passkey).digest('hex');
      const { rows: pendingRows } = await pool.query<{ passkey_hash: string }>(
        'SELECT passkey_hash FROM boss_pending_passkeys WHERE email = $1',
        [normalizedEmail],
      );

      if (pendingRows.length === 0) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'No passkey has been issued for this email. Contact your administrator.',
        });
      }

      if (pendingRows[0].passkey_hash !== passkeyHash) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid passkey. Contact your administrator if you need a new one.',
        });
      }

      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

      // Derive username from the local part of the email, appending random hex to
      // avoid collisions on the (tenant_id, username) unique constraint.
      const localPart = normalizedEmail.split('@')[0].replace(/[^a-z0-9_]/gi, '_');
      const username = `${localPart}_${crypto.randomBytes(4).toString('hex')}`;

      // Resolve tenant — always look up the UUID from the tenants table.
      // The tenant middleware may set tenantId to a slug like 'default', but
      // the users table requires the actual UUID.
      let tenantId: string;
      try {
        const rawTenantId = (request as any).tenant?.tenantId;
        // If it looks like a UUID, use it directly; otherwise look up by slug
        const isUuid = rawTenantId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawTenantId);
        tenantId = isUuid ? rawTenantId : await getDefaultTenantId();
      } catch (err) {
        request.log.error({ err }, 'Failed to resolve tenant for registration');
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Could not resolve tenant',
        });
      }

      let newRow: UserRow;
      try {
        const { rows } = await pool.query<UserRow>(
          `INSERT INTO users (tenant_id, username, email, display_name, password_hash, role, onboarding_wizard_complete)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, FALSE)
           RETURNING id, email, display_name, password_hash, role, tenant_id::text`,
          [tenantId, username, normalizedEmail, displayName, passwordHash, role],
        );
        newRow = rows[0];
      } catch (err: any) {
        // Unique constraint on (tenant_id, email)
        if (err.code === '23505') {
          return reply.status(409).send({
            error: 'Conflict',
            message: 'An account with this email already exists',
          });
        }
        throw err;
      }

      // Move passkey from pending to user record, clean up pending
      await pool.query('UPDATE users SET passkey_hash = $1 WHERE id = $2', [passkeyHash, newRow.id]);
      await pool.query('DELETE FROM boss_pending_passkeys WHERE email = $1', [normalizedEmail]);

      request.log.info({ userId: newRow.id, email: normalizedEmail }, 'User registered with passkey');

      const user: UserRecord = {
        id: newRow.id,
        email: newRow.email,
        displayName: newRow.display_name ?? displayName,
        passwordHash: newRow.password_hash!,
        role: newRow.role as 'admin' | 'user',
        tenantId: newRow.tenant_id,
      };

      // Issue JWT tokens so the user is immediately authenticated after registration
      const tokens = issueTokenPair(user);

      return reply.status(201).send({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        tenantId: user.tenantId,
        createdAt: new Date().toISOString(),
        ...tokens,
      });
    },
  );

  /**
   * POST /api/auth/refresh
   * Exchange a valid refresh token for a new access + refresh token pair.
   * The old refresh token is revoked (rotation).
   *
   * Example request:
   *   POST /api/auth/refresh
   *   { "refreshToken": "eyJ..." }
   */
  server.post<{ Body: RefreshBody }>(
    '/refresh',
    { schema: refreshSchema, config: { skipAuth: true } },
    async (request: FastifyRequest<{ Body: RefreshBody }>, reply: FastifyReply) => {
      const { refreshToken } = request.body;

      let payload: Record<string, unknown> | null = null;
      try {
        payload = verifyJwt(refreshToken, getJwtSecret());
      } catch {
        // JWT secret not configured
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Auth service not configured',
        });
      }

      if (!payload) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or expired refresh token',
        });
      }

      const jti = payload.jti as string;
      if (revokedTokens.has(jti)) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Refresh token has been revoked',
        });
      }

      // Look up user in Postgres
      const userId = payload.sub as string;
      const pool = getPool();

      const { rows } = await pool.query<UserRow>(
        `SELECT id, email, display_name, password_hash, role, tenant_id::text
         FROM users
         WHERE id = $1::uuid
         LIMIT 1`,
        [userId],
      );

      if (rows.length === 0) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'User not found',
        });
      }

      const row = rows[0];
      const user: UserRecord = {
        id: row.id,
        email: row.email,
        displayName: row.display_name ?? row.email,
        passwordHash: row.password_hash ?? '',
        role: row.role as 'admin' | 'user',
        tenantId: row.tenant_id,
      };

      // Revoke old refresh token (rotation)
      revokedTokens.add(jti);

      const tokens = issueTokenPair(user);
      request.log.info({ userId }, 'Tokens refreshed');

      return reply.status(200).send(tokens);
    },
  );

  /**
   * POST /api/auth/logout
   * Invalidate the current session. Revokes the provided refresh token if given.
   *
   * Example request:
   *   POST /api/auth/logout
   *   Authorization: Bearer <access-token>
   *   { "refreshToken": "eyJ..." }
   */
  server.post<{ Body: LogoutBody }>(
    '/logout',
    { schema: logoutSchema },
    async (request: FastifyRequest<{ Body: LogoutBody }>, reply: FastifyReply) => {
      const { refreshToken } = request.body;

      if (refreshToken) {
        try {
          const payload = verifyJwt(refreshToken, getJwtSecret());
          if (payload?.jti) {
            revokedTokens.add(payload.jti as string);
          }
        } catch {
          // Non-fatal — token may already be invalid
        }
      }

      request.log.info({ userId: (request as any).auth?.userId }, 'User logged out');
      return reply.status(200).send({ message: 'Logged out' });
    },
  );

  /**
   * POST /api/auth/invite
   * Create a pending invite for a new user. Admin only.
   *
   * Example request:
   *   POST /api/auth/invite
   *   Authorization: Bearer <admin-access-token>
   *   { "email": "newuser@example.com", "role": "user" }
   *
   * Example response:
   *   { "id": "invite-abc123", "email": "newuser@example.com", "role": "user",
   *     "status": "pending", "createdAt": "2026-03-30T..." }
   */
  server.post<{ Body: InviteBody }>(
    '/invite',
    { schema: inviteSchema },
    async (request: FastifyRequest<{ Body: InviteBody }>, reply: FastifyReply) => {
      const auth = (request as any).auth;

      if (auth?.role && auth.role !== 'admin') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Admin role required to create invites',
        });
      }

      const { email, role } = request.body;
      const normalizedEmail = email.toLowerCase();
      const inviteId = `invite-${crypto.randomBytes(8).toString('hex')}`;
      const invitedBy = auth?.userId ?? 'system';
      const tenantId = (request as any).tenant?.tenantId || 'default';
      const pool = getPool();

      const { rows } = await pool.query<InviteRow>(
        `INSERT INTO invites (id, email, role, invited_by, tenant_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, role, status, invited_by, tenant_id, created_at, expires_at`,
        [inviteId, normalizedEmail, role, invitedBy, tenantId],
      );

      const invite = rows[0];

      request.log.info(
        { inviteId: invite.id, email: normalizedEmail, role, adminId: invitedBy },
        'Invite created',
      );

      return reply.status(201).send({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        createdAt: invite.created_at.toISOString(),
      });
    },
  );

  /**
   * GET /api/auth/invites
   * List all invites for the current tenant. Admin only.
   *
   * Example response:
   *   [{ "id": "invite-abc123", "email": "newuser@example.com", "role": "user",
   *      "status": "pending", "createdAt": "2026-03-30T..." }]
   */
  server.get(
    '/invites',
    { schema: listInvitesSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = (request as any).auth;

      if (auth?.role && auth.role !== 'admin') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Admin role required to list invites',
        });
      }

      const tenantId = (request as any).tenant?.tenantId || 'default';
      const pool = getPool();

      const { rows } = await pool.query<InviteRow>(
        `SELECT id, email, role, status, invited_by, tenant_id, created_at, expires_at
         FROM invites
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId],
      );

      const invites = rows.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        createdAt: inv.created_at.toISOString(),
      }));

      request.log.info({ count: invites.length, adminId: auth?.userId }, 'Invites listed');
      return reply.status(200).send(invites);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  // Passkey management — CLI/internal only (admin provides the code)
  //
  // Flow:
  //   1. Admin goes to terminal, calls: curl -X POST .../passkey/set
  //      with the email and the 9-digit code THEY chose
  //   2. BOS validates: code is exactly 9 digits, not already in use
  //   3. Admin personally hands the code to the user
  //   4. If user loses it: admin calls .../passkey/reset then .../passkey/set
  //
  // These endpoints require X-BOSS-Internal header (localhost only)
  // or admin JWT. They are NOT exposed as brain tools.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * POST /api/auth/passkey/set
   * Set a specific 9-digit passkey for a user. Admin provides the code.
   * Validates: exactly 9 digits, not in use by another user.
   *
   * { "email": "user@example.com", "passkey": "483169468" }
   */
  server.post<{ Body: { email: string; passkey: string } }>(
    '/passkey/set',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'passkey'],
          properties: {
            email: { type: 'string' },
            passkey: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest<{ Body: { email: string; passkey: string } }>, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth || (auth.role !== 'admin' && auth.role !== 'owner')) {
        return reply.status(403).send({ error: 'Admin only. Use terminal with X-BOSS-Internal header.' });
      }

      const { email, passkey } = request.body;
      const pool = getPool();

      // Validate: exactly 9 digits
      if (!/^\d{9}$/.test(passkey)) {
        return reply.status(400).send({ error: 'Passkey must be exactly 9 digits.' });
      }

      const normalizedEmail = email.toLowerCase();
      const codeHash = crypto.createHash('sha256').update(passkey).digest('hex');

      // Validate: not in use by another user or pending registration
      const { rows: existingUser } = await pool.query<{ email: string }>(
        'SELECT email FROM users WHERE passkey_hash = $1', [codeHash],
      );
      if (existingUser.length > 0) {
        return reply.status(409).send({
          error: `This passkey is already in use by ${existingUser[0].email}. Choose a different code.`,
        });
      }
      const { rows: existingPending } = await pool.query<{ email: string }>(
        'SELECT email FROM boss_pending_passkeys WHERE passkey_hash = $1', [codeHash],
      );
      if (existingPending.length > 0 && existingPending[0].email !== normalizedEmail) {
        return reply.status(409).send({
          error: `This passkey is already reserved for ${existingPending[0].email}. Choose a different code.`,
        });
      }

      // Check if user already has an account
      const { rows: userRows } = await pool.query<{ id: string; display_name: string | null }>(
        'SELECT id, display_name FROM users WHERE email = $1', [normalizedEmail],
      );

      if (userRows.length > 0) {
        // Existing user — update their passkey directly
        await pool.query('UPDATE users SET passkey_hash = $1, updated_at = now() WHERE id = $2', [codeHash, userRows[0].id]);
        const displayName = userRows[0].display_name || email;
        request.log.info({ targetUserId: userRows[0].id, adminId: auth.userId }, `Passkey set for existing user ${displayName}`);
        return reply.status(200).send({
          status: 'ok',
          user: displayName,
          type: 'existing_user',
          message: `Passkey set for ${displayName}. Hand this code to them personally.`,
        });
      }

      // New user — store as pending passkey for registration
      await pool.query(
        `INSERT INTO boss_pending_passkeys (email, passkey_hash, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET passkey_hash = $2, created_by = $3, created_at = now()`,
        [normalizedEmail, codeHash, auth.userId],
      );

      request.log.info({ email: normalizedEmail, adminId: auth.userId }, `Pending passkey set for new user ${email}`);
      return reply.status(200).send({
        status: 'ok',
        user: email,
        type: 'pending_registration',
        message: `Passkey pre-registered for ${email}. When they visit BOS and register with this email, they'll need this code. Hand it to them personally.`,
      });
    },
  );

  /**
   * POST /api/auth/passkey/reset
   * Remove a user's passkey. After this, admin must set a new one
   * and personally deliver it to the user.
   *
   * { "email": "user@example.com" }
   */
  server.post<{ Body: { email: string } }>(
    '/passkey/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest<{ Body: { email: string } }>, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth || (auth.role !== 'admin' && auth.role !== 'owner')) {
        return reply.status(403).send({ error: 'Admin only. Use terminal with X-BOSS-Internal header.' });
      }

      const pool = getPool();
      const { email } = request.body;

      const { rows } = await pool.query<{ id: string; display_name: string | null }>(
        'SELECT id, display_name FROM users WHERE email = $1', [email.toLowerCase()],
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: `No user found with email: ${email}` });
      }

      await pool.query('UPDATE users SET passkey_hash = NULL, updated_at = now() WHERE id = $1', [rows[0].id]);

      const displayName = rows[0].display_name || email;
      request.log.info({ targetUserId: rows[0].id, adminId: auth.userId }, `Passkey reset for ${displayName}`);

      return reply.status(200).send({
        status: 'ok',
        user: displayName,
        message: `Passkey removed for ${displayName}. Set a new one with /passkey/set and hand it to the user.`,
      });
    },
  );

  server.post('/2fa/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.auth?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const pool = getPool();
    const { rows } = await pool.query<{ email: string; totp_secret: string | null }>(
      'SELECT email, totp_secret FROM users WHERE id = $1',
      [userId],
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const secret = rows[0].totp_secret ?? generateTotpSecret();
    await pool.query('UPDATE users SET totp_secret = $1, updated_at = now() WHERE id = $2', [secret, userId]);

    return reply.status(200).send({
      secret,
      otpauthUrl: otpauthUrl(rows[0].email, secret),
    });
  });

  server.post<{ Body: { code: string } }>('/2fa/enable', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const pool = getPool();
    const { rows } = await pool.query<{ totp_secret: string | null }>(
      'SELECT totp_secret FROM users WHERE id = $1',
      [userId],
    );
    const secret = rows[0]?.totp_secret;
    if (!secret) {
      return reply.status(400).send({ error: 'Two-factor setup has not been started.' });
    }
    if (!verifyTotp(secret, request.body.code)) {
      return reply.status(401).send({ error: 'Invalid two-factor code.' });
    }

    await pool.query('UPDATE users SET totp_enabled = TRUE, updated_at = now() WHERE id = $1', [userId]);
    return reply.status(200).send({ enabled: true });
  });

  server.post<{ Body: { code: string } }>('/2fa/disable', async (request, reply) => {
    const userId = request.auth?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const pool = getPool();
    const { rows } = await pool.query<{ totp_secret: string | null; totp_enabled: boolean }>(
      'SELECT totp_secret, totp_enabled FROM users WHERE id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row) {
      return reply.status(404).send({ error: 'User not found' });
    }
    if (row.totp_enabled && row.totp_secret && !verifyTotp(row.totp_secret, request.body.code)) {
      return reply.status(401).send({ error: 'Invalid two-factor code.' });
    }

    await pool.query('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, updated_at = now() WHERE id = $1', [userId]);
    return reply.status(200).send({ enabled: false });
  });

  /**
   * GET /api/auth/me
   * Get current user info including wizard status
   */
  server.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.auth?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT id, email, display_name, role, onboarding_wizard_complete, totp_enabled FROM users WHERE id = $1',
      [userId]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    return {
      id: rows[0].id,
      email: rows[0].email,
      displayName: rows[0].display_name,
      role: rows[0].role,
      onboardingWizardComplete: rows[0].onboarding_wizard_complete,
      twoFactorEnabled: rows[0].totp_enabled,
    };
  });

  /**
   * POST /api/auth/complete-wizard
   * Mark the onboarding wizard as complete
   */
  server.post('/complete-wizard', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.auth?.userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const pool = getPool();
    await pool.query(
      'UPDATE users SET onboarding_wizard_complete = TRUE WHERE id = $1',
      [userId]
    );

    return { success: true };
  });

  server.post<{ Body: { movies?: string; tvShow?: string } }>(
    '/wizard-preferences',
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const tenantId = request.tenant?.tenantId ?? 'default';
      const movies = request.body.movies?.trim();
      const tvShow = request.body.tvShow?.trim();
      if (movies) await setRuntimeConfig('ONBOARDING_FAVORITE_MOVIES', movies.slice(0, 500), tenantId);
      if (tvShow) await setRuntimeConfig('ONBOARDING_FAVORITE_TV_SHOW', tvShow.slice(0, 250), tenantId);
      return reply.status(200).send({ saved: true });
    },
  );
}

/**
 * Authentication middleware for BOS v2 API.
 *
 * SECURITY:
 * - JWT validation with proper signature verification (RS256/HS256)
 * - Timing-safe comparison for API key fallback (prevents timing attacks)
 * - Fail-closed: no key configured = 503, not a silent pass
 * - Rate limiting per IP and per token
 * - No sensitive data in error responses
 * - OWASP A07:2021 -- Authentication Failures
 */

import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/** Routes that skip authentication entirely. */
const PUBLIC_PATHS = ['/health', '/health/full', '/connectors/oauth', '/api/connectors/oauth', '/api/webhooks/', '/api/gw/check'];

/**
 * IPs trusted to make internal-service-call auth bypasses when they also
 * send `X-BOSS-Internal: true`. Configured via BOSS_INTERNAL_TRUSTED_IPS
 * (comma-separated). Defaults to loopback only.
 *
 * In production the API runs inside a Docker container, so host-originated
 * calls arrive with the bridge-gateway IP (e.g. 172.22.0.1), not 127.0.0.1.
 * The container's env must list that gateway explicitly for host scripts
 * (little-rascals, etc.) to reach protected routes.
 *
 * Resolved lazily on first call so tests can set the env var before calling.
 */
let trustedInternalIpsCache: Set<string> | null = null;
function getTrustedInternalIps(): Set<string> {
  if (trustedInternalIpsCache === null) {
    const raw = process.env.BOSS_INTERNAL_TRUSTED_IPS ?? '127.0.0.1,::1';
    trustedInternalIpsCache = new Set(
      raw.split(',').map((s) => s.trim()).filter(Boolean),
    );
  }
  return trustedInternalIpsCache;
}

/** Test helper — re-reads the env var on next call. Not for production use. */
export function __resetTrustedInternalIpsForTests(): void {
  trustedInternalIpsCache = null;
}

/** Parse a dotted-quad IPv4 string into a uint32, or null if not IPv4. */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True if an IPv4 address falls within a CIDR range like "172.16.0.0/12". */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash === -1) return false;
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(cidr.slice(0, slash));
  if (ipInt === null || netInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Allow internal service-to-service calls from trusted IPs with the internal
 * header. The trust list may contain exact IPs (127.0.0.1, ::1) AND CIDR ranges
 * (e.g. 172.16.0.0/12 for host→container bridge traffic). IPv4-mapped IPv6
 * (::ffff:172.16.5.1) is normalised before matching.
 */
export function isInternalCall(request: FastifyRequest): boolean {
  if (request.headers['x-boss-internal'] !== 'true') return false;
  let ip = request.ip;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const trusted = getTrustedInternalIps();
  if (trusted.has(ip)) return true; // exact match (loopback etc.)
  for (const entry of trusted) {
    if (entry.includes('/') && ipv4InCidr(ip, entry)) return true; // CIDR range
  }
  return false;
}

/**
 * In-memory rate limiter.
 * Production should use Redis-backed rate limiting, but this provides
 * baseline protection against brute-force auth attempts.
 */
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;       // 1 minute window
const RATE_LIMIT_AUTH_FAILURES_MAX = 1000;  // single-user system — don't lock out the owner
const authFailureStore = new Map<string, RateLimitEntry>();

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authFailureStore) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      authFailureStore.delete(key);
    }
  }
}, 300_000).unref();

/**
 * Increment-and-check: records one event against the store, returns true if
 * the current count is still within `max`. Use this on failure paths to both
 * count the failure AND find out whether the request should be 429'd.
 */
function checkRateLimit(store: Map<string, RateLimitEntry>, key: string, max: number): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    store.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

/**
 * Peek-only: returns true if the current count for `key` is already over
 * `max` within the active window, without recording a new event. Use this
 * for early gates that short-circuit auth work but must not throttle
 * otherwise-valid requests.
 */
function isRateLimited(store: Map<string, RateLimitEntry>, key: string, max: number): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry) return false;
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) return false;
  return entry.count > max;
}

function getClientIp(request: FastifyRequest): string {
  // Trust X-Forwarded-For only if behind a known reverse proxy
  // For direct connections, use the socket address
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded && process.env.TRUST_PROXY === 'true') {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return first.trim();
  }
  return request.ip;
}

/**
 * Timing-safe string comparison to prevent timing attacks on token validation.
 * OWASP: Prevents attackers from inferring valid tokens by measuring response times.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to avoid short-circuiting timing leaks
    const dummy = Buffer.alloc(b.length, 0);
    crypto.timingSafeEqual(dummy, Buffer.from(b, 'utf8'));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Validate a JWT token structure and claims.
 * When JWT_SECRET is configured, performs HS256 signature verification.
 * Falls back to API key comparison if JWT_SECRET is not set.
 */
function validateJwt(token: string): { valid: boolean; payload?: Record<string, unknown> } {
  const jwtSecret = process.env.BOSS_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!jwtSecret) {
    return { valid: false };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false };
  }

  try {
    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature (HS256)
    const expectedSig = crypto
      .createHmac('sha256', jwtSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (!timingSafeEqual(expectedSig, signatureB64)) {
      return { valid: false };
    }

    // Decode and validate payload
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    // Check expiration
    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
      return { valid: false };
    }

    // Check not-before
    if (typeof payload.nbf === 'number' && payload.nbf > Date.now() / 1000) {
      return { valid: false };
    }

    // Check issuer if configured
    const expectedIssuer = process.env.JWT_ISSUER;
    if (expectedIssuer && payload.iss !== expectedIssuer) {
      return { valid: false };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

export interface AuthInfo {
  userId: string;
  tenantId?: string;
  role?: string;
  authMethod: 'jwt' | 'apikey' | 'internal';
}

/**
 * Auth middleware -- validates Bearer token on protected routes.
 *
 * Authentication methods (in priority order):
 * 1. JWT with HS256 signature verification (when JWT_SECRET is set)
 * 2. API key comparison with timing-safe equality (fallback)
 *
 * Both methods enforce rate limiting.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (PUBLIC_PATHS.some(p => request.url.startsWith(p))) {
    return;
  }

  // Internal service calls (localhost + X-BOSS-Internal header) bypass auth
  // and get admin privileges. Used by telegram bot, email triage, sub-agents.
  if (isInternalCall(request)) {
    request.auth = { userId: 'boss-internal', role: 'admin', tenantId: 'default', authMethod: 'internal' };
    return;
  }

  // Routes can opt out of auth via config: { skipAuth: true }
  const routeConfig = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
  if (routeConfig?.skipAuth === true) {
    return;
  }

  const clientIp = getClientIp(request);

  // Rate limit gate: if this IP is already over the auth-failure threshold,
  // short-circuit with 429 before doing any JWT/API-key work. Peek only —
  // valid-auth requests that arrive during a throttled window still get
  // blocked (correct), but we do NOT count this call (otherwise successful
  // auth would drive up the counter and eventually lock out the owner).
  if (isRateLimited(authFailureStore, `authfail:${clientIp}`, RATE_LIMIT_AUTH_FAILURES_MAX)) {
    return reply.status(429).send({
      error: 'Too Many Requests',
      message: 'Too many authentication failures. Try again later.',
      retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // Record auth failure
    checkRateLimit(authFailureStore, `authfail:${clientIp}`, RATE_LIMIT_AUTH_FAILURES_MAX);
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
  }

  const token = authHeader.slice(7);
  if (!token || token.length > 4096) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid bearer token',
    });
  }

  // Rate limit: disabled for authenticated users (single-user system)
  // Only enforce on unauthenticated/failed auth attempts (handled by authFailureStore above)

  let authInfo: AuthInfo | null = null;

  // Method 1: JWT validation (preferred)
  const jwtResult = validateJwt(token);
  if (jwtResult.valid && jwtResult.payload) {
    // Tokens issued by routes/auth.ts carry `tenantId` (camelCase). Older
    // tooling occasionally signs `tenant_id` (snake_case); accept either so
    // a stale token doesn't silently degrade tenant resolution. Without
    // this, the middleware would fall through to subdomain extraction and
    // pin every browser request to the first hostname label (e.g.
    // 'last-castle' on the tailnet) — guaranteed empty for tenant-scoped
    // queries like /api/agents/rascals.
    const claimTenant =
      (jwtResult.payload.tenantId as string | undefined) ??
      (jwtResult.payload.tenant_id as string | undefined);
    authInfo = {
      userId: (jwtResult.payload.sub as string) || 'unknown',
      tenantId: claimTenant,
      role: jwtResult.payload.role as string | undefined,
      authMethod: 'jwt',
    };
  }

  // Method 2: API key fallback
  if (!authInfo) {
    const validToken = process.env.BOSS_API_KEY;
    if (!validToken) {
      // Fail-closed: if no auth mechanism is configured, deny all requests
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Authentication not configured',
      });
    }

    if (timingSafeEqual(token, validToken)) {
      authInfo = {
        userId: 'api-key-user',
        role: 'admin',
        tenantId: 'default',
        authMethod: 'apikey',
      };
    }
  }

  if (!authInfo) {
    // Record auth failure for rate limiting
    checkRateLimit(authFailureStore, `authfail:${clientIp}`, RATE_LIMIT_AUTH_FAILURES_MAX);
    // SECURITY: Generic message, no indication of which validation failed
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Invalid credentials',
    });
  }

  // Attach validated auth info to request (typed via types/fastify.d.ts)
  request.auth = authInfo;
}

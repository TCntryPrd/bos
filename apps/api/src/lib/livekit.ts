/**
 * livekit.ts — self-hosted LiveKit access tokens + signed guest invite codes.
 *
 * AccessToken = HS256 JWT signed with LIVEKIT_API_SECRET carrying a room-join video grant
 * (mirrors the hand-rolled JWT in routes/auth.ts — no extra dependency). Guest codes let a
 * human advisor join the public /join page with no BOS account.
 */
import crypto from 'node:crypto';

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://100.78.24.32:7880';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const GUEST_SECRET = process.env.BOSS_JWT_SECRET || process.env.LIVEKIT_API_SECRET || 'dev-guest-secret';

function b64url(input: string | Buffer): string {
  return (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');
}

export function liveKitConfigured(): boolean { return Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET); }
export function liveKitUrl(): string { return LIVEKIT_URL; }

/** Deterministic room name for a board (one persistent room per board). */
export function boardRoom(tenantId: string): string { return `board-${tenantId}`; }

/** Mint a LiveKit access token (HS256 JWT with a room-join video grant). */
export function mintAccessToken(opts: { identity: string; name: string; room: string; canPublish?: boolean; ttlSec?: number }): string {
  if (!liveKitConfigured()) throw new Error('LiveKit not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: LIVEKIT_API_KEY, sub: opts.identity, name: opts.name,
    nbf: now - 5, exp: now + (opts.ttlSec ?? 6 * 3600), jti: crypto.randomUUID(),
    video: { room: opts.room, roomJoin: true, canPublish: opts.canPublish ?? true, canSubscribe: true, canPublishData: true },
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', LIVEKIT_API_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const GUEST_CODE_TTL_SEC = Number(process.env.BOARD_GUEST_CODE_TTL_SEC || 30 * 24 * 3600); // 30 days default

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** A signed guest invite code (room + identity + name + expiry), HMAC-signed — the public join
 *  link. One dotless base64url blob = a clean single URL segment. Expires (default 30 days). */
export function mintGuestCode(payload: { room: string; identity: string; name: string }, ttlSec = GUEST_CODE_TTL_SEC): string {
  const claim = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64url(JSON.stringify(claim));
  const sig = crypto.createHmac('sha256', GUEST_SECRET).update(body).digest('base64url');
  return b64url(`${body}.${sig}`);
}
export function verifyGuestCode(code: string): { room: string; identity: string; name: string } | null {
  let inner: string;
  try { inner = Buffer.from(code || '', 'base64url').toString('utf8'); } catch { return null; }
  const dot = inner.lastIndexOf('.');
  if (dot < 1) return null;
  const body = inner.slice(0, dot); const sig = inner.slice(dot + 1);
  const expected = crypto.createHmac('sha256', GUEST_SECRET).update(body).digest('base64url');
  if (!timingSafeEq(sig, expected)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { room?: string; identity?: string; name?: string; exp?: number };
    if (!claim.room || !claim.identity || typeof claim.exp !== 'number' || claim.exp < Math.floor(Date.now() / 1000)) return null;
    return { room: claim.room, identity: claim.identity, name: claim.name || 'Guest' };
  } catch { return null; }
}

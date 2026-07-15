/**
 * Builder-mode live agent console — a read-only wiretap on agent CLI streams.
 *
 * Gated by BOSS_BUILDER_MODE=1 (builder installs only); when the flag is off
 * every call here is a no-op, so client boxes carry zero behavior.
 *
 * Redis layout:
 *   builder:buf:<id>   — RPUSH ring buffer of the last 2000 stream lines (24h TTL)
 *   builder:live:<id>  — pub/sub channel mirroring the buffer in real time
 *   builder:sessions   — hash id → {label, status, updatedAt} for the session list
 *
 * Fire-and-forget: Redis being down must never affect an agent turn.
 */
import Redis from 'ioredis';

const ENABLED = process.env.BOSS_BUILDER_MODE === '1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

let pub: Redis | null = null;
function client(): Redis {
  pub ??= new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
  return pub;
}

const MAX_LINES = 2000;
const TTL_SECONDS = 24 * 3600;

// Agents occasionally echo env vars and auth headers; mask the obvious shapes
// even in builder mode. Not exhaustive — the flag gate is the real boundary.
const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9._-]{40,})/g;

function mask(line: string): string {
  return line.replace(SECRET_RE, '[masked]');
}

export function builderEnabled(): boolean {
  return ENABLED;
}

export function builderRedisUrl(): string {
  return REDIS_URL;
}

/** Record one raw stream line for a session. Safe to call on every line. */
export function builderTap(sessionId: string, label: string, line: string): void {
  if (!ENABLED || !line) return;
  const ts = Date.now();
  const rec = JSON.stringify({ ts, line: mask(line).slice(0, 4000) });
  client()
    .multi()
    .rpush(`builder:buf:${sessionId}`, rec)
    .ltrim(`builder:buf:${sessionId}`, -MAX_LINES, -1)
    .expire(`builder:buf:${sessionId}`, TTL_SECONDS)
    .publish(`builder:live:${sessionId}`, rec)
    .hset('builder:sessions', sessionId, JSON.stringify({ label, status: 'live', updatedAt: ts }))
    .exec()
    .catch(() => { /* redis down — never fail the agent turn */ });
}

/** Mark a session finished/errored so the UI can stop the live indicator. */
export function builderStatus(
  sessionId: string,
  label: string,
  status: 'live' | 'finished' | 'error',
  note?: string,
): void {
  if (!ENABLED) return;
  const ts = Date.now();
  const rec = JSON.stringify({ ts, line: `[builder] session ${status}${note ? ` — ${note}` : ''}`, status });
  client()
    .multi()
    .hset('builder:sessions', sessionId, JSON.stringify({ label, status, updatedAt: ts }))
    .rpush(`builder:buf:${sessionId}`, rec)
    .expire(`builder:buf:${sessionId}`, TTL_SECONDS)
    .publish(`builder:live:${sessionId}`, rec)
    .exec()
    .catch(() => { /* ignore */ });
}

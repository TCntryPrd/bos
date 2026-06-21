/**
 * gw-auth — BOS-login gate + supervisor for the embedded Hermes dashboard
 * (the local "gateway" console: model, channels/Telegram, MCPs, config).
 *
 * The dashboard (hermes dashboard) serves the whole app — its UI, /api/*, and
 * a /ws websocket — at an origin root, so it's reverse-proxied at the
 * dedicated subdomain `gateway.<domain>` by the web nginx. Because it has NO
 * auth of its own, nginx gates every request with `auth_request → /api/gw/check`,
 * which validates a short-lived HMAC cookie that only a logged-in BOS user can
 * mint via POST /api/gw/grant.
 *
 *   POST /api/gw/grant  (BOS-authed) → Set-Cookie gw_auth (12h, signed)
 *   GET  /api/gw/check  (public)     → 200 if cookie valid, else 401
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

const COOKIE = 'gw_auth';
const TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_DOMAIN = process.env.BOSS_GW_COOKIE_DOMAIN || '.ircustomdashboards.tech';

function secret(): string {
  return process.env.BOSS_JWT_SECRET || process.env.BOSS_TOKEN_ENCRYPTION_KEY || 'boss-gw-fallback-secret';
}
function hmac(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}
function sign(exp: number): string {
  return `${exp}.${hmac(String(exp))}`;
}
function verify(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!exp || Number.isNaN(exp) || exp < Date.now()) return false;
  const expected = hmac(String(exp));
  try {
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export async function gwAuthRoutes(server: FastifyInstance): Promise<void> {
  // Authed BOS user mints the gateway cookie (Domain covers all subdomains).
  server.post('/grant', async (req, reply) => {
    if (!req.auth?.userId) return reply.status(401).send({ error: 'authentication required' });
    const token = sign(Date.now() + TTL_MS);
    reply.header(
      'Set-Cookie',
      `${COOKIE}=${token}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
    );
    return { ok: true };
  });

  // nginx auth_request subrequest — cookie only, no Bearer (public path).
  server.get('/check', async (req, reply) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    return verify(token) ? reply.status(200).send('ok') : reply.status(401).send('denied');
  });
}

// ── Dashboard supervisor ──────────────────────────────────────────────────────

const HERMES_BIN = process.env.BOSS_HERMES_BIN || '/home/boss/.hermes/hermes-agent/venv/bin/hermes';
let dashboardStarted = false;

/**
 * Keep the Hermes dashboard running on 0.0.0.0:9119 so the web nginx can
 * reverse-proxy it at the gateway subdomain. No-op when Hermes isn't installed
 * (e.g. the sandbox box). Respawns on exit. Best-effort — never throws.
 */
export function ensureHermesDashboard(): void {
  if (dashboardStarted) return;
  if (!existsSync(HERMES_BIN)) return; // Hermes not installed here — skip.
  dashboardStarted = true;
  const launch = () => {
    try {
      const proc = spawn(
        HERMES_BIN,
        ['dashboard', '--host', '0.0.0.0', '--port', '9119', '--no-open', '--skip-build', '--insecure'],
        {
          env: { ...process.env, HOME: process.env.BOSS_HOME_OVERRIDE || '/home/boss' },
          stdio: 'ignore',
          detached: false,
        },
      );
      proc.on('exit', () => { setTimeout(launch, 5000); });
      proc.on('error', () => { setTimeout(launch, 15000); });
    } catch {
      setTimeout(launch, 15000);
    }
  };
  launch();
}

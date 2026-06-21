import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { setRuntimeConfig, getRuntimeConfig } from '../config-store.js';

/**
 * /api/setup/hermes — first-login setup for the Hermes Agent.
 *
 * Hermes is Nous Research's open-source autonomous agent
 * (hermes-agent.nousresearch.com), installed per-box into the persistent
 * ./hermes-home mount. It runs on the tenant's own Gemini key (provider
 * auto-detect from GEMINI_API_KEY) — no Kevin credentials. Activation runs
 * one real headless turn (`hermes -z`) and stamps HERMES_READY so the
 * activation survives restarts.
 */

const HERMES_BIN = '/home/boss/.hermes/hermes-agent/venv/bin/hermes';
const ACTIVATE_TIMEOUT_MS = 160_000;

function requireAuthenticated(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.auth?.userId) {
    void reply.status(401).send({ error: 'authentication required' });
    return false;
  }
  return true;
}

function cliVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!existsSync(HERMES_BIN)) return resolve(null);
    try {
      const proc = spawn(HERMES_BIN, ['--version'], {
        env: { ...process.env, HOME: process.env.BOSS_HOME_OVERRIDE || '/home/boss' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null));
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(null); }, 30_000);
    } catch {
      resolve(null);
    }
  });
}

export async function hermesSetupRoutes(server: FastifyInstance) {
  server.get('/hermes/status', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    const version = await cliVersion();
    const key = process.env.GEMINI_API_KEY || (await getRuntimeConfig('GEMINI_API_KEY'));
    const ready = (await getRuntimeConfig('HERMES_READY')) === 'true';
    return {
      cliInstalled: version !== null,
      cliVersion: version,
      keyPresent: Boolean(key),
      model: 'hermes-agent (gemini)',
      ready,
    };
  });

  server.post('/hermes/activate', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;

    const key = process.env.GEMINI_API_KEY || (await getRuntimeConfig('GEMINI_API_KEY'));
    if (!key) {
      return reply.status(409).send({
        error: 'No Gemini API key found. Enter your Gemini key in Setup first.',
      });
    }
    if (!existsSync(HERMES_BIN)) {
      return reply.status(503).send({ error: 'Hermes Agent is not installed on this BOS.' });
    }

    const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      let out = '';
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ ok, output: out.slice(-4_000) });
      };
      try {
        const proc = spawn(HERMES_BIN, ['-z', 'You are Hermes, this BOS\'s autonomous agent. Reply with exactly: HERMES ONLINE'], {
          env: {
            ...process.env,
            GEMINI_API_KEY: key,
            HOME: process.env.BOSS_HOME_OVERRIDE || '/home/boss',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
        proc.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
        proc.on('error', (err) => { out += `\n[spawn error] ${err.message}`; finish(false); });
        proc.on('close', (code) => finish(code === 0 && /HERMES\s+ONLINE/i.test(out)));
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
          out += '\n[timed out]';
          finish(false);
        }, ACTIVATE_TIMEOUT_MS);
      } catch (err) {
        out += `\n[error] ${err instanceof Error ? err.message : String(err)}`;
        finish(false);
      }
    });

    if (result.ok) {
      try {
        await setRuntimeConfig('HERMES_READY', 'true', req.tenant?.tenantId ?? 'default');
      } catch (err) {
        req.log.warn({ err }, 'hermes/activate: could not persist HERMES_READY');
      }
    }

    return { ok: result.ok, output: result.output, model: 'hermes-agent' };
  });
}

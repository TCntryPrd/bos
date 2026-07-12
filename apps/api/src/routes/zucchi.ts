import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { setRuntimeConfig, getRuntimeConfig } from '../config-store.js';
import { materializeAttachments, type IncomingAttachment } from '../agents/chat-attachments.js';
import { getPool } from '../db.js';

/**
 * /api/zucchi/* — Hermes command-center backend.
 *
 * Hermes is Nous Research's autonomous agent (hermes-agent.nousresearch.com),
 * installed in the persistent ./hermes-home mount and run headless (`-z`) on
 * the tenant's own Gemini key (no Kevin credentials). The Google gemini CLI
 * is kept as an emergency fallback so a Hermes failure degrades instead of
 * dying. The page streams SSE events (session / message / error / done) and
 * reads a small markdown memory tree under the Hermes workspace.
 */

const WORKSPACE = process.env.BOSS_HERMES_WORKSPACE
  || join(process.env.BOSS_COO_WORKSPACE || '/home/boss/boss-dev', 'hermes-workspace');
const MEMORY_DIR = join(WORKSPACE, 'memory');
const HERMES_BIN = '/home/boss/.hermes/hermes-agent/venv/bin/hermes';
const HERMES_TURN_TIMEOUT_MS = 120_000; // real agent turn (python startup + tools)
const TURN_TIMEOUT_MS = 55_000; // per gemini-CLI fallback model
const MAX_HISTORY_TURNS = 12;

interface Turn { role: 'user' | 'assistant'; text: string; }
const sessions = new Map<string, { turns: Turn[]; updatedAt: number }>();
// Sticky model: once a model answers, lead with it so a flaky sibling only
// costs time on the first turn, not every turn.
let lastGoodModel: string | null = null;

function ensureWorkspace(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  const readme = join(MEMORY_DIR, 'hermes-context.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      '# Hermes operating context',
      '',
      'Markdown files in this folder are Hermes\'s working memory. Session',
      'transcripts are appended per conversation. Add notes here and Hermes',
      'can be asked to read and apply them.',
      '',
    ].join('\n'));
  }
}

function requireAuthenticated(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.auth?.userId) {
    void reply.status(401).send({ error: 'authentication required' });
    return false;
  }
  return true;
}

function cliInstalled(): boolean {
  return ['/usr/local/bin/gemini', '/usr/bin/gemini'].some((p) => existsSync(p));
}

async function geminiKey(): Promise<string | null> {
  return process.env.GEMINI_API_KEY || (await getRuntimeConfig('GEMINI_API_KEY'));
}

function buildPrompt(turns: Turn[], message: string): string {
  const lines = [
    'You are Hermes, the Gemini agent inside BOS (the Business Operating System).',
    'You are a concise, direct operator. Answer in short, useful replies.',
    '',
  ];
  for (const t of turns.slice(-MAX_HISTORY_TURNS * 2)) {
    lines.push(`${t.role === 'user' ? 'User' : 'Hermes'}: ${t.text}`);
  }
  lines.push(`User: ${message}`);
  lines.push('Hermes:');
  return lines.join('\n');
}

async function getHermesBossSession(tenantId: string, sessionId: string): Promise<string> {
  const pool = getPool();
  const found = await pool.query(
    `SELECT id FROM boss_chat_sessions WHERE tenant_id=$1 AND agent_kind='hermes' AND cc_session_id=$2 LIMIT 1`,
    [tenantId, sessionId],
  );
  if (found.rows[0]) return found.rows[0].id as string;
  const created = await pool.query(
    `INSERT INTO boss_chat_sessions (tenant_id, rascal_handle, agent_kind, name, model, cc_session_id)
     VALUES ($1, 'hermes', 'hermes', 'Hermes', 'hermes-cli', $2) RETURNING id`,
    [tenantId, sessionId],
  );
  return created.rows[0].id as string;
}

export async function zucchiRoutes(server: FastifyInstance) {
  server.get<{ Params: { sessionId: string } }>('/zucchi/chat/:sessionId', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    const tenantId = req.tenant?.tenantId ?? 'default';
    const pool = getPool();
    const sess = await pool.query(
      `SELECT id FROM boss_chat_sessions WHERE tenant_id=$1 AND agent_kind='hermes' AND cc_session_id=$2 LIMIT 1`,
      [tenantId, req.params.sessionId],
    );
    if (!sess.rows[0]) return reply.send({ turns: [] });
    const msgs = await pool.query(
      `SELECT role, content FROM boss_chat_messages WHERE session_id=$1 ORDER BY created_at ASC, id ASC`,
      [sess.rows[0].id],
    );
    return reply.send({ turns: msgs.rows.map((r: { role: string; content: string }) => ({ role: r.role, text: r.content })) });
  });

  // Reload chat history for a session (persists Hermes chat across navigation).
  server.get('/zucchi/overview', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    ensureWorkspace();
    const key = await geminiKey();
    const bin = cliInstalled();
    const last = await getRuntimeConfig('HERMES_LAST_TURN_AT');
    return {
      gateway: bin && Boolean(key) ? 'live' : 'down',
      agent: { id: 'hermes', model: process.env.GEMINI_MODEL || 'gemma-4-26b-a4b-it' },
      memoryReady: existsSync(MEMORY_DIR),
      workspaceReady: existsSync(WORKSPACE),
      binReady: bin,
      workspace: WORKSPACE,
      lastHeartbeatAt: last || null,
      errors: key ? [] : [{ source: 'config', stderrTail: 'No Gemini key — finish Setup first.' }],
    };
  });

  server.get('/zucchi/memory/files', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    ensureWorkspace();
    const files = readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const st = statSync(join(MEMORY_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { files };
  });

  server.get<{ Params: { file: string } }>('/zucchi/memory/files/:file', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    ensureWorkspace();
    const safe = basename(req.params.file);
    const full = join(MEMORY_DIR, safe);
    if (!safe.endsWith('.md') || !existsSync(full)) {
      return reply.status(404).send({ error: 'memory file not found' });
    }
    return { content: readFileSync(full, 'utf8').slice(0, 40_000) };
  });

  server.post<{ Body: { message?: string; sessionId?: string; attachments?: IncomingAttachment[] } }>('/zucchi/chat', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    const message = (req.body?.message || '').trim();
    if (!message) return reply.status(400).send({ error: 'message required' });

    const key = await geminiKey();
    if (!key) return reply.status(409).send({ error: 'No Gemini key configured — finish Setup first.' });
    if (!cliInstalled()) return reply.status(503).send({ error: 'Google CLI not installed on this BOS.' });

    ensureWorkspace();

    let sessionId = req.body?.sessionId || '';
    if (!sessionId || !sessions.has(sessionId)) {
      sessionId = `hermes-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(sessionId, { turns: [], updatedAt: Date.now() });
    }
    const session = sessions.get(sessionId)!;
    const hTenantId = req.tenant?.tenantId ?? 'default';
    const bossSessionId = await getHermesBossSession(hTenantId, sessionId);
    await getPool().query(`INSERT INTO boss_chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`, [bossSessionId, message]).catch(() => undefined);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sendEvent('session', { sessionId });

    const started = Date.now();
    let prompt = buildPrompt(session.turns, message);
    // Attachments → 0600 temp files under the Hermes workspace so the
    // gemini/hermes CLI (trust-workspace) can read them; append their paths.
    try {
      const { promptSuffix } = await materializeAttachments(req.body?.attachments, WORKSPACE);
      if (promptSuffix) prompt += promptSuffix;
    } catch (err) {
      req.log.warn({ err }, 'zucchi: attachment materialize failed');
    }

    const runTurn = (model: string) => new Promise<{ ok: boolean; text: string; err: string }>((resolve) => {
      let out = '';
      let errOut = '';
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ ok, text: out.trim(), err: errOut.slice(-1_000) });
      };
      try {
        const proc = spawn('gemini', ['-m', model, '-p', prompt], {
          cwd: WORKSPACE,
          env: {
            ...process.env,
            GEMINI_API_KEY: key,
            GEMINI_CLI_TRUST_WORKSPACE: 'true',
            HOME: process.env.BOSS_HOME_OVERRIDE || '/home/boss',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
        proc.stderr.on('data', (c: Buffer) => { errOut += c.toString('utf8'); });
        proc.on('error', (e) => { errOut += `\n[spawn] ${e.message}`; finish(false); });
        proc.on('close', (code) => finish(code === 0 && out.trim().length > 0));
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
          errOut += '\n[turn timed out]';
          finish(false);
        }, TURN_TIMEOUT_MS);
      } catch (e) {
        errOut += `\n[error] ${e instanceof Error ? e.message : String(e)}`;
        finish(false);
      }
    });

    // Real Hermes Agent turn (headless -z). Provider auto-detects from
    // GEMINI_API_KEY in the env.
    const runHermes = () => new Promise<{ ok: boolean; text: string; err: string }>((resolve) => {
      let out = '';
      let errOut = '';
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ ok, text: out.trim(), err: errOut.slice(-1_000) });
      };
      try {
        const proc = spawn(HERMES_BIN, ['-z', prompt], {
          cwd: WORKSPACE,
          env: {
            ...process.env,
            GEMINI_API_KEY: key,
            HOME: process.env.BOSS_HOME_OVERRIDE || '/home/boss',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
        proc.stderr.on('data', (c: Buffer) => { errOut += c.toString('utf8'); });
        proc.on('error', (e) => { errOut += `\n[spawn] ${e.message}`; finish(false); });
        proc.on('close', (code) => finish(code === 0 && out.trim().length > 0));
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
          errOut += '\n[hermes turn timed out]';
          finish(false);
        }, HERMES_TURN_TIMEOUT_MS);
      } catch (e) {
        errOut += `\n[error] ${e instanceof Error ? e.message : String(e)}`;
        finish(false);
      }
    });

    // Hermes Agent first; gemini-CLI model chain as emergency fallback so a
    // Hermes failure degrades instead of looking like a dead agent.
    let result: { ok: boolean; text: string; err: string } = { ok: false, text: '', err: '' };
    if (existsSync(HERMES_BIN)) {
      result = await runHermes();
      if (!result.ok) req.log.warn({ err: result.err.slice(-200) }, 'zucchi: hermes agent failed, falling back to gemini CLI');
    }
    if (!result.ok) {
      const configured = process.env.GEMINI_MODEL || 'gemma-4-26b-a4b-it';
      const chain = [...new Set([lastGoodModel ?? configured, configured, 'gemma-4-31b-it', 'gemini-2.5-flash'])];
      for (const model of chain) {
        result = await runTurn(model);
        if (result.ok) { lastGoodModel = model; break; }
        req.log.warn({ model, err: result.err.slice(-200) }, 'zucchi: model failed, trying next in chain');
      }
    }

    if (result.ok) {
      // Strip the loading/noise lines the CLI prints before the reply.
      const text = result.text
        .split('\n')
        .filter((l) => !/^(Loaded cached credentials|Data collection is disabled|.*256-color support.*)$/i.test(l.trim()))
        .join('\n')
        .trim();
      session.turns.push({ role: 'user', text: message }, { role: 'assistant', text });
      await getPool().query(`INSERT INTO boss_chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)`, [bossSessionId, text]).catch(() => undefined);
      session.updatedAt = Date.now();
      try {
        appendFileSync(
          join(MEMORY_DIR, `session-${sessionId}.md`),
          `\n## ${new Date().toISOString()}\n\n**User:** ${message}\n\n**Hermes:** ${text}\n`,
        );
        await setRuntimeConfig('HERMES_LAST_TURN_AT', new Date().toISOString(), req.tenant?.tenantId ?? 'default');
      } catch { /* bookkeeping is best-effort */ }
      sendEvent('message', { text });
      sendEvent('done', { durationMs: Date.now() - started });
    } else {
      sendEvent('error', { message: 'Hermes turn failed', stderrTail: result.err });
      sendEvent('done', { durationMs: Date.now() - started });
    }
    reply.raw.end();
  });
}

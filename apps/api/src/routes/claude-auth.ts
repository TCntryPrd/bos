import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface TerminalSession {
  id: string;
  ownerId: string;
  startedAt: number;
  updatedAt: number;
  output: string[];
  proc: ChildProcessWithoutNullStreams;
  exitCode: number | null;
  error: string | null;
}

interface InputBody {
  data?: string;
}

const sessions = new Map<string, TerminalSession>();
const MAX_BUFFER_CHARS = 80_000;
const IDLE_TTL_MS = 30 * 60 * 1000;
const AUTH_HOME = process.env.BOSS_HOME_OVERRIDE || '/home/boss';
const AUTH_WORKSPACE = process.env.BOSS_COO_WORKSPACE || '/home/boss/boss-dev';

const PTY_BRIDGE = String.raw`
import os, pty, select, signal, sys

pid, fd = pty.fork()
if pid == 0:
    env = os.environ.copy()
    home = env.get("BOSS_HOME_OVERRIDE") or env.get("HOME") or "/home/boss"
    env["HOME"] = home
    os.execvpe("claude", ["claude"], env)

signal.signal(signal.SIGCHLD, lambda *_: None)
stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()

while True:
    readable, _, _ = select.select([stdin_fd, fd], [], [])
    if fd in readable:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(stdout_fd, data)
    if stdin_fd in readable:
        data = os.read(stdin_fd, 4096)
        if not data:
            break
        os.write(fd, data)
`;

function requireAuthenticated(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.auth?.userId) {
    void reply.status(401).send({ error: 'authentication required' });
    return false;
  }
  return true;
}

function canAccessSession(req: FastifyRequest, session: TerminalSession): boolean {
  const role = req.auth?.role;
  return session.ownerId === req.auth?.userId || role === 'admin' || role === 'owner';
}

function appendOutput(session: TerminalSession, text: string) {
  session.output.push(text);
  const joined = session.output.join('');
  if (joined.length > MAX_BUFFER_CHARS) {
    session.output = [joined.slice(-MAX_BUFFER_CHARS)];
  }
  session.updatedAt = Date.now();
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const stale = now - session.updatedAt > IDLE_TTL_MS;
    if (stale) {
      try { session.proc.kill('SIGTERM'); } catch { /* already gone */ }
      sessions.delete(id);
    }
  }
}

function sessionPayload(session: TerminalSession) {
  return {
    id: session.id,
    startedAt: new Date(session.startedAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    running: session.exitCode === null,
    exitCode: session.exitCode,
    error: session.error,
    output: session.output.join(''),
  };
}

export async function claudeAuthRoutes(server: FastifyInstance) {
  server.get('/claude-auth/status', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    cleanupSessions();
    return {
      home: AUTH_HOME,
      workspace: AUTH_WORKSPACE,
      claudeDirReady: existsSync(`${AUTH_HOME}/.claude`),
      claudeJsonReady: existsSync(`${AUTH_HOME}/.claude.json`),
      workspaceReady: existsSync(AUTH_WORKSPACE),
      activeSessions: sessions.size,
    };
  });

  server.post('/claude-auth/start', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    cleanupSessions();

    const ownerId = req.auth?.userId || 'admin';
    for (const existing of sessions.values()) {
      if (existing.ownerId === ownerId && existing.exitCode === null) {
        return sessionPayload(existing);
      }
    }

    if (!existsSync(AUTH_WORKSPACE)) {
      return reply.status(500).send({ error: `workspace missing: ${AUTH_WORKSPACE}` });
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const proc = spawn('python3', ['-u', '-c', PTY_BRIDGE], {
      cwd: AUTH_WORKSPACE,
      env: {
        ...process.env,
        HOME: AUTH_HOME,
        BOSS_HOME_OVERRIDE: AUTH_HOME,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: TerminalSession = {
      id,
      ownerId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      output: [],
      proc,
      exitCode: null,
      error: null,
    };
    sessions.set(id, session);

    proc.stdout.on('data', (chunk: Buffer) => appendOutput(session, chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => appendOutput(session, chunk.toString('utf8')));
    proc.on('error', (err) => {
      session.error = err.message;
      appendOutput(session, `\n[terminal error] ${err.message}\n`);
    });
    proc.on('close', (code) => {
      session.exitCode = code;
      session.updatedAt = Date.now();
      appendOutput(session, `\n[terminal closed: ${code ?? 'unknown'}]\n`);
    });

    return sessionPayload(session);
  });

  server.get<{ Params: { id: string } }>('/claude-auth/sessions/:id/output', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    cleanupSessions();
    const session = sessions.get(req.params.id);
    if (!session) return reply.status(404).send({ error: 'terminal session not found' });
    if (!canAccessSession(req, session)) return reply.status(403).send({ error: 'terminal session forbidden' });
    return sessionPayload(session);
  });

  server.post<{ Params: { id: string }; Body: InputBody }>('/claude-auth/sessions/:id/input', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    const session = sessions.get(req.params.id);
    if (!session) return reply.status(404).send({ error: 'terminal session not found' });
    if (!canAccessSession(req, session)) return reply.status(403).send({ error: 'terminal session forbidden' });
    if (session.exitCode !== null) return reply.status(409).send({ error: 'terminal session is closed' });
    const data = typeof req.body?.data === 'string' ? req.body.data : '';
    if (data.length > 4_000) return reply.status(400).send({ error: 'input too long' });
    session.proc.stdin.write(data);
    session.updatedAt = Date.now();
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/claude-auth/sessions/:id/stop', async (req, reply) => {
    if (!requireAuthenticated(req, reply)) return;
    const session = sessions.get(req.params.id);
    if (!session) return reply.status(404).send({ error: 'terminal session not found' });
    if (!canAccessSession(req, session)) return reply.status(403).send({ error: 'terminal session forbidden' });
    try { session.proc.kill('SIGTERM'); } catch { /* already gone */ }
    sessions.delete(req.params.id);
    return { ok: true };
  });
}

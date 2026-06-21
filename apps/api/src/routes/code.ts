/**
 * Code routes — /api/code/*
 *
 * API-owned agent lifecycle. Per the BOS v2.1 container rule
 * (handoff section 2.2), the rascal/agent claude CC runs on the host
 * in a tmux session managed via apps/api/src/agents/host-bridge.ts.
 * The API tails the CC session JSONL file for output and pastes user
 * messages into the tmux pane for input. Browsers connect to the SSE
 * stream independently of the agent's host process. General mode (no
 * active agent) routes through the brain API.
 *
 * Endpoints:
 *   GET  /stream               — SSE stream (reconnectable, 200-event buffer replay)
 *   POST /agent/start          — start agent {projectDir, model?}. Kills any running agent first.
 *   POST /agent/stop           — stop current agent
 *   GET  /agent/status         — {active, agent, projectDir, busy, sessionId, uptime}
 *   POST /send                 — send message to active agent or general brain
 *   GET  /projects             — list projects from /home/boss/clients/
 *   GET  /projects/:name/files — file tree for a project
 *   GET  /projects/:name/file  — read a file (?path=relative/path)
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, basename, extname } from 'node:path';
import { request as httpRequest } from 'node:http';
import {
  callBridge,
  jsonlPathFor,
  jsonlSize,
  waitForJsonl,
  tailJsonlUntil,
} from '../agents/host-bridge.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENTS_DIR = '/home/boss/clients';
const BRAIN_API_URL = 'http://localhost:8010/api/brain/chat/stream';
const MAX_BUFFER = 200;

// Additional project directories beyond clients/
const EXTRA_PROJECTS: Array<{ name: string; displayName: string; path: string }> = [
  { name: 'boss-main', displayName: 'BOS Main', path: '/home/boss/sp-hub' },
];

/** Resolve project name to directory — checks extras first, then clients */
function resolveProjectDir(name: string): string | null {
  const extra = EXTRA_PROJECTS.find((p) => p.name === name);
  if (extra && existsSync(extra.path)) return extra.path;
  const clientDir = join(CLIENTS_DIR, name);
  if (existsSync(clientDir)) return clientDir;
  return null;
}

// ── Agent CLI / Ollama routing ───────────────────────────────────────────────

/** Agents that use Ollama (gemma4) instead of Claude Code */
const OLLAMA_AGENTS = new Set(['01-industry-rockstarr', '03-ai-district']);
const OLLAMA_URL = 'http://172.17.0.1:11434/api/generate';
const OLLAMA_MODEL = 'gemma4';

function isOllamaAgent(agentName: string): boolean {
  return OLLAMA_AGENTS.has(agentName);
}

/**
 * Send a message to Ollama via REST API (streaming).
 * Used for lightweight agents that don't need Claude Code.
 */
function sendToOllama(message: string) {
  if (!activeAgent) throw new Error('No active agent');
  if (activeAgent.busy) throw new Error('Agent is busy — wait for current response');

  const state = activeAgent;
  state.busy = true;

  pushEvent({
    type: 'user',
    data: { message, mode: 'agent' },
    timestamp: Date.now(),
  });

  // Read the agent's CLAUDE.md for system prompt context
  let systemPrompt = '';
  try {
    const ctxPath = join(state.projectDir, 'CLAUDE.md');
    if (existsSync(ctxPath)) {
      systemPrompt = readFileSync(ctxPath, 'utf8');
    }
  } catch { /* no context file */ }

  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    prompt: message,
    system: systemPrompt,
    stream: true,
  });

  const url = new URL(OLLAMA_URL);
  const req = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let fullResponse = '';
      res.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.response) {
              fullResponse += parsed.response;
              pushEvent({
                type: 'assistant',
                subtype: 'text',
                data: { text: parsed.response },
                timestamp: Date.now(),
              });
            }
          } catch { /* partial JSON line */ }
        }
      });

      res.on('end', () => {
        pushEvent({
          type: 'assistant',
          subtype: 'message',
          data: { message: fullResponse.trim(), role: 'assistant' },
          timestamp: Date.now(),
        });
        pushEvent({
          type: 'result',
          data: { message: fullResponse.trim() },
          timestamp: Date.now(),
        });
        if (activeAgent === state) {
          state.busy = false;
        }
      });
    },
  );

  req.on('error', (err) => {
    pushEvent({
      type: 'system',
      subtype: 'error',
      data: { message: `Ollama error: ${err.message}` },
      timestamp: Date.now(),
    });
    if (activeAgent === state) {
      state.busy = false;
    }
  });

  req.write(body);
  req.end();
}

// ── Session Recap (BOS Main) ──────────────────────────────────────────────

const RECAP_FILE = '/home/boss/sp-hub/.boss-session-recap.json';
const RECAP_EXCHANGE_COUNT = 4;

interface RecapExchange {
  user: string;
  assistant: string;
  timestamp: number;
}

/** Check if a project is BOS Main (no auto-resume, uses recap) */
function isBossMain(projectDir: string): boolean {
  return projectDir === '/home/boss/sp-hub';
}

/** Read saved recap exchanges */
function readRecap(): RecapExchange[] {
  try {
    if (existsSync(RECAP_FILE)) {
      return JSON.parse(readFileSync(RECAP_FILE, 'utf8'));
    }
  } catch { /* corrupt file */ }
  return [];
}

/** Save recap exchanges from the current session's event buffer */
function saveRecapFromBuffer(): void {
  if (!activeAgent || !isBossMain(activeAgent.projectDir)) return;

  const exchanges: RecapExchange[] = [];
  let currentUser: { message: string; ts: number } | null = null;

  for (const evt of eventBuffer) {
    if (evt.type === 'user' && evt.data.message) {
      currentUser = { message: evt.data.message as string, ts: evt.timestamp };
    } else if (evt.type === 'assistant' && evt.data.message && currentUser) {
      exchanges.push({
        user: currentUser.message,
        assistant: (evt.data.message as string).slice(0, 2000),
        timestamp: currentUser.ts,
      });
      currentUser = null;
    }
  }

  if (exchanges.length > 0) {
    const last = exchanges.slice(-RECAP_EXCHANGE_COUNT);
    try {
      writeFileSync(RECAP_FILE, JSON.stringify(last, null, 2));
    } catch { /* write failed */ }
  }
}

/** Build a context prompt for a new BOS Main session */
function buildRecapPrompt(): string | null {
  const parts: string[] = [];

  // 1. Live session context from the tmux lead engineer
  const ctxFile = '/home/boss/sp-hub/BOSS_SESSION_CONTEXT.md';
  try {
    if (existsSync(ctxFile)) {
      const ctx = readFileSync(ctxFile, 'utf8').trim();
      if (ctx) parts.push('## LIVE CONTEXT (from the active tmux lead engineer session)\n\n' + ctx);
    }
  } catch { /* no context file */ }

  // 2. Memory index
  const memFile = '/home/boss/.claude/projects/-home-tcntryprd-sp-hub/memory/MEMORY.md';
  try {
    if (existsSync(memFile)) {
      const mem = readFileSync(memFile, 'utf8').trim();
      if (mem) parts.push('## MEMORY INDEX\n\n' + mem);
    }
  } catch { /* no memory */ }

  // 3. Last few exchanges from previous Code page sessions
  const exchanges = readRecap();
  if (exchanges.length > 0) {
    let recapText = '## LAST CODE PAGE SESSION EXCHANGES\n\n';
    for (const ex of exchanges) {
      const ts = new Date(ex.timestamp).toLocaleString('en-US', { timeZone: 'America/Chicago' });
      recapText += `**Kevin** (${ts}):\n${ex.user}\n\n`;
      recapText += `**You responded**:\n${ex.assistant}\n\n---\n\n`;
    }
    parts.push(recapText);
  }

  if (parts.length === 0) return null;

  return 'YOU ARE THE BOSS LEAD ENGINEER — the same mind as the tmux session Kevin runs alongside you. Read this context to get current, present a brief recap of where things stand, then ask Kevin what he wants to work on.\n\n' + parts.join('\n\n---\n\n');
}

/** Save recap from a session .jsonl file */
function saveRecapFromSession(sessionId: string, projectDir: string): void {
  if (!isBossMain(projectDir)) return;

  const claudeProjectDir = join(
    process.env.HOME || '/home/boss',
    '.claude/projects',
    projectDir.replace(/\//g, '-'),
  );
  const jsonlPath = join(claudeProjectDir, `${sessionId}.jsonl`);

  if (!existsSync(jsonlPath)) return;

  try {
    const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    const exchanges: RecapExchange[] = [];
    let lastUserMsg: { text: string; ts: number } | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'human' && entry.message?.content) {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((b: { text?: string }) => b.text || '').join('');
          if (text.trim()) {
            lastUserMsg = { text: text.trim(), ts: entry.timestamp || Date.now() };
          }
        } else if (entry.type === 'assistant' && entry.message?.content && lastUserMsg) {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((b: { text?: string }) => b.text || '').join('');
          if (text.trim()) {
            exchanges.push({
              user: lastUserMsg.text,
              assistant: text.trim().slice(0, 2000),
              timestamp: lastUserMsg.ts,
            });
            lastUserMsg = null;
          }
        }
      } catch { /* skip bad lines */ }
    }

    if (exchanges.length > 0) {
      writeFileSync(RECAP_FILE, JSON.stringify(exchanges.slice(-RECAP_EXCHANGE_COUNT), null, 2));
    }
  } catch { /* file read failed */ }
}

// File extensions we'll serve for the file reader
const READABLE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonl', '.yaml', '.yml', '.toml',
  '.md', '.txt', '.sh', '.bash', '.zsh',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.html', '.css', '.scss', '.sass', '.less',
  '.sql', '.graphql', '.proto',
  '.env', '.env.example', '.gitignore', '.dockerignore',
  '.Dockerfile', '', // no extension (Makefile, Dockerfile, etc.)
]);

// Directories to skip when building file trees
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo',
  '__pycache__', '.pytest_cache', 'venv', '.venv', 'coverage',
  '.cache', 'tmp', '.tmp',
]);

// Max files returned per project tree scan
const MAX_TREE_FILES = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

interface CodeEvent {
  type: string;
  subtype?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface AgentState {
  /** Set while a turn is being tailed. `.abort()` interrupts the turn. */
  abortController: AbortController | null;
  projectDir: string;
  agentName: string;
  model: string;
  /** Claude Code session UUID. Doubles as the host-bridge chat id, so
   *  the tmux session name is boss-chat-<sessionId>. Null until the
   *  first turn mints one. */
  sessionId: string | null;
  startedAt: Date;
  busy: boolean;
}

interface FileNode {
  name: string;
  path: string;         // relative to project root
  type: 'file' | 'dir';
  size?: number;
  ext?: string;
  children?: FileNode[];
}

// ── Global state ──────────────────────────────────────────────────────────────

/** The single active agent process, if any. */
let activeAgent: AgentState | null = null;

/** SSE event buffer — shared across all connections. */
const eventBuffer: CodeEvent[] = [];

/** Broadcast to all live SSE connections. */
const broadcaster = new EventEmitter();
broadcaster.setMaxListeners(100);

// ── Buffer helpers ────────────────────────────────────────────────────────────

function pushEvent(evt: CodeEvent) {
  eventBuffer.push(evt);
  if (eventBuffer.length > MAX_BUFFER) {
    eventBuffer.splice(0, eventBuffer.length - MAX_BUFFER);
  }
  broadcaster.emit('event', evt);
}

// ── Process management ────────────────────────────────────────────────────────

function stopAgent() {
  if (!activeAgent) return;

  // Save session recap for BOS Main before clearing state
  if (isBossMain(activeAgent.projectDir)) {
    if (activeAgent.sessionId) {
      saveRecapFromSession(activeAgent.sessionId, activeAgent.projectDir);
    } else {
      saveRecapFromBuffer();
    }
  }

  // Abort any in-flight tail and kill the host tmux chat. Bridge call
  // is fire-and-forget; we don't block agent_stopped on it.
  if (activeAgent.abortController) {
    try { activeAgent.abortController.abort(); } catch { /* ignore */ }
  }
  if (activeAgent.sessionId) {
    callBridge('kill-chat', [activeAgent.sessionId]).catch(() => { /* best-effort */ });
  }
  const name = activeAgent.agentName;
  activeAgent = null;
  pushEvent({
    type: 'system',
    subtype: 'agent_stopped',
    data: { agent: name },
    timestamp: Date.now(),
  });
}

function startAgent(projectDir: string, model?: string): AgentState {
  // Kill any existing agent first
  stopAgent();

  // Clear the event buffer so the new agent doesn't show old messages
  eventBuffer.length = 0;

  const agentName = basename(projectDir);
  const bossMain = isBossMain(projectDir);

  // Find the most recent session for this project to auto-resume
  // BOS Main always starts fresh (uses recap instead)
  let lastSessionId: string | null = null;
  if (!bossMain) {
    try {
      const claudeProjectDir = join(
        process.env.HOME || '/home/boss',
        '.claude/projects',
        projectDir.replace(/\//g, '-')
      );
      if (existsSync(claudeProjectDir)) {
        const sessions = readdirSync(claudeProjectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({
            id: f.replace('.jsonl', ''),
            mtime: statSync(join(claudeProjectDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);
        if (sessions.length > 0) {
          lastSessionId = sessions[0].id;
        }
      }
    } catch { /* no previous sessions */ }
  }

  const state: AgentState = {
    abortController: null,
    projectDir,
    agentName,
    model: model || 'default',
    sessionId: lastSessionId,
    startedAt: new Date(),
    busy: false,
  };

  activeAgent = state;

  pushEvent({
    type: 'system',
    subtype: 'agent_started',
    data: { agent: agentName, projectDir, model: state.model },
    timestamp: Date.now(),
  });

  return state;
}

/**
 * Send a message to the active agent.
 * Ollama agents: REST API to local Ollama (gemma4).
 * Claude agents: `claude -p --resume` CLI spawn.
 */
function sendToAgent(message: string) {
  if (!activeAgent) throw new Error('No active agent');

  // Route Ollama agents to REST handler
  if (isOllamaAgent(activeAgent.agentName)) {
    // For BOS Main recap — not applicable to Ollama agents, but keep consistent
    let actualMessage = message;
    if (isBossMain(activeAgent.projectDir) && !activeAgent.sessionId) {
      const recapPrompt = buildRecapPrompt();
      if (recapPrompt) {
        actualMessage = recapPrompt + '\n\nKevin\'s new message:\n' + message;
      }
    }
    return sendToOllama(actualMessage);
  }

  if (activeAgent.busy) throw new Error('Agent is busy — wait for current response');

  const state = activeAgent;
  state.busy = true;

  pushEvent({
    type: 'user',
    data: { message, mode: 'agent' },
    timestamp: Date.now(),
  });

  // For BOS Main: inject recap context on the FIRST message of a new session
  let actualMessage = message;
  if (isBossMain(state.projectDir) && !state.sessionId) {
    const recapPrompt = buildRecapPrompt();
    if (recapPrompt) {
      actualMessage = recapPrompt + '\n\nKevin\'s new message:\n' + message;
    }
  }

  // Claude path runs on host via boss-host-bridge.sh (BOS
  // v2.1 section 2.2: rascals/agents must act on host). One tmux per
  // active agent, name boss-chat-<sessionId>. session_id either
  // resumed from disk (lastSessionId set at startAgent) or minted now.
  const ccSessionId = state.sessionId ?? randomUUID();
  state.sessionId = ccSessionId;

  void (async () => {
    try {
      const bridgeArgs = [
        ccSessionId,
        state.projectDir,
        ccSessionId,
        'danger=true',
      ];
      if (state.model && state.model !== 'default') {
        bridgeArgs.push(`model=${state.model}`);
      }
      await callBridge('new-chat', bridgeArgs);

      // CC writes the JSONL lazily on first user input, so snapshot
      // size now (0 if missing for a brand-new session) and wait for
      // the file to appear AFTER send if needed.
      const jsonlPath = jsonlPathFor(state.projectDir, ccSessionId);
      const cursor = await jsonlSize(jsonlPath);

      await callBridge('send', [ccSessionId], { stdin: actualMessage });

      if (cursor === 0) {
        await waitForJsonl(jsonlPath, 15_000);
      }

      const abortCtl = new AbortController();
      state.abortController = abortCtl;

      const onFrame = (frame: Record<string, unknown>) => {
        pushEvent({
          type: typeof frame.type === 'string' ? frame.type : 'frame',
          subtype: typeof frame.subtype === 'string' ? frame.subtype : undefined,
          data: frame,
          timestamp: Date.now(),
        });
      };
      // End-of-turn: track the `user` echo (CC writes the user prompt
      // to JSONL when it accepts it). Until the echo is observed, any
      // assistant stop_reason is from background work already in
      // flight (scheduled tasks, queue operations) on a resumed
      // session, not from our turn.
      let sawUserEcho = false;
      const isTurnEnd = (frame: Record<string, unknown>): boolean => {
        if (frame.type === 'user') { sawUserEcho = true; return false; }
        if (!sawUserEcho) return false;
        if (frame.type !== 'assistant') return false;
        const m = frame.message as { stop_reason?: string | null } | undefined;
        return typeof m?.stop_reason === 'string' && m.stop_reason.length > 0;
      };

      await tailJsonlUntil(jsonlPath, cursor, onFrame, isTurnEnd, {
        signal: abortCtl.signal,
        idleTimeoutMs: 120_000,
      });

      // Synthesize a result event so the buffer/SSE clients see a turn
      // boundary they can render. Mirrors what stream-json emitted.
      pushEvent({
        type: 'result',
        data: { session_id: ccSessionId },
        timestamp: Date.now(),
      });
    } catch (err) {
      if (!(err as { aborted?: boolean }).aborted) {
        pushEvent({
          type: 'system',
          subtype: 'error',
          data: { message: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now(),
        });
      }
    } finally {
      if (activeAgent === state) {
        state.busy = false;
        state.abortController = null;
      }
    }
  })();
}

/**
 * Forward a message to the brain API (general mode) and relay the SSE stream
 * back into the event buffer so SSE clients see it just like agent output.
 */
function sendToBrain(message: string): void {
  pushEvent({
    type: 'user',
    data: { message, mode: 'general' },
    timestamp: Date.now(),
  });

  const body = JSON.stringify({ message, conversationId: 'code-general' });

  const req = httpRequest(
    BRAIN_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let textAccum = '';

      res.on('data', (chunk: Buffer) => {
        const raw = chunk.toString('utf8');
        // Parse SSE lines from brain stream
        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              // Re-emit as assistant text chunks so frontend can render normally
              if (parsed.type === 'chunk' && parsed.text) {
                textAccum += parsed.text;
                pushEvent({
                  type: 'assistant',
                  subtype: 'text_chunk',
                  data: { text: parsed.text, mode: 'general' },
                  timestamp: Date.now(),
                });
              } else if (parsed.type === 'thinking') {
                pushEvent({
                  type: 'assistant',
                  subtype: 'tool_use',
                  data: { tool: parsed.tool, status: parsed.status, mode: 'general' },
                  timestamp: Date.now(),
                });
              } else if (parsed.type === 'done' || parsed.type === 'end') {
                pushEvent({
                  type: 'result',
                  subtype: 'general_done',
                  data: { mode: 'general', fullText: textAccum },
                  timestamp: Date.now(),
                });
              }
            } catch {
              // Non-JSON SSE line — skip
            }
          }
        }
      });

      res.on('end', () => {
        if (textAccum) {
          // Ensure we emit a result event even if done event was missed
          pushEvent({
            type: 'result',
            subtype: 'general_done',
            data: { mode: 'general', fullText: textAccum },
            timestamp: Date.now(),
          });
        }
      });

      res.on('error', (err) => {
        pushEvent({
          type: 'system',
          subtype: 'error',
          data: { message: `Brain API error: ${err.message}`, mode: 'general' },
          timestamp: Date.now(),
        });
      });
    },
  );

  req.on('error', (err) => {
    pushEvent({
      type: 'system',
      subtype: 'error',
      data: { message: `Brain API connection failed: ${err.message}`, mode: 'general' },
      timestamp: Date.now(),
    });
  });

  req.write(body);
  req.end();
}

// ── File tree helpers ─────────────────────────────────────────────────────────

function buildFileTree(dir: string, rootDir: string, depth = 0, count = { n: 0 }): FileNode[] {
  if (count.n >= MAX_TREE_FILES) return [];
  if (depth > 8) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];

  for (const entry of entries.sort()) {
    if (entry.startsWith('.') && depth === 0) {
      // Show dotfiles at root level only if they're config files
      const ok = ['.env', '.env.example', '.gitignore', '.dockerignore', 'CLAUDE.md'].includes(entry);
      if (!ok) continue;
    }

    const fullPath = join(dir, entry);
    const relPath = relative(rootDir, fullPath);

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      count.n++;
      if (count.n >= MAX_TREE_FILES) break;

      nodes.push({
        name: entry,
        path: relPath,
        type: 'dir',
        children: buildFileTree(fullPath, rootDir, depth + 1, count),
      });
    } else if (stat.isFile()) {
      count.n++;
      if (count.n >= MAX_TREE_FILES) break;

      nodes.push({
        name: entry,
        path: relPath,
        type: 'file',
        size: stat.size,
        ext: extname(entry).toLowerCase(),
      });
    }
  }

  return nodes;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function codeRoutes(server: FastifyInstance) {

  // ── SSE stream ────────────────────────────────────────────────────────────
  server.get<{ Querystring: { since?: string } }>(
    '/stream',
    { config: { skipAuth: true } },
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (eventType: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // Client disconnected
        }
      };

      // Send current agent status immediately on connect
      write('status', {
        active: !!activeAgent,
        agent: activeAgent?.agentName ?? null,
        projectDir: activeAgent?.projectDir ?? null,
        busy: activeAgent?.busy ?? false,
        sessionId: activeAgent?.sessionId ?? null,
        mode: activeAgent ? 'agent' : 'general',
      });

      // Replay buffer for reconnecting clients
      const since = request.query.since ? parseInt(request.query.since, 10) : 0;
      for (const evt of eventBuffer) {
        if (evt.timestamp > since) {
          write('code_event', evt);
        }
      }

      // Stream live events
      const onEvent = (evt: CodeEvent) => {
        write('code_event', evt);
      };
      broadcaster.on('event', onEvent);

      // Heartbeat to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          cleanup();
        }
      }, 15000);

      const cleanup = () => {
        clearInterval(heartbeat);
        broadcaster.removeListener('event', onEvent);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    },
  );

  // ── Start agent ───────────────────────────────────────────────────────────
  server.post<{ Body: { projectDir: string; model?: string } }>(
    '/agent/start',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { projectDir, model } = request.body || {};
      if (!projectDir) return reply.status(400).send({ error: 'projectDir required' });

      // Resolve and validate the path stays within allowed roots
      const resolved = resolve(projectDir);
      const allowedRoots = [CLIENTS_DIR, '/home/boss/boss-dev', '/home/boss/sp-hub'];
      if (!allowedRoots.some((root) => resolved.startsWith(root))) {
        return reply.status(400).send({ error: 'projectDir must be under an allowed root' });
      }

      if (!existsSync(resolved)) {
        return reply.status(400).send({ error: `Directory not found: ${resolved}` });
      }

      try {
        const agent = startAgent(resolved, model);
        return reply.status(200).send({
          status: 'started',
          agent: agent.agentName,
          projectDir: agent.projectDir,
          model: agent.model,
          sessionId: agent.sessionId,
        });
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── Stop agent ────────────────────────────────────────────────────────────
  server.post(
    '/agent/stop',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      if (!activeAgent) {
        return reply.status(200).send({ status: 'no_agent' });
      }
      const name = activeAgent.agentName;
      stopAgent();
      return reply.status(200).send({ status: 'stopped', agent: name });
    },
  );

  // ── Interrupt current message (kill host tmux, keep agent active) ────────
  // Aborts the JSONL tail and tells the host bridge to kill the
  // boss-chat-<sessionId> tmux. The CC session JSONL remains on
  // disk, so the next message resumes from where it left off via
  // --resume (handled by bridge new-chat auto-detection).
  server.post(
    '/agent/interrupt',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      if (!activeAgent) {
        return reply.status(200).send({ status: 'no_agent' });
      }
      if (!activeAgent.busy) {
        return reply.status(200).send({ status: 'not_busy', agent: activeAgent.agentName });
      }
      if (activeAgent.abortController) {
        try { activeAgent.abortController.abort(); } catch { /* ignore */ }
      }
      if (activeAgent.sessionId) {
        callBridge('kill-chat', [activeAgent.sessionId]).catch(() => { /* best-effort */ });
      }
      activeAgent.abortController = null;
      activeAgent.busy = false;
      pushEvent({
        type: 'system',
        subtype: 'interrupted',
        data: { agent: activeAgent.agentName },
        timestamp: Date.now(),
      });
      return reply.status(200).send({ status: 'interrupted', agent: activeAgent.agentName });
    },
  );

  // ── Compact session (clear buffer, reset context) ───────────────────────
  // Kills the host tmux + clears sessionId so the next message creates
  // a fresh CC session (new UUID, no --resume).
  server.post(
    '/agent/compact',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      // Clear the event buffer
      eventBuffer.length = 0;

      // If agent is active, abort + kill host tmux + clear session so
      // next message starts fresh.
      if (activeAgent) {
        if (activeAgent.abortController) {
          try { activeAgent.abortController.abort(); } catch { /* ignore */ }
        }
        if (activeAgent.sessionId) {
          callBridge('kill-chat', [activeAgent.sessionId]).catch(() => { /* best-effort */ });
        }
        activeAgent.sessionId = null;
        activeAgent.abortController = null;
        activeAgent.busy = false;
      }

      pushEvent({
        type: 'system',
        subtype: 'compacted',
        data: { message: 'Session compacted, context cleared' },
        timestamp: Date.now(),
      });

      return reply.status(200).send({
        status: 'compacted',
        agent: activeAgent?.agentName ?? null,
      });
    },
  );

  // ── Agent status ──────────────────────────────────────────────────────────
  server.get(
    '/agent/status',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      if (!activeAgent) {
        return reply.send({
          active: false,
          agent: null,
          projectDir: null,
          busy: false,
          sessionId: null,
          mode: 'general',
        });
      }
      return reply.send({
        active: true,
        agent: activeAgent.agentName,
        projectDir: activeAgent.projectDir,
        busy: activeAgent.busy,
        sessionId: activeAgent.sessionId,
        model: activeAgent.model,
        uptime: Date.now() - activeAgent.startedAt.getTime(),
        mode: 'agent',
      });
    },
  );

  // ── Send message ──────────────────────────────────────────────────────────
  server.post<{ Body: { message: string } }>(
    '/send',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { message } = request.body || {};
      if (!message?.trim()) return reply.status(400).send({ error: 'message required' });

      try {
        if (activeAgent) {
          sendToAgent(message);
          return reply.status(200).send({ status: 'sent', mode: 'agent', agent: activeAgent.agentName });
        } else {
          sendToBrain(message);
          return reply.status(200).send({ status: 'sent', mode: 'general' });
        }
      } catch (err) {
        return reply.status(503).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── List projects ─────────────────────────────────────────────────────────
  server.get(
    '/projects',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      let entries: string[];
      try {
        entries = readdirSync(CLIENTS_DIR);
      } catch {
        return reply.send([]);
      }

      const projects = entries
        .filter((entry) => {
          // Skip archived and hidden directories
          if (entry === 'archived' || entry.startsWith('.')) return false;
          try {
            return statSync(join(CLIENTS_DIR, entry)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((name) => {
          const dir = join(CLIENTS_DIR, name);
          let stat: ReturnType<typeof statSync>;
          try {
            stat = statSync(dir);
          } catch {
            return null;
          }

          // Generate display name: keep number prefix so Kevin can see active client count
          const numMatch = name.match(/^(\d+)-/);
          const numPrefix = numMatch ? numMatch[1] + '. ' : '';
          let displayName = numPrefix + name.replace(/^\d+-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          try {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            if (pkg.name) displayName = pkg.name;
          } catch {
            // No package.json — use generated name
          }

          // Check for CLAUDE.md to confirm it's an agent project
          const hasClaude = existsSync(join(dir, 'CLAUDE.md'));

          return {
            name,
            displayName,
            path: dir,
            hasClaude,
            modifiedAt: stat.mtime.toISOString(),
          };
        })
        .filter(Boolean)
        // Sort: numbered agents first (by number), then unnumbered alphabetically
        .sort((a, b) => {
          const aNum = a!.name.match(/^(\d+)-/);
          const bNum = b!.name.match(/^(\d+)-/);
          if (aNum && bNum) return parseInt(aNum[1]) - parseInt(bNum[1]);
          if (aNum && !bNum) return -1;
          if (!aNum && bNum) return 1;
          return a!.name.localeCompare(b!.name);
        });

      // Add extra project directories (BOS Main, etc.)
      for (const extra of EXTRA_PROJECTS) {
        try {
          const stat = statSync(extra.path);
          if (stat.isDirectory()) {
            projects.push({
              name: extra.name,
              displayName: extra.displayName,
              path: extra.path,
              hasClaude: existsSync(join(extra.path, 'CLAUDE.md')),
              modifiedAt: stat.mtime.toISOString(),
            });
          }
        } catch {
          // Skip if directory doesn't exist
        }
      }

      return reply.send(projects);
    },
  );

  // ── Project file tree ─────────────────────────────────────────────────────
  server.get<{ Params: { name: string } }>(
    '/projects/:name/files',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { name } = request.params;

      // Sanitize — no path traversal
      if (name.includes('..') || name.includes('/')) {
        return reply.status(400).send({ error: 'Invalid project name' });
      }

      const projectDir = resolveProjectDir(name);
      if (!projectDir) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      try {
        const tree = buildFileTree(projectDir, projectDir);
        return reply.send({
          project: name,
          path: projectDir,
          tree,
        });
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── Read a project file ───────────────────────────────────────────────────
  server.get<{ Params: { name: string }; Querystring: { path: string } }>(
    '/projects/:name/file',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { name } = request.params;
      const { path: relPath } = request.query;

      if (!relPath) return reply.status(400).send({ error: 'path query param required' });
      if (name.includes('..') || name.includes('/')) {
        return reply.status(400).send({ error: 'Invalid project name' });
      }

      const projectDir = resolveProjectDir(name);
      if (!projectDir) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      // Resolve and ensure the final path stays inside the project
      const fullPath = resolve(join(projectDir, relPath));
      if (!fullPath.startsWith(projectDir + '/') && fullPath !== projectDir) {
        return reply.status(400).send({ error: 'Path escapes project directory' });
      }

      if (!existsSync(fullPath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        return reply.status(404).send({ error: 'File not found' });
      }

      if (!stat.isFile()) {
        return reply.status(400).send({ error: 'Path is not a file' });
      }

      // Size guard — don't serve files over 500KB
      if (stat.size > 500 * 1024) {
        return reply.status(413).send({ error: 'File too large (max 500KB)' });
      }

      try {
        const content = readFileSync(fullPath, 'utf8');
        return reply.send({
          project: name,
          path: relPath,
          content,
          size: stat.size,
          ext: extname(fullPath).toLowerCase(),
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

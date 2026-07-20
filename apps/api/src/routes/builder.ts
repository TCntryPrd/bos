/**
 * Read-only, ephemeral agent activity routes.
 *
 * There is deliberately no replay endpoint and no write path. A browser only
 * receives lines emitted after it connects; disconnecting loses them.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import {
  builderEnabled,
  builderSessions,
  subscribeBuilderStream,
  type BuilderStreamRecord,
} from '../lib/builder-stream.js';
import { callBridge, jsonlPathFor, jsonlSize } from '../agents/host-bridge.js';
import { agentRuntimeId, type AgentRuntimeKind } from '../agents/agent-runtime-id.js';
import { redactLiveJson, redactLiveOutput } from '../agents/live-output-redaction.js';
import { getPool } from '../db.js';

/**
 * Return only complete, newly appended JSONL frames. The browser's initial
 * cursor is set to the current EOF, so this is a true live view: refreshes
 * intentionally do not replay an agent's prior terminal or JSONL history.
 */
async function readNewJsonlFrames(path: string, cursor: number): Promise<{
  cursor: number;
  frames: string[];
}> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch { return { cursor, frames: [] }; }
  if (bytes.length <= cursor) return { cursor: bytes.length, frames: [] };
  const appended = bytes.subarray(cursor);
  const lastNewline = appended.lastIndexOf(0x0a);
  if (lastNewline < 0) return { cursor, frames: [] };
  const complete = appended.subarray(0, lastNewline + 1).toString('utf8');
  const frames: string[] = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // The user frame carries the fully enriched request and retrieved memory.
      // Keep the viewer ephemeral but avoid echoing that private context; the
      // assistant's live JSONL frames show the actual work and final recap.
      if (parsed.type !== 'assistant') continue;
      frames.push(JSON.stringify(redactLiveJson(parsed)));
    } catch {
      // JSONL must remain valid; an incomplete/corrupt line is not terminal UI.
    }
  }
  return { cursor: cursor + lastNewline + 1, frames };
}

export async function builderRoutes(server: FastifyInstance): Promise<void> {
  server.addHook('onRequest', async (_req, reply) => {
    if (!builderEnabled()) {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  server.get('/sessions', async () => ({ sessions: builderSessions() }));

  // Direct view of a permanent per-agent shell. The baseline is captured only
  // after this browser connects, so refresh clears the viewer without storing
  // or replaying terminal output.
  server.get<{ Params: { kind: string; handle: string } }>('/agent/:kind/:handle', async (req, reply) => {
    const kind = req.params.kind.trim().toLowerCase() as AgentRuntimeKind;
    const handle = req.params.handle.trim().toLowerCase();
    if (!['rascal', 'outsider'].includes(kind) || !/^[a-z][a-z0-9._-]{1,31}$/.test(handle)) {
      return reply.code(400).send({ error: 'bad agent stream target' });
    }
    const tenantId = req.tenant?.tenantId ?? 'default';
    const table = kind === 'rascal' ? 'boss_rascals' : 'boss_outsiders';
    const exists = await getPool().query<{ project_dir: string }>(
      `SELECT project_dir FROM ${table} WHERE tenant_id = $1 AND handle = $2 AND enabled = true`,
      [tenantId, handle],
    );
    if (exists.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });
    const runtimeId = agentRuntimeId(tenantId, kind, handle);
    const projectDir = exists.rows[0]?.project_dir ?? '';

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': agent shell connected\n\n');

    let baselineLines: string[] = [];
    let baselineReady = false;
    let lastSnapshot = '';
    let inFlight = false;
    let closed = false;
    let consecutiveFailures = 0;
    let attachErrorSent = false;
    let jsonlSessionId = '';
    let jsonlCursor = 0;

    const attachJsonl = async (sessionId: string, baseline: boolean) => {
      if (!projectDir || !sessionId || sessionId === jsonlSessionId) return;
      jsonlSessionId = sessionId;
      jsonlCursor = baseline ? await jsonlSize(jsonlPathFor(projectDir, sessionId)) : 0;
    };

    const emitNewJsonl = async () => {
      if (!projectDir || !jsonlSessionId) return;
      const path = jsonlPathFor(projectDir, jsonlSessionId);
      const next = await readNewJsonlFrames(path, jsonlCursor);
      jsonlCursor = next.cursor;
      for (const frame of next.frames) {
        reply.raw.write(`data: ${JSON.stringify({
          ts: Date.now(),
          sessionId: `agent:${handle}`,
          label: `claude:${handle}`,
          line: frame.slice(-64_000),
          mode: 'line',
        })}\n\n`);
      }
    };

    try {
      const initial = await callBridge('agent-capture', [runtimeId], { timeoutMs: 4_000 });
      baselineLines = typeof initial.pane === 'string' ? redactLiveOutput(initial.pane).split('\n') : [];
      if (typeof initial.sessionId === 'string') await attachJsonl(initial.sessionId, true);
      baselineReady = true;
    } catch {
      // The reconciler may still be creating this shell; the poller retries.
    }

    const capture = async () => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const result = await callBridge('agent-capture', [runtimeId], { timeoutMs: 4_000 });
        const pane = typeof result.pane === 'string' ? redactLiveOutput(result.pane) : '';
        if (typeof result.sessionId === 'string' && result.sessionId) {
          // A new session appeared after this viewer connected, so stream it
          // from its beginning. The initial session was explicitly baselined.
          await attachJsonl(result.sessionId, false);
        }
        await emitNewJsonl();
        const paneLines = pane.split('\n');
        consecutiveFailures = 0;
        attachErrorSent = false;
        if (!baselineReady) {
          baselineLines = paneLines;
          baselineReady = true;
          return;
        }
        let common = 0;
        while (
          common < baselineLines.length
          && common < paneLines.length
          && baselineLines[common] === paneLines[common]
        ) common += 1;
        const snapshot = paneLines.slice(common).slice(-160).join('\n').trimEnd();
        if (snapshot && snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          reply.raw.write(`data: ${JSON.stringify({
            ts: Date.now(),
            sessionId: `agent:${handle}`,
            label: `claude:${handle}`,
            line: snapshot.slice(-64_000),
            status: 'live',
            mode: 'snapshot',
          })}\n\n`);
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5 && !attachErrorSent) {
          attachErrorSent = true;
          reply.raw.write(`data: ${JSON.stringify({
            ts: Date.now(),
            sessionId: `agent:${handle}`,
            label: `claude:${handle}`,
            line: 'Unable to attach to the permanent agent shell.',
            status: 'error',
            mode: 'line',
          })}\n\n`);
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => { void capture(); }, 700);
    req.raw.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    return reply;
  });

  // Mirror an established persistent tmux directly while this page is open.
  // The first pane is only a baseline; nothing is replayed on refresh.
  server.get<{
    Params: { id: string };
    Querystring: { handle?: string };
  }>('/tmux/:id', async (req, reply) => {
    const { id } = req.params;
    const handle = (req.query.handle ?? '').trim().toLowerCase();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(id) || !/^[a-z]{2,32}$/.test(handle)) {
      return reply.code(400).send({ error: 'bad tmux stream target' });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': tmux activity connected\n\n');

    let baselineLines: string[] = [];
    let baselineReady = false;
    let lastSnapshot = '';
    let inFlight = false;
    let closed = false;
    let consecutiveFailures = 0;
    let attachErrorSent = false;

    try {
      const initial = await callBridge('capture', [id], { timeoutMs: 4_000 });
      baselineLines = typeof initial.pane === 'string' ? redactLiveOutput(initial.pane).split('\n') : [];
      baselineReady = true;
    } catch {
      // A freshly restarted API can miss the first SSH bridge handshake.
      // Let the poller retry before reporting an attachment problem.
    }

    const capture = async () => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        const result = await callBridge('capture', [id], { timeoutMs: 4_000 });
        const pane = typeof result.pane === 'string' ? redactLiveOutput(result.pane) : '';
        if (!pane) return;
        const paneLines = pane.split('\n');
        consecutiveFailures = 0;
        attachErrorSent = false;
        if (!baselineReady) {
          baselineLines = paneLines;
          baselineReady = true;
          return;
        }
        let common = 0;
        while (
          common < baselineLines.length &&
          common < paneLines.length &&
          baselineLines[common] === paneLines[common]
        ) common += 1;
        const snapshot = paneLines.slice(common).slice(-120).join('\n').trimEnd();
        if (snapshot && snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          reply.raw.write(`data: ${JSON.stringify({
            ts: Date.now(), sessionId: id, label: `claude:${handle}`,
            line: snapshot.slice(-48_000), status: 'live', mode: 'snapshot',
          })}\n\n`);
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5 && !attachErrorSent) {
          attachErrorSent = true;
          reply.raw.write(`data: ${JSON.stringify({
            ts: Date.now(), sessionId: id, label: `claude:${handle}`,
            line: 'Unable to attach to the active tmux session.', status: 'error', mode: 'line',
          })}\n\n`);
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => { void capture(); }, 700);
    req.raw.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    return reply;
  });

  const openStream = (req: FastifyRequest, reply: FastifyReply, id: string | null) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': live activity connected\n\n');

    const onRecord = (record: BuilderStreamRecord) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(record)}\n\n`);
      } catch {
        // The close handler performs cleanup.
      }
    };
    const unsubscribe = subscribeBuilderStream(id, onRecord);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': hb\n\n'); } catch { /* closed */ }
    }, 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  };

  // The tile connects immediately and receives every agent run from that point
  // forward, so it does not miss the beginning while polling session metadata.
  server.get('/live', async (req, reply) => openStream(req, reply, null));

  server.get('/stream/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id)) {
      return reply.code(400).send({ error: 'bad session id' });
    }
    return openStream(req, reply, id);
  });
}

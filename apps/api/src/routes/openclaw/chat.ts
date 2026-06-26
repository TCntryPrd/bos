/**
 * POST /api/openclaw/chat — SSE chat endpoint for the Gio dashboard.
 *
 * Body: { message: string, conversationId?: string, newConversation?: boolean, attachments?: [...] }
 *
 * Streams (currently buffered-then-flushed; see chatTurn.ts header) SSE
 * events:
 *   event: message  data: { text, mediaUrl }   — one per agent payload
 *   event: done     data: { durationMs, usage, model, provider, aborted }
 *   event: error    data: { exitCode, stderrTail, message }   — on failure
 *
 * Heartbeat ":hb\n\n" every 15s prevents proxy idle-timeouts.
 * Client disconnect does not kill the Codex subprocess. The DB message
 * table is the reconnect bridge.
 */
import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getPool } from '../../db.js';
import { startChatTurn, type ChatAttachment } from '../../openclaw/chatTurn.js';

interface ChatBody {
  message?: string;
  conversationId?: string;
  dbSessionId?: string;
  newConversation?: boolean;
  attachments?: Array<{
    name?: string;
    mimeType?: string;
    dataUrl?: string;
    text?: string;
  }>;
}

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CONTEXT_CHARS = 72_000;
const MAX_MESSAGE_CONTEXT_CHARS = 12_000;
const GIO_ATTACHMENT_ROOT = process.env.BOSS_GIO_ATTACHMENT_ROOT ?? '/home/boss/gio/.tmp';
const RECENT_CONTEXT_MESSAGES = 4;
const GIO_HANDLE = 'gio';
const GIO_KIND = 'gio';
const GIO_WORKSPACE = process.env.BOSS_GIO_WORKSPACE ?? '/home/boss/gio';

interface ChatSessionRow {
  id: string;
  name: string;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: Date;
}

interface ActiveTurn {
  interrupt: () => void;
  assistantMessageId: string;
}

const activeTurns = new Map<string, ActiveTurn>();

function tenantOf(request: { tenant?: { tenantId?: string }; headers: Record<string, unknown> }): string {
  return request.tenant?.tenantId ?? (request.headers['x-tenant-id'] as string | undefined) ?? 'default';
}

function shapeMessage(row: ChatMessageRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
  };
}

async function ensureGioSession(tenantId: string, requestedId?: string): Promise<ChatSessionRow> {
  if (requestedId) {
    const existing = await getPool().query<ChatSessionRow>(
      `SELECT id, name
         FROM boss_chat_sessions
        WHERE id = $1 AND tenant_id = $2 AND agent_kind = $3 AND rascal_handle = $4 AND archived = FALSE`,
      [requestedId, tenantId, GIO_KIND, GIO_HANDLE],
    );
    if (existing.rows[0]) return existing.rows[0];
  }

  const current = await getPool().query<ChatSessionRow>(
    `SELECT id, name
       FROM boss_chat_sessions
      WHERE tenant_id = $1 AND agent_kind = $2 AND rascal_handle = $3 AND archived = FALSE
      ORDER BY updated_at DESC
      LIMIT 1`,
    [tenantId, GIO_KIND, GIO_HANDLE],
  );
  if (current.rows[0]) return current.rows[0];

  const created = await getPool().query<ChatSessionRow>(
    `INSERT INTO boss_chat_sessions
       (tenant_id, rascal_handle, agent_kind, name, model, system_prompt, workspace_dir)
     VALUES ($1, $2, $3, 'Gio', 'codex-cli', $4, $5)
     RETURNING id, name`,
    [
      tenantId,
      GIO_HANDLE,
      GIO_KIND,
      `Gio is the COE Codex operator surface. Durable memory lives under ${GIO_WORKSPACE}.`,
      GIO_WORKSPACE,
    ],
  );
  return created.rows[0];
}

async function createGioSession(tenantId: string, name = 'Gio'): Promise<ChatSessionRow> {
  const created = await getPool().query<ChatSessionRow>(
    `INSERT INTO boss_chat_sessions
       (tenant_id, rascal_handle, agent_kind, name, model, system_prompt, workspace_dir)
     VALUES ($1, $2, $3, $4, 'codex-cli', $5, $6)
     RETURNING id, name`,
    [
      tenantId,
      GIO_HANDLE,
      GIO_KIND,
      name,
      `Gio is the COE Codex operator surface. Durable memory lives under ${GIO_WORKSPACE}.`,
      GIO_WORKSPACE,
    ],
  );
  return created.rows[0];
}

async function loadRecentConversationMessages(sessionId: string): Promise<ChatMessageRow[]> {
  const rows = await getPool().query<ChatMessageRow>(
    `SELECT * FROM (
       SELECT id, session_id, role, content, tokens_in, tokens_out, created_at
         FROM boss_chat_messages
        WHERE session_id = $1
          AND COALESCE(content, '') <> ''
        ORDER BY created_at DESC
        LIMIT $2
     ) recent
     ORDER BY created_at ASC`,
    [sessionId, RECENT_CONTEXT_MESSAGES],
  );
  return rows.rows;
}

async function readGioMemoryIndex(): Promise<string> {
  try {
    return (await fs.readFile(path.join(GIO_WORKSPACE, 'MEMORY.md'), 'utf8')).slice(0, 12_000);
  } catch {
    return 'MEMORY.md was not readable for this turn.';
  }
}

function truncateContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated to keep Gio web-chat context bounded]`;
}

function buildCodexPrompt(memoryIndex: string, priorMessages: ChatMessageRow[], currentMessage: string): string {
  const transcript = priorMessages
    .map((msg) => {
      const speaker = msg.role === 'assistant' ? 'Gio' : msg.role === 'user' ? 'Operator' : 'System';
      return `${speaker}:\n${truncateContext(msg.content.trim(), MAX_MESSAGE_CONTEXT_CHARS)}`;
    })
    .join('\n\n---\n\n');

  const prompt = [
    'You are Gio, the COE Codex operator surface inside BOS.',
    'This Codex process is disposable. Do not rely on Codex CLI session state for continuity.',
    'Use only the bounded context below for this turn: Gio memory index, recent DB chat turns, and the current operator message.',
    'Target loop: understand expectation, execute the next concrete step, report results against expectation, then either continue with the next safe action or ask for specific clarification.',
    `Work from ${GIO_WORKSPACE} and follow its AGENTS.md, CLAUDE.md, and MEMORY.md instructions.`,
    `## Gio Memory Index\n\n${memoryIndex}`,
    transcript ? `## Recent DB Conversation Context\n\n${transcript}` : '## Recent DB Conversation Context\n\nNo prior messages are stored for this conversation.',
    `## Current Operator Message\n\n${currentMessage}`,
  ].join('\n\n');
  return truncateContext(prompt, MAX_CONTEXT_CHARS);
}

async function persistPartial(
  messageId: string,
  text: string,
  force: boolean,
  state: { lastPersistedAt: number; lastPersistedLen: number },
): Promise<void> {
  const now = Date.now();
  const grew = text.length !== state.lastPersistedLen;
  const stale = now - state.lastPersistedAt > 2_000;
  if (!force && !(grew && stale)) return;
  state.lastPersistedAt = now;
  state.lastPersistedLen = text.length;
  await getPool().query(
    `UPDATE boss_chat_messages
        SET content = $2
      WHERE id = $1`,
    [messageId, text],
  );
}

function safeAttachmentName(name: string | undefined, index: number): string {
  const cleaned = (name || `attachment-${index}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return cleaned || `attachment-${index}`;
}

async function materializeAttachments(body: ChatBody): Promise<{ promptSuffix: string; files: ChatAttachment[]; tempDir: string | null }> {
  const incoming = (body.attachments ?? []).slice(0, MAX_ATTACHMENTS);
  if (incoming.length === 0) return { promptSuffix: '', files: [], tempDir: null };

  await fs.mkdir(GIO_ATTACHMENT_ROOT, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(GIO_ATTACHMENT_ROOT, 'gio-chat-'));
  const files: ChatAttachment[] = [];
  const notes: string[] = [];

  for (const [index, attachment] of incoming.entries()) {
    const name = safeAttachmentName(attachment.name, index + 1);
    const mimeType = attachment.mimeType || 'application/octet-stream';

    if (attachment.dataUrl) {
      const comma = attachment.dataUrl.indexOf(',');
      const b64 = comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1);
      const bytes = Buffer.from(b64, 'base64');
      const maxBytes = mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (bytes.byteLength > maxBytes) {
        notes.push(`- ${name}: skipped, file exceeded ${maxBytes / 1024 / 1024}MB.`);
        continue;
      }
      const ext = path.extname(name) || (
        mimeType === 'image/png' ? '.png'
          : mimeType === 'image/webp' ? '.webp'
            : mimeType.startsWith('image/') ? '.jpg'
              : '.bin'
      );
      const filePath = path.join(tempDir, `${index + 1}-${name}${path.extname(name) ? '' : ext}`);
      await fs.writeFile(filePath, bytes, { mode: 0o600 });
      if (mimeType.startsWith('image/')) {
        files.push({ path: filePath, mimeType, name });
        notes.push(`- ${name}: attached image (${mimeType}) at ${filePath}.`);
      } else {
        notes.push(`- ${name}: uploaded file (${mimeType}, ${bytes.byteLength} bytes) at ${filePath}. Read this path directly if needed; do not quote sensitive contents back unless the operator explicitly asks.`);
      }
    } else if (typeof attachment.text === 'string' && attachment.text.trim()) {
      const text = attachment.text;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        notes.push(`- ${name}: skipped, text attachment exceeded ${MAX_FILE_BYTES / 1024}KB.`);
        continue;
      }
      const filePath = path.join(tempDir, `${index + 1}-${name}${path.extname(name) ? '' : '.txt'}`);
      await fs.writeFile(filePath, text, { mode: 0o600 });
      notes.push(`- ${name}: uploaded text file (${mimeType}, ${bytes} bytes) at ${filePath}. Read this path directly if needed; do not quote sensitive contents back unless the operator explicitly asks.`);
    } else {
      notes.push(`- ${name}: metadata only (${mimeType}); no readable file payload arrived.`);
    }
  }

  const promptSuffix = notes.length > 0
    ? `\n\nAttached files from the operator:\n${notes.join('\n\n')}`
    : '';
  return { promptSuffix, files, tempDir };
}

export async function chatRoute(server: FastifyInstance): Promise<void> {
  server.get<{ Querystring: { conversationId?: string; sessionId?: string; limit?: string } }>('/api/openclaw/chat/messages', async (request, reply) => {
    const tenantId = tenantOf(request);
    const requestedId = request.query.conversationId ?? request.query.sessionId;
    const session = await ensureGioSession(tenantId, requestedId);
    const requestedLimit = Number(request.query.limit ?? '50');
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(50, Math.trunc(requestedLimit)))
      : 50;
    const rows = await getPool().query<ChatMessageRow>(
      `SELECT * FROM (
         SELECT id, session_id, role, content, tokens_in, tokens_out, created_at
           FROM boss_chat_messages
          WHERE session_id = $1
            AND NOT (role = 'assistant' AND COALESCE(content, '') = '')
          ORDER BY created_at DESC
          LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [session.id, limit],
    );
    return reply.send({
      conversationId: session.id,
      sessionId: session.id,
      name: session.name,
      messages: rows.rows.map(shapeMessage),
      limit,
    });
  });

  server.post<{ Body: { conversationId?: string; sessionId?: string } }>('/api/openclaw/chat/interrupt', async (request, reply) => {
    const tenantId = tenantOf(request);
    const requestedId = request.body?.conversationId ?? request.body?.sessionId;
    const session = await ensureGioSession(tenantId, requestedId);
    const active = activeTurns.get(session.id);
    if (!active) return reply.send({ ok: true, interrupted: false, conversationId: session.id, sessionId: session.id });

    active.interrupt();
    await getPool().query(
      `UPDATE boss_chat_messages
          SET content = CASE
            WHEN COALESCE(content, '') = '' THEN '[interrupted]'
            WHEN content LIKE '%[interrupted]' THEN content
            ELSE content || E'\n\n[interrupted]'
          END
        WHERE id = $1`,
      [active.assistantMessageId],
    );
    return reply.send({ ok: true, interrupted: true, conversationId: session.id, sessionId: session.id });
  });

  server.post<{ Body: ChatBody }>('/api/openclaw/chat', async (request, reply) => {
    const message = (request.body?.message ?? '').trim();
    const tenantId = tenantOf(request);

    if (!message) {
      return reply.status(400).send({ error: 'message-required' });
    }

    const requestedConversationId = request.body?.conversationId ?? request.body?.dbSessionId;
    const dbSession = request.body?.newConversation
      ? await createGioSession(tenantId, message.slice(0, 80) || 'Gio')
      : await ensureGioSession(tenantId, requestedConversationId);
    if (activeTurns.has(dbSession.id)) {
      return reply.status(409).send({ error: 'turn-active', message: 'Gio is already working in this chat.' });
    }

    let materialized: Awaited<ReturnType<typeof materializeAttachments>>;
    try {
      materialized = await materializeAttachments(request.body ?? {});
    } catch (err) {
      return reply.status(400).send({ error: 'attachment-read-failed', message: (err as Error).message });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* connection closed — close handler cleans up */
      }
    };

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': hb\n\n'); } catch { /* closed */ }
    }, 15_000);

    let aggregate = '';
    const [memoryIndex, priorMessages] = await Promise.all([
      readGioMemoryIndex(),
      loadRecentConversationMessages(dbSession.id),
    ]);
    await getPool().query(
      `INSERT INTO boss_chat_messages (session_id, role, content)
       VALUES ($1, 'user', $2)`,
      [dbSession.id, message],
    );
    const assistantRow = await getPool().query<{ id: string }>(
      `INSERT INTO boss_chat_messages (session_id, role, content)
       VALUES ($1, 'assistant', '')
       RETURNING id`,
      [dbSession.id],
    );
    const assistantMessageId = assistantRow.rows[0].id;
    const persistState = { lastPersistedAt: 0, lastPersistedLen: 0 };
    const codexPrompt = buildCodexPrompt(memoryIndex, priorMessages, message + materialized.promptSuffix);

    send('conversation', { conversationId: dbSession.id, sessionId: dbSession.id });

    const { child, interrupt, done } = startChatTurn(codexPrompt, materialized.files, (event) => {
      send(event.type, event.payload);
      if (event.type === 'message') {
        const text = (event.payload as { text?: unknown }).text;
        if (typeof text === 'string') {
          aggregate += text;
          void persistPartial(assistantMessageId, aggregate, false, persistState).catch((err) => {
            request.log.warn({ err, assistantMessageId }, 'gio chat partial persist failed');
          });
        }
      }
    });
    activeTurns.set(dbSession.id, { interrupt, assistantMessageId });

    const onClose = (): void => {
      // Keep the turn alive if the browser navigates away. The DB row is
      // the bridge for reconnecting to the latest visible context.
      void child;
    };
    reply.raw.on('close', onClose);

    try {
      const result = await done;
      aggregate = result.assistantText || aggregate;
      if (result.aborted) {
        aggregate = aggregate.trim() ? `${aggregate}\n\n[interrupted]` : '[interrupted]';
      }
      await persistPartial(assistantMessageId, aggregate, true, persistState);
      await getPool().query(
        `UPDATE boss_chat_sessions
            SET updated_at = now()
          WHERE id = $1`,
        [dbSession.id],
      );
      if (result.exitCode !== 0 && result.exitCode !== null && !result.aborted) {
        request.log.warn(
          {
            source: 'gio-codex-chat',
            exitCode: result.exitCode,
            stderrTail: result.stderrTail.slice(-500),
          },
          'gio codex turn exited non-zero',
        );
        send('error', { exitCode: result.exitCode, stderrTail: result.stderrTail.slice(-500) });
      }
    } catch (err) {
      request.log.warn(
        { source: 'gio-codex-chat', err: (err as Error).message },
        'gio codex turn threw',
      );
      send('error', { message: (err as Error).message });
    } finally {
      clearInterval(heartbeat);
      reply.raw.removeListener('close', onClose);
      activeTurns.delete(dbSession.id);
      if (materialized.tempDir) void fs.rm(materialized.tempDir, { recursive: true, force: true });
      try { reply.raw.end(); } catch { /* already closed */ }
    }
  });
}

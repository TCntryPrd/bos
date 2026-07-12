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
import { spawn } from 'node:child_process';
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
const MAX_CHAT_BODY_BYTES = Number(process.env.BOSS_GIO_CHAT_BODY_LIMIT_BYTES ?? 48 * 1024 * 1024);
const GIO_ATTACHMENT_ROOT = process.env.BOSS_GIO_ATTACHMENT_ROOT ?? '/home/boss/gio/.tmp';
const IMAGE_EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};
const RECENT_CONTEXT_MESSAGES = 4;
const GIO_HANDLE = 'gio';
const GIO_KIND = 'gio';
const GIO_WORKSPACE = process.env.BOSS_GIO_WORKSPACE ?? '/home/boss/gio';
const GIO_MEMORY_HOOK = process.env.BOSS_GIO_MEMORY_HOOK ?? path.join(GIO_WORKSPACE, '.codex/hooks/codex_memory.py');
const GIO_MEMORY_HOOK_TIMEOUT_MS = Number(process.env.BOSS_GIO_MEMORY_HOOK_TIMEOUT_MS ?? 10_000);

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

interface AttachmentReceipt {
  count: number;
  imageCount: number;
  fileCount: number;
  skippedCount: number;
  names: string[];
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

function extractHookContext(stdout: string): string {
  const sections: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        hookSpecificOutput?: {
          additionalContext?: unknown;
        };
      };
      const context = parsed.hookSpecificOutput?.additionalContext;
      if (typeof context === 'string' && context.trim()) {
        sections.push(context.trim());
      }
    } catch {
      // Hook output is expected to be JSONL. Ignore incidental status text.
    }
  }
  return sections.join('\n\n');
}

async function readPromptRelevantMemory(prompt: string, sessionId: string): Promise<string> {
  try {
    await fs.access(GIO_MEMORY_HOOK);
  } catch {
    return '';
  }

  return new Promise((resolve) => {
    const child = spawn('python3', [GIO_MEMORY_HOOK, 'prompt-submit'], {
      cwd: GIO_WORKSPACE,
      env: {
        ...process.env,
        CODEX_MEMORY_ROOT: GIO_WORKSPACE,
        CODEX_MEMORY_WEAVIATE_URL: process.env.CODEX_MEMORY_WEAVIATE_URL ?? 'http://weaviate:8080',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already closed */ }
      resolve('');
    }, GIO_MEMORY_HOOK_TIMEOUT_MS);
    timer.unref();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.resume();
    child.stdin?.end(JSON.stringify({
      session_id: sessionId,
      cwd: GIO_WORKSPACE,
      hook_event_name: 'UserPromptSubmit',
      prompt,
    }));

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(extractHookContext(stdout).slice(0, 24_000));
    });
  });
}

function truncateContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated to keep Gio web-chat context bounded]`;
}

function bosToolBridgePrompt(): string {
  return [
    '## BOS Tool Bridge',
    'You can use Vasari/BOS brain tools from this Codex process through the local bridge.',
    'List the live granted tools and their exact schemas before using an unfamiliar tool:',
    '  node /app/apps/api/dist/employee-tool-cli.js list',
    'Run one tool:',
    '  node /app/apps/api/dist/employee-tool-cli.js run <tool_name> \'<json_args>\'',
    'Useful examples:',
    '  node /app/apps/api/dist/employee-tool-cli.js run boss_gmail_unread \'{"limit":5}\'',
    '  node /app/apps/api/dist/employee-tool-cli.js run boss_drive_create_doc \'{"title":"Draft title","content":"Draft body"}\'',
    '  node /app/apps/api/dist/employee-tool-cli.js run boss_knowledge_search \'{"query":"client or project context","limit":5}\'',
    '  node /app/apps/api/dist/employee-tool-cli.js run boss_memory_recall \'{"query":"operator preference","limit":5}\'',
    'Available categories include Gmail, Calendar, Drive, Weaviate/knowledge, memory, files, tasks, CRM, Slack, Make, Stripe, Meta/WhatsApp, LinkedIn, health, host status, and agent management when configured.',
    'Do not claim a BOS tool is unavailable before listing the bridge. Use read-only tools first. For externally visible, destructive, spending, sending, posting, deleting, infrastructure, or CRM-changing actions, proceed only when the operator explicitly asked for that action or after a clear confirmation.',
  ].join('\n');
}

function buildCodexPrompt(
  memoryIndex: string,
  promptRelevantMemory: string,
  priorMessages: ChatMessageRow[],
  currentMessage: string,
): string {
  const transcript = priorMessages
    .map((msg) => {
      const speaker = msg.role === 'assistant' ? 'Gio' : msg.role === 'user' ? 'Operator' : 'System';
      return `${speaker}:\n${truncateContext(msg.content.trim(), MAX_MESSAGE_CONTEXT_CHARS)}`;
    })
    .join('\n\n---\n\n');

  const prompt = [
    'You are Gio, the COE Codex operator surface inside BOS.',
    'This Codex process is disposable. Do not rely on Codex CLI session state for continuity.',
    'Use the bounded context below for this turn: prompt-relevant memory recall, Gio memory index, recent DB chat turns, and the current operator message.',
    'Target loop: understand expectation, execute the next concrete step, report results against expectation, then either continue with the next safe action or ask for specific clarification.',
    `Work from ${GIO_WORKSPACE} and follow its AGENTS.md, CLAUDE.md, and MEMORY.md instructions.`,
    bosToolBridgePrompt(),
    promptRelevantMemory ? `## Prompt-Relevant Memory Recall\n\n${promptRelevantMemory}` : '## Prompt-Relevant Memory Recall\n\nNo prompt-specific memory was returned for this turn.',
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

function mimeTypeFromDataUrl(dataUrl: string | undefined): string | null {
  const match = dataUrl?.match(/^data:([^;,]+)[;,]/);
  return match?.[1] ?? null;
}

function inferAttachmentMimeType(name: string, mimeType: string | undefined, dataUrl?: string): string {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  const fromDataUrl = mimeTypeFromDataUrl(dataUrl);
  if (fromDataUrl) return fromDataUrl;
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTENSION_MIME[ext] ?? mimeType ?? 'application/octet-stream';
}

function isImageAttachment(name: string, mimeType: string, dataUrl?: string): boolean {
  return mimeType.startsWith('image/') ||
    Boolean(mimeTypeFromDataUrl(dataUrl)?.startsWith('image/')) ||
    Object.prototype.hasOwnProperty.call(IMAGE_EXTENSION_MIME, path.extname(name).toLowerCase());
}

function imageExtensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/bmp') return '.bmp';
  if (mimeType === 'image/tiff') return '.tiff';
  if (mimeType === 'image/heic') return '.heic';
  if (mimeType === 'image/heif') return '.heif';
  return '.jpg';
}

async function materializeAttachments(body: ChatBody): Promise<{ promptSuffix: string; files: ChatAttachment[]; tempDir: string | null; receipt: AttachmentReceipt }> {
  const incoming = (body.attachments ?? []).slice(0, MAX_ATTACHMENTS);
  const receipt: AttachmentReceipt = { count: incoming.length, imageCount: 0, fileCount: 0, skippedCount: 0, names: [] };
  if (incoming.length === 0) return { promptSuffix: '', files: [], tempDir: null, receipt };

  await fs.mkdir(GIO_ATTACHMENT_ROOT, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(GIO_ATTACHMENT_ROOT, 'gio-chat-'));
  const files: ChatAttachment[] = [];
  const notes: string[] = [];

  for (const [index, attachment] of incoming.entries()) {
    const name = safeAttachmentName(attachment.name, index + 1);
    const mimeType = inferAttachmentMimeType(name, attachment.mimeType, attachment.dataUrl);
    const image = isImageAttachment(name, mimeType, attachment.dataUrl);
    receipt.names.push(name);

    if (attachment.dataUrl) {
      const comma = attachment.dataUrl.indexOf(',');
      const b64 = comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1);
      const bytes = Buffer.from(b64, 'base64');
      const maxBytes = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (bytes.byteLength > maxBytes) {
        notes.push(`- ${name}: skipped, file exceeded ${maxBytes / 1024 / 1024}MB.`);
        receipt.skippedCount += 1;
        continue;
      }
      const ext = path.extname(name) || (
        image ? imageExtensionFor(mimeType) : '.bin'
      );
      const filePath = path.join(tempDir, `${index + 1}-${name}${path.extname(name) ? '' : ext}`);
      await fs.writeFile(filePath, bytes, { mode: 0o600 });
      if (image) {
        files.push({ path: filePath, mimeType, name });
        receipt.imageCount += 1;
        notes.push(`- ${name}: attached image (${mimeType}) at ${filePath}.`);
      } else {
        receipt.fileCount += 1;
        notes.push(`- ${name}: uploaded file (${mimeType}, ${bytes.byteLength} bytes) at ${filePath}. Read this path directly if needed; do not quote sensitive contents back unless the operator explicitly asks.`);
      }
    } else if (typeof attachment.text === 'string' && attachment.text.trim()) {
      const text = attachment.text;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        notes.push(`- ${name}: skipped, text attachment exceeded ${MAX_FILE_BYTES / 1024}KB.`);
        receipt.skippedCount += 1;
        continue;
      }
      const filePath = path.join(tempDir, `${index + 1}-${name}${path.extname(name) ? '' : '.txt'}`);
      await fs.writeFile(filePath, text, { mode: 0o600 });
      receipt.fileCount += 1;
      notes.push(`- ${name}: uploaded text file (${mimeType}, ${bytes} bytes) at ${filePath}. Read this path directly if needed; do not quote sensitive contents back unless the operator explicitly asks.`);
    } else {
      receipt.skippedCount += 1;
      notes.push(`- ${name}: metadata only (${mimeType}); no readable file payload arrived.`);
    }
  }

  const promptSuffix = notes.length > 0
    ? `\n\nAttached files from the operator:\n${receipt.imageCount > 0 ? `${receipt.imageCount} image attachment(s) were provided to Codex with --image. Inspect the image attachment(s) directly before saying no image is attached.\n\n` : ''}${notes.join('\n\n')}`
    : '';
  return { promptSuffix, files, tempDir, receipt };
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

  server.post<{ Body: ChatBody }>('/api/openclaw/chat', { bodyLimit: MAX_CHAT_BODY_BYTES }, async (request, reply) => {
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
      request.log.info(
        {
          attachmentCount: materialized.receipt.count,
          imageCount: materialized.receipt.imageCount,
          fileCount: materialized.receipt.fileCount,
          skippedCount: materialized.receipt.skippedCount,
          names: materialized.receipt.names,
        },
        'gio chat attachments materialized',
      );
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
    const currentMessage = message + materialized.promptSuffix;
    const [memoryIndex, promptRelevantMemory, priorMessages] = await Promise.all([
      readGioMemoryIndex(),
      readPromptRelevantMemory(currentMessage, dbSession.id),
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
    const codexPrompt = buildCodexPrompt(memoryIndex, promptRelevantMemory, priorMessages, currentMessage);

    send('conversation', { conversationId: dbSession.id, sessionId: dbSession.id });
    send('attachment', materialized.receipt);

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

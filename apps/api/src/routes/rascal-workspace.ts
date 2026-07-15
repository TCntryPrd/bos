/**
 * rascal-workspace.ts — Per-agent workspace HTTP routes.
 *
 * v1.6.9 generalized this file: a single `mountWorkspaceRoutes(server,
 * opts)` factory mounts the same surface (sessions, messages, files,
 * agenda) for either rascals or outsiders. The legacy export
 * `rascalWorkspaceRoutes` is preserved for backward compat.
 *
 * Routes mount under <opts.mountPrefix>/:handle/...
 *   GET    /sessions                 — list chat sessions
 *   POST   /sessions                 — create session (snapshots SOUL.md)
 *   PATCH  /sessions/:id             — rename / archive
 *   DELETE /sessions/:id             — delete (cascades messages)
 *   GET    /sessions/:id/messages    — full history
 *   POST   /sessions/:id/messages    — chat turn (CC CLI subprocess)
 *   GET    /files                    — list directory entries
 *   GET    /files/content            — read text file (with etag)
 *   PUT    /files/content            — write text file (If-Match required)
 *   GET    /agenda                   — read <projectDir>/.boss/agenda.md
 *
 * Auth: every request resolves the agent by (tenantId, handle) via the
 * caller-provided lookup. If the agent does not exist in the requester's
 * tenant, 404. This guarantees tenant isolation across the surface.
 *
 * Cross-kind isolation: chat session queries filter by agent_kind
 * (added in migration 024) so a rascal and outsider with the same handle
 * never see each other's sessions.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool } from '../db.js';
import { getRascal } from '../agents/rascals-repo.js';
import { getOutsider } from '../agents/outsiders-repo.js';
import { runChatTurn, recoverTurnFromJsonl } from '../agents/rascal-chat.js';
import { jsonlPathFor } from '../agents/host-bridge.js';
import {
  listDirectory,
  readTextFile,
  writeTextFile,
  PathEscapeError,
  BinaryFileError,
  FileTooLargeError,
  IfMatchFailedError,
} from '../agents/rascal-files.js';

// Minimum shape needed by the workspace routes.
interface AgentLike {
  tenantId: string;
  handle: string;
  displayName: string;
  projectDir: string;
  model: string;
}

type AgentKind = 'rascal' | 'outsider';

interface WorkspaceOpts {
  /** Route prefix, e.g. "/agents/rascals" or "/agents/outsiders". */
  mountPrefix: string;
  /** Stored in boss_chat_sessions.agent_kind. */
  kind: AgentKind;
  /** Resolves an agent for the requester's tenant; null on miss. */
  lookupAgent: (tenantId: string, handle: string) => Promise<AgentLike | null>;
  /** Error code returned in 404 bodies. */
  notFoundError: string;
  /** Word used in the default soul snapshot ("rascal" / "outsider"). */
  agentNoun: string;
}

function tenantOf(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

interface ChatSessionRow {
  id: string;
  tenant_id: string;
  rascal_handle: string;
  agent_kind: AgentKind;
  name: string;
  model: string;
  system_prompt: string | null;
  cc_session_id: string | null;
  created_at: Date;
  updated_at: Date;
  archived: boolean;
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

function shapeSession(row: ChatSessionRow) {
  return {
    id: row.id,
    rascalHandle: row.rascal_handle,
    agentKind: row.agent_kind,
    name: row.name,
    model: row.model,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const SESSION_NAME_MAX = 80;

async function loadSoulSnapshot(
  projectDir: string,
  displayName: string,
  agentNoun: string,
): Promise<string> {
  if (projectDir) {
    try {
      const content = await readFile(join(projectDir, 'SOUL.md'), 'utf-8');
      if (content.trim().length > 0) return content;
    } catch {
      // fall through to default
    }
  }
  return [
    `You are ${displayName}, ${article(agentNoun)} ${agentNoun} in BOS.`,
    projectDir ? `Your project root is ${projectDir}.` : '',
    'Be concise and helpful.',
  ]
    .filter(Boolean)
    .join(' ');
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

export function mountWorkspaceRoutes(server: FastifyInstance, opts: WorkspaceOpts) {
  const { mountPrefix, kind, lookupAgent, notFoundError, agentNoun } = opts;

  async function resolveAgent(
    req: FastifyRequest,
    reply: FastifyReply,
    handle: string,
  ): Promise<AgentLike | null> {
    const agent = await lookupAgent(tenantOf(req), handle);
    if (!agent) {
      reply.status(404).send({ error: notFoundError, handle });
      return null;
    }
    return agent;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  server.get<{ Params: { handle: string }; Querystring: { archived?: string } }>(
    `${mountPrefix}/:handle/sessions`,
    async (request, reply) => {
      const agent = await resolveAgent(request, reply, request.params.handle);
      if (!agent) return;
      const includeArchived = request.query.archived === 'true';
      const sql = includeArchived
        ? `SELECT * FROM boss_chat_sessions
             WHERE tenant_id = $1 AND rascal_handle = $2 AND agent_kind = $3
             ORDER BY updated_at DESC`
        : `SELECT * FROM boss_chat_sessions
             WHERE tenant_id = $1 AND rascal_handle = $2 AND agent_kind = $3 AND archived = FALSE
             ORDER BY updated_at DESC`;
      const res = await getPool().query<ChatSessionRow>(sql, [agent.tenantId, agent.handle, kind]);
      return reply.send({ sessions: res.rows.map(shapeSession) });
    },
  );

  server.post<{
    Params: { handle: string };
    Body: { name?: string; model?: string };
  }>(`${mountPrefix}/:handle/sessions`, async (request, reply) => {
    const agent = await resolveAgent(request, reply, request.params.handle);
    if (!agent) return;
    const name = (request.body?.name ?? '').trim();
    if (!name) {
      return reply.status(400).send({ error: 'bad_request', message: 'name is required' });
    }
    if (name.length > SESSION_NAME_MAX) {
      return reply.status(400).send({
        error: 'bad_request',
        message: `name exceeds ${SESSION_NAME_MAX} chars`,
      });
    }
    const model = (request.body?.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const systemPrompt = await loadSoulSnapshot(agent.projectDir, agent.displayName, agentNoun);
    const res = await getPool().query<ChatSessionRow>(
      `INSERT INTO boss_chat_sessions
         (tenant_id, rascal_handle, agent_kind, name, model, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [agent.tenantId, agent.handle, kind, name, model, systemPrompt],
    );
    return reply.status(201).send(shapeSession(res.rows[0]));
  });

  server.patch<{
    Params: { handle: string; id: string };
    Body: { name?: string; archived?: boolean };
  }>(`${mountPrefix}/:handle/sessions/:id`, async (request, reply) => {
    const agent = await resolveAgent(request, reply, request.params.handle);
    if (!agent) return;
    const { name, archived } = request.body ?? {};
    if (name === undefined && archived === undefined) {
      return reply.status(400).send({ error: 'bad_request', message: 'no fields to update' });
    }
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) return reply.status(400).send({ error: 'bad_request', message: 'name cannot be empty' });
      if (trimmed.length > SESSION_NAME_MAX) {
        return reply.status(400).send({
          error: 'bad_request',
          message: `name exceeds ${SESSION_NAME_MAX} chars`,
        });
      }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    let p = 1;
    if (name !== undefined) {
      sets.push(`name = $${p++}`);
      vals.push(name.trim());
    }
    if (archived !== undefined) {
      sets.push(`archived = $${p++}`);
      vals.push(archived);
    }
    vals.push(agent.tenantId, agent.handle, kind, request.params.id);
    const res = await getPool().query<ChatSessionRow>(
      `UPDATE boss_chat_sessions
         SET ${sets.join(', ')}
         WHERE tenant_id = $${p++} AND rascal_handle = $${p++} AND agent_kind = $${p++} AND id = $${p++}
         RETURNING *`,
      vals,
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: 'session_not_found' });
    return reply.send(shapeSession(res.rows[0]));
  });

  server.delete<{ Params: { handle: string; id: string } }>(
    `${mountPrefix}/:handle/sessions/:id`,
    async (request, reply) => {
      const agent = await resolveAgent(request, reply, request.params.handle);
      if (!agent) return;
      const res = await getPool().query(
        `DELETE FROM boss_chat_sessions
           WHERE tenant_id = $1 AND rascal_handle = $2 AND agent_kind = $3 AND id = $4`,
        [agent.tenantId, agent.handle, kind, request.params.id],
      );
      if (res.rowCount === 0) return reply.status(404).send({ error: 'session_not_found' });
      return reply.status(204).send();
    },
  );

  // ── Messages ─────────────────────────────────────────────────────────────
  // Hard cap at the last 20 by default. Long histories (Darla had 474
  // rows including multi-megabyte assistant turns) were locking up the
  // browser. Older messages still live in the DB and can be retrieved
  // by passing ?limit=N (max 200). Cognitive memory will eventually
  // eliminate the need for the long tail in chat context.
  server.get<{
    Params: { handle: string; id: string };
    Querystring: { limit?: string; full?: string };
  }>(`${mountPrefix}/:handle/sessions/:id/messages`,
    async (request, reply) => {
      const agent = await resolveAgent(request, reply, request.params.handle);
      if (!agent) return;
      const sess = await getPool().query<ChatSessionRow>(
        `SELECT id FROM boss_chat_sessions
           WHERE tenant_id = $1 AND rascal_handle = $2 AND agent_kind = $3 AND id = $4`,
        [agent.tenantId, agent.handle, kind, request.params.id],
      );
      if (sess.rows.length === 0) return reply.status(404).send({ error: 'session_not_found' });

      const requestedLimit = Number(request.query.limit ?? '10');
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(200, Math.trunc(requestedLimit)))
        : 10;

      // Fetch most-recent N then flip to chronological order for the UI.
      // Exclude empty assistant placeholders (persist-on-frame creates
      // these up-front; if a turn errored before any frame fired we
      // don't want them showing as a blank "agent said: " row).
      const res = await getPool().query<ChatMessageRow>(
        `SELECT * FROM (
           SELECT * FROM boss_chat_messages
            WHERE session_id = $1
              AND NOT (role = 'assistant' AND COALESCE(content, '') = '')
            ORDER BY created_at DESC
            LIMIT $2
         ) recent
         ORDER BY created_at ASC`,
        [request.params.id, limit],
      );

      // Total count so the UI can show "N earlier hidden".
      const total = await getPool().query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM boss_chat_messages
          WHERE session_id = $1
            AND NOT (role = 'assistant' AND COALESCE(content, '') = '')`,
        [request.params.id],
      );

      // Per-message content cap. Darla had 1.5MB single assistant turns
      // (code dumps); the 20-message cap alone wasn't enough — 20 msgs
      // could still total >1.8MB and lock the browser. Trim any single
      // message past PREVIEW_CAP and append a marker so the UI shows
      // the truncation. Override with ?full=1 to skip the trim.
      const PREVIEW_CAP = 50_000;
      const full = request.query.full === '1';
      const trimmed = res.rows.map((row) => {
        const shaped = shapeMessage(row);
        if (!full && typeof shaped.content === 'string' && shaped.content.length > PREVIEW_CAP) {
          const head = shaped.content.slice(0, PREVIEW_CAP);
          const dropped = shaped.content.length - PREVIEW_CAP;
          shaped.content =
            head +
            `\n\n[…truncated ${dropped.toLocaleString()} chars — full content in DB. ` +
            `Refetch with ?full=1 to see everything for this session.]`;
          (shaped as Record<string, unknown>).truncated = true;
          (shaped as Record<string, unknown>).original_length = head.length + dropped;
        }
        return shaped;
      });

      return reply.send({
        messages: trimmed,
        total: Number(total.rows[0]?.n ?? res.rows.length),
        limit,
        preview_cap: PREVIEW_CAP,
      });
    },
  );

  // POST messages — persists user turn, spawns claude -p stream-json
  // in the agent's projectDir, SSE-relays frames, persists assistant
  // turn, stores cc_session_id on the row.
  server.post<{
    Params: { handle: string; id: string };
    Body: { message: string; model?: string };
  }>(`${mountPrefix}/:handle/sessions/:id/messages`, async (request, reply) => {
    const agent = await resolveAgent(request, reply, request.params.handle);
    if (!agent) return;
    if (!agent.projectDir) {
      return reply.status(409).send({ error: 'no_project_dir', handle: agent.handle });
    }
    const message = (request.body?.message ?? '').trim();
    if (!message) {
      return reply.status(400).send({ error: 'bad_request', message: 'message is required' });
    }
    const overrideModel = (request.body?.model ?? '').trim();

    const sessRes = await getPool().query<ChatSessionRow>(
      `SELECT * FROM boss_chat_sessions
         WHERE tenant_id = $1 AND rascal_handle = $2 AND agent_kind = $3 AND id = $4`,
      [agent.tenantId, agent.handle, kind, request.params.id],
    );
    if (sessRes.rows.length === 0) {
      return reply.status(404).send({ error: 'session_not_found' });
    }
    const session = sessRes.rows[0];

    await getPool().query(
      `INSERT INTO boss_chat_messages (session_id, role, content)
         VALUES ($1, 'user', $2)`,
      [session.id, message],
    );

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => {
      try { reply.raw.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 15_000);

    // 2026-05-18: SSE close no longer aborts the turn. Kevin needs to
    // switch between rascal pages without killing in-flight work. The
    // CC process lives in tmux on the host; the only thing the SSE
    // socket provides is live frame mirroring to the browser. If the
    // socket dies (nav-away / network drop / API restart) the turn
    // keeps running, persist-on-frame keeps the DB row fresh, and the
    // user picks up the latest state on return via GET /messages.
    //
    // The AbortController is retained for a future explicit "stop"
    // endpoint — for now nothing wires close→abort.
    const abortController = new AbortController();

    // ── Persist-on-frame ─────────────────────────────────────────────────────
    // Create a placeholder assistant row up front; runChatTurn UPSERTs the
    // accumulated text into it throttled at ~2s intervals (and once at end).
    // Why: if the SSE dies — client disconnect, API restart, idle timeout —
    // the row already carries the latest partial text. No more "Darla
    // finished her response but the chat shows nothing" recoveries.
    const placeholder = await getPool().query<{ id: string }>(
      `INSERT INTO boss_chat_messages
         (session_id, role, content, tokens_in, tokens_out)
       VALUES ($1, 'assistant', '', NULL, NULL)
       RETURNING id`,
      [session.id],
    );
    const persistRowId = placeholder.rows[0].id;
    // Wall-clock cutoff for post-turn JSONL reconciliation. Frames in the
    // JSONL with timestamp >= this are considered part of this turn.
    const sendIsoMs = Date.now() - 2_000;

    let lastPersistedAt = 0;
    let lastPersistedLen = 0;
    const persistPartial = async (
      text: string,
      tokensIn: number | null,
      tokensOut: number | null,
      force = false,
    ) => {
      const now = Date.now();
      const grew = text.length !== lastPersistedLen;
      const stale = now - lastPersistedAt > 2_000;
      if (!force && !(grew && stale)) return;
      lastPersistedAt = now;
      lastPersistedLen = text.length;
      try {
        await getPool().query(
          `UPDATE boss_chat_messages
              SET content = $2, tokens_in = $3, tokens_out = $4
            WHERE id = $1`,
          [persistRowId, text, tokensIn, tokensOut],
        );
      } catch (err) {
        request.log.warn({ err, persistRowId }, 'persist-on-frame failed');
      }
    };

    try {
      const effectiveModel = overrideModel || session.model || agent.model;
      const turn = await runChatTurn(
        {
          message,
          projectDir: agent.projectDir,
          ccSessionId: session.cc_session_id,
          model: effectiveModel,
          abortSignal: abortController.signal,
          // 2026-05-18: rascals/outsiders get --dangerously-skip-permissions
          // through the chat surface, matching COO. Reason: the web chat
          // has no UI for CC's interactive permission prompts (Bash, Edit,
          // Skill consent, etc), so without the bypass every consent
          // request silently freezes the rascal until Kevin pokes the
          // tmux pane manually. Standing rule's spirit (Kevin must approve
          // sensitive ops) is preserved by the ## Standing rules section
          // in each CLAUDE.md (drafts only, no $$/scope without Kevin)
          // rather than by CC's runtime prompt-gating.
          allowAllTools: true,
          onPartial: persistPartial,
        },
        reply.raw,
      );

      await getPool().query(
        `UPDATE boss_chat_sessions
           SET cc_session_id = COALESCE(cc_session_id, $2),
               updated_at = now()
           WHERE id = $1`,
        [session.id, turn.ccSessionId],
      );

      // Final flush — guarantees the last bytes + token totals are in the
      // row even if no partial-write fired in the last 2s window.
      const persistedText = turn.aborted
        ? `${turn.assistantText}\n\n[interrupted]`
        : turn.assistantText;
      await persistPartial(persistedText, turn.tokensIn, turn.tokensOut, true);

      // Final reconciliation: re-read JSONL one more time and force-overwrite
      // if on-disk truth is longer than what we just persisted. Catches deep
      // tool-cycle turns where the final end_turn frame lands after the bridge
      // tail's debounce closed. COO screen-pipe drop 2026-05-20 was diagnosed
      // here: 968-char final answer in JSONL, only 193-char opening persisted.
      try {
        const finalSessionId = turn.ccSessionId ?? session.cc_session_id;
        if (finalSessionId && agent.projectDir) {
          const jsonlPath = jsonlPathFor(agent.projectDir, finalSessionId);
          const recovered = await recoverTurnFromJsonl(jsonlPath, sendIsoMs);
          if (recovered.text.length > persistedText.length) {
            const finalText = turn.aborted
              ? `${recovered.text}\n\n[interrupted]`
              : recovered.text;
            await persistPartial(finalText, recovered.tokensIn ?? turn.tokensIn, recovered.tokensOut ?? turn.tokensOut, true);
            request.log.info({ persistRowId, recovered: recovered.text.length, persisted: persistedText.length, handle: agent.handle }, 'agent chat: reconciled longer JSONL truth');
          }
        }
      } catch (err) {
        request.log.warn({ err, persistRowId, handle: agent.handle }, 'agent chat: final JSONL reconciliation failed');
      }
    } catch (err) {
      request.log.error({ err, handle: agent.handle, kind }, 'agent chat turn failed');
      // Don't delete the placeholder — whatever partial text was streamed
      // into it is the most accurate record of what the rascal produced.
    } finally {
      clearInterval(heartbeat);
      try { reply.raw.end(); } catch { /* already closed */ }
    }
  });

  // ── Files ────────────────────────────────────────────────────────────────
  server.get<{ Params: { handle: string }; Querystring: { path?: string } }>(
    `${mountPrefix}/:handle/files`,
    async (request, reply) => {
      const agent = await resolveAgent(request, reply, request.params.handle);
      if (!agent) return;
      if (!agent.projectDir) {
        return reply.status(409).send({ error: 'no_project_dir', handle: agent.handle });
      }
      const requested = request.query.path ?? '.';
      try {
        const entries = await listDirectory(agent.projectDir, requested);
        return reply.send({ path: requested, entries });
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return reply.status(403).send({ error: 'path_escape', path: err.attemptedPath });
        }
        if ((err as { code?: string }).code === 'ENOENT') {
          return reply.status(404).send({ error: 'not_found', path: requested });
        }
        if ((err as { code?: string }).code === 'ENOTDIR') {
          return reply.status(400).send({ error: 'not_a_directory', path: requested });
        }
        throw err;
      }
    },
  );

  server.get<{ Params: { handle: string }; Querystring: { path?: string } }>(
    `${mountPrefix}/:handle/files/content`,
    async (request, reply) => {
      const agent = await resolveAgent(request, reply, request.params.handle);
      if (!agent) return;
      if (!agent.projectDir) {
        return reply.status(409).send({ error: 'no_project_dir', handle: agent.handle });
      }
      const requested = request.query.path;
      if (!requested) {
        return reply.status(400).send({ error: 'bad_request', message: 'path is required' });
      }
      try {
        const { content, bytes, modifiedAt, etag } = await readTextFile(agent.projectDir, requested);
        reply.header('ETag', `"${etag}"`);
        return reply.send({ path: requested, bytes, modifiedAt, etag, content });
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return reply.status(403).send({ error: 'path_escape', path: err.attemptedPath });
        }
        if (err instanceof BinaryFileError) {
          return reply.status(415).send({ error: 'binary_rejected', path: requested });
        }
        if (err instanceof FileTooLargeError) {
          return reply.status(413).send({ error: 'too_large', path: requested, bytes: err.bytes });
        }
        if ((err as { code?: string }).code === 'ENOENT') {
          return reply.status(404).send({ error: 'not_found', path: requested });
        }
        throw err;
      }
    },
  );

  server.put<{
    Params: { handle: string };
    Body: { path: string; content: string };
  }>(`${mountPrefix}/:handle/files/content`, async (request, reply) => {
    const agent = await resolveAgent(request, reply, request.params.handle);
    if (!agent) return;
    if (!agent.projectDir) {
      return reply.status(409).send({ error: 'no_project_dir', handle: agent.handle });
    }
    const path = request.body?.path;
    const content = request.body?.content;
    if (!path) return reply.status(400).send({ error: 'bad_request', message: 'path is required' });
    if (typeof content !== 'string') {
      return reply.status(400).send({ error: 'bad_request', message: 'content must be a string' });
    }
    const ifMatch = request.headers['if-match'];
    const ifMatchValue = typeof ifMatch === 'string' ? ifMatch.replace(/^"|"$/g, '') : undefined;
    try {
      const meta = await writeTextFile(agent.projectDir, path, content, ifMatchValue);
      reply.header('ETag', `"${meta.etag}"`);
      return reply.send({ path, ...meta });
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return reply.status(403).send({ error: 'path_escape', path: err.attemptedPath });
      }
      if (err instanceof FileTooLargeError) {
        return reply.status(413).send({ error: 'too_large', bytes: err.bytes });
      }
      if (err instanceof IfMatchFailedError) {
        return reply.status(412).send({ error: 'etag_mismatch', currentEtag: err.currentEtag });
      }
      throw err;
    }
  });

  // ── Agenda ───────────────────────────────────────────────────────────────
  server.get<{ Params: { handle: string } }>(
    `${mountPrefix}/:handle/agenda`,
    async (request, reply) => {
      const agent = await resolveAgent(request, reply, request.params.handle);
      if (!agent) return;
      if (!agent.projectDir) {
        return reply.status(404).send({ error: 'agenda_missing', reason: 'no project_dir' });
      }
      const path = join(agent.projectDir, '.boss', 'agenda.md');
      try {
        const content = await readFile(path, 'utf-8');
        return reply.send({ path, content });
      } catch {
        return reply.status(404).send({ error: 'agenda_missing', path });
      }
    },
  );
}

// ── Concrete mounts ─────────────────────────────────────────────────────────

export async function rascalWorkspaceRoutes(server: FastifyInstance) {
  mountWorkspaceRoutes(server, {
    mountPrefix: '/agents/rascals',
    kind: 'rascal',
    notFoundError: 'rascal_not_found',
    agentNoun: 'rascal',
    lookupAgent: async (tenantId, handle) => {
      const r = await getRascal(tenantId, handle);
      return r && {
        tenantId: r.tenantId,
        handle: r.handle,
        displayName: r.displayName,
        projectDir: r.projectDir,
        model: r.model,
      };
    },
  });
}

export async function outsiderWorkspaceRoutes(server: FastifyInstance) {
  mountWorkspaceRoutes(server, {
    mountPrefix: '/agents/outsiders',
    kind: 'outsider',
    notFoundError: 'outsider_not_found',
    agentNoun: 'outsider',
    lookupAgent: async (tenantId, handle) => {
      const o = await getOutsider(tenantId, handle);
      return o && {
        tenantId: o.tenantId,
        handle: o.handle,
        displayName: o.displayName,
        projectDir: o.projectDir,
        model: o.model,
      };
    },
  });
}

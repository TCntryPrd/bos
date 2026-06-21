/**
 * POST /threads/:id/chat — SSE streaming chat turn for COO.
 *
 * Mirrors the rascal-workspace chat handler with three deltas:
 *   1. agent_kind='coo' (not rascal/outsider)
 *   2. cwd = thread.workspace_dir (picked at thread creation)
 *   3. allowAllTools: true (bypass mode — explicit Kevin authorization)
 *
 * SSE event shape:
 *   event: frame      every stream-json frame from CC (raw passthrough)
 *   event: error      terminal error before/after spawn
 *   event: done       terminal success marker emitted just before close
 *
 * Heartbeats every 15s while the subprocess runs.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db.js';
import { runLocalChatTurn, recoverTurnFromJsonl } from '../../agents/rascal-chat.js';
import { jsonlPathFor } from '../../agents/host-bridge.js';
import { materializeAttachments, type IncomingAttachment } from '../../agents/chat-attachments.js';

interface ChatBody { message: string; attachments?: IncomingAttachment[]; }

export async function chatRoutes(server: FastifyInstance) {
  server.post<{ Params: { id: string }; Body: ChatBody }>(
    '/threads/:id/chat',
    async (req: FastifyRequest<{ Params: { id: string }; Body: ChatBody }>, reply: FastifyReply) => {
      const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
      const { id } = req.params;
      const body = (req.body ?? {}) as ChatBody;
      const { message } = body;
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.status(400).send({ error: 'message required' });
      }

      const sessRes = await getPool().query(
        `SELECT id, cc_session_id, model, workspace_dir, system_prompt
           FROM boss_chat_sessions
          WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo'`,
        [id, tenantId],
      );
      if (sessRes.rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
      const session = sessRes.rows[0];

      // Wall-clock cutoff for post-turn JSONL reconciliation. Set BEFORE
      // we record the user row so any JSONL frame with ts >= this is
      // considered part of this turn or later.
      const sendIsoMs = Date.now() - 2_000;

      // Recent conversation (cleaned: messages + essential tool calls), token-budgeted.
      // This + the auto-loaded CLAUDE.md/MEMORY.md (cwd) IS the COO's injected memory —
      // we run one-shot, so this is how continuity survives without a CC session.
      const histRes = await getPool().query<{ role: string; content: string; tool_trace: string | null }>(
        `SELECT role, content, tool_trace FROM boss_chat_messages
          WHERE session_id = $1 AND content <> '' ORDER BY created_at DESC LIMIT 16`,
        [session.id],
      );
      const histLines: string[] = [];
      for (const m of histRes.rows.reverse()) {
        const who = m.role === 'user' ? 'Kevin' : 'You (COO)';
        let entry = `${who}: ${(m.content || '').slice(0, 1500)}`;
        if (m.role === 'assistant' && m.tool_trace) entry += `\n  [tools used: ${m.tool_trace}]`;
        histLines.push(entry);
      }
      // Token-aware: drop oldest until under ~14k chars (~3.5k tokens).
      while (histLines.length > 1 && histLines.join('\n\n').length > 14_000) histLines.shift();
      const convoBlock = histLines.length
        ? `## Recent conversation (cleaned — most recent last)\n${histLines.join('\n\n')}\n\n---\n\n`
        : '';

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

      // 2026-05-18: SSE close no longer aborts the turn. See rascal-workspace.ts
      // for the rationale — navigating between agent pages must not kill in-flight
      // work. CC keeps running in tmux; persist-on-frame keeps the DB row current;
      // the user picks up the latest state on return via GET /messages.
      const abortController = new AbortController();

      // Persist-on-frame: see rascal-workspace.ts for the rationale.
      const placeholder = await getPool().query<{ id: string }>(
        `INSERT INTO boss_chat_messages
           (session_id, role, content, tokens_in, tokens_out)
         VALUES ($1, 'assistant', '', NULL, NULL)
         RETURNING id`,
        [session.id],
      );
      const persistRowId = placeholder.rows[0].id;
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
          req.log.warn({ err, persistRowId }, 'persist-on-frame failed (COO)');
        }
      };

      // Attachments: write them into the thread workspace as 0600 temp files
      // and append their paths to the prompt. Claude runs bypass-mode so it
      // can read them directly. The DB user row keeps the original message.
      let promptMessage = message;
      try {
        const { promptSuffix } = await materializeAttachments(body.attachments, session.workspace_dir);
        if (promptSuffix) promptMessage = `${message}${promptSuffix}`;
      } catch (err) {
        req.log.warn({ err, threadId: id }, 'COO chat: attachment materialize failed');
      }

      try {
        const turn = await runLocalChatTurn(
          {
            message: `${convoBlock}${promptMessage}`,
            projectDir: session.workspace_dir,
            ccSessionId: null, // one-shot: fresh CC session every turn, no resume
            model: session.model,
            systemPrompt: session.system_prompt,
            abortSignal: abortController.signal,
            allowAllTools: true,
            onPartial: persistPartial,
          },
          reply.raw,
        );

        // One-shot: do NOT persist a resumable session. Store this turn's
        // frame-captured tool trace (essential tool info) for the cleaned log.
        try {
          const tools = turn.toolNames ?? [];
          if (tools.length) {
            await getPool().query(
              `UPDATE boss_chat_messages SET tool_trace = $2 WHERE id = $1`,
              [persistRowId, tools.join(', ')],
            );
          }
        } catch (err) {
          req.log.warn({ err, persistRowId }, 'COO chat: tool-trace capture failed');
        }
        await getPool().query(`UPDATE boss_chat_sessions SET updated_at = now() WHERE id = $1`, [session.id]);
        const persistedText = turn.aborted
          ? `${turn.assistantText}\n\n[interrupted]`
          : turn.assistantText;
        await persistPartial(persistedText, turn.tokensIn, turn.tokensOut, true);

        // Final reconciliation: re-read the JSONL on disk and force-overwrite
        // the row if the on-disk truth is longer than what we just persisted.
        // Catches the case where runChatTurn's internal isTurnEnd ended early
        // and the in-memory recover didn't catch up — happens with deep tool
        // cycles where the final end_turn frame lands after the bridge tail
        // closes. Reference: COO screen-pipe drop incident 2026-05-20 23:58.
        try {
          const finalSessionId = turn.ccSessionId ?? session.cc_session_id;
          if (finalSessionId && session.workspace_dir) {
            const jsonlPath = jsonlPathFor(session.workspace_dir, finalSessionId);
            const recovered = await recoverTurnFromJsonl(jsonlPath, sendIsoMs);
            if (recovered.text.length > persistedText.length) {
              const finalText = turn.aborted
                ? `${recovered.text}\n\n[interrupted]`
                : recovered.text;
              await persistPartial(finalText, recovered.tokensIn ?? turn.tokensIn, recovered.tokensOut ?? turn.tokensOut, true);
              req.log.info({ persistRowId, recovered: recovered.text.length, persisted: persistedText.length }, 'COO chat: reconciled longer JSONL truth');
            }
          }
        } catch (err) {
          req.log.warn({ err, persistRowId }, 'COO chat: final JSONL reconciliation failed');
        }

        try { reply.raw.write(`event: done\ndata: {"ok":true}\n\n`); } catch { /* ignore */ }
      } catch (err) {
        req.log.error({ err, threadId: id }, 'COO chat turn failed');
        try { reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`); } catch { /* ignore */ }
      } finally {
        clearInterval(heartbeat);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    },
  );
}

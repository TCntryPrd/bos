/**
 * Board routes — /api/board  (Advisory Board)
 *
 *   GET  /api/board                       — board + advisors (seats)
 *   POST /api/board/advisors              — create an advisor (ai|human)
 *   GET  /api/board/advisors/:id/messages — 1:1 thread with an advisor
 *   POST /api/board/advisors/:id/message  — DM an advisor → it responds in persona
 *   POST /api/board/post                  — post a board-wide message
 *   GET/POST /api/board/items             — notes / tasks / reminders
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { currentTenantId } from '../lib/tenant.js';
import { getBoard, advisorRespond, postMessage, listMessages, getAdvisor, holdMeeting, generateAdvisor, getAdvisorPortrait, regenerateAdvisorPortrait, updateAdvisor, deleteAdvisor, agentEnsure } from '../lib/board.js';
import { generateVoice, type VoiceOpts } from '../lib/voice-synthesis.js';
import { liveKitConfigured, liveKitUrl, boardRoom, mintAccessToken, mintGuestCode, verifyGuestCode } from '../lib/livekit.js';
import { listMemories, writeMemory } from '../lib/advisor-memory.js';

export async function boardRoutes(server: FastifyInstance): Promise<void> {
  server.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await getBoard(currentTenantId(request.auth?.tenantId)));
  });

  server.post('/advisors', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as {
      type?: string; display_name?: string; title?: string; bio?: string; avatar_image_url?: string;
      persona_id?: string; seat_index?: number; model_label?: string; voice_id?: string;
      system_addendum?: string; email?: string; zoom_join_url?: string;
    };
    if (!b.display_name) return reply.status(400).send({ error: 'display_name required' });
    const tenantId = currentTenantId(request.auth?.tenantId);
    const type = b.type === 'human' ? 'human' : 'ai';
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO boss_advisors (tenant_id,type,display_name,title,bio,avatar_image_url,persona_id,seat_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tenantId, type, b.display_name, b.title ?? null, b.bio ?? null, b.avatar_image_url ?? null, b.persona_id ?? null, b.seat_index ?? null]);
    const id = rows[0].id;
    if (type === 'ai') {
      await pool.query(`INSERT INTO boss_advisor_ai (advisor_id,model_label,voice_id,system_addendum) VALUES ($1,$2,$3,$4)`,
        [id, b.model_label ?? null, b.voice_id ?? null, b.system_addendum ?? null]);
      if (!b.avatar_image_url) {
        void regenerateAdvisorPortrait(tenantId, id).catch(() => undefined);
      }
    } else {
      await pool.query(`INSERT INTO boss_advisor_human (advisor_id,email,zoom_join_url) VALUES ($1,$2,$3)`,
        [id, b.email ?? null, b.zoom_join_url ?? null]);
    }
    return reply.send({ id });
  });

  // Generate an AI advisor from a position + model (backend writes name/persona/portrait)
  server.post('/advisors/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { position?: string; model_label?: string; seat_index?: number };
    if (!b.position) return reply.status(400).send({ error: 'position required' });
    try {
      const r = await generateAdvisor(currentTenantId(request.auth?.tenantId), { position: b.position.trim(), model_label: b.model_label, seat_index: b.seat_index });
      return reply.send(r);
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Public — serve a generated advisor portrait (img src can't send auth headers)
  server.get('/portrait/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const png = await getAdvisorPortrait((request.params as { id: string }).id);
    if (!png) return reply.status(404).send({ error: 'no portrait' });
    reply.header('Content-Type', 'image/png');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(png);
  });

  server.post('/advisors/:id/portrait/regenerate', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    try {
      const ok = await regenerateAdvisorPortrait(currentTenantId(request.auth?.tenantId), id);
      if (!ok) return reply.status(404).send({ error: 'portrait unavailable' });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.get('/advisors/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    return reply.send({ messages: await listMessages(currentTenantId(request.auth?.tenantId), id) });
  });

  // An advisor's memory (what they've learned) + manually teach them something
  server.get('/advisors/:id/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    return reply.send({ memories: await listMemories(currentTenantId(request.auth?.tenantId), id) });
  });
  server.post('/advisors/:id/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const b = (request.body ?? {}) as { kind?: string; content?: string };
    if (!b.content) return reply.status(400).send({ error: 'content required' });
    await writeMemory(currentTenantId(request.auth?.tenantId), id, b.kind ?? 'knowledge', b.content);
    return reply.send({ ok: true });
  });

  // Edit an advisor (name/title/model/persona/seat)
  server.patch('/advisors/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    try {
      await updateAdvisor(currentTenantId(request.auth?.tenantId), id, (request.body ?? {}) as Record<string, never>);
      return reply.send({ ok: true });
    } catch (err) { return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Remove an advisor
  server.delete('/advisors/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    try {
      await deleteAdvisor(currentTenantId(request.auth?.tenantId), id);
      return reply.send({ ok: true });
    } catch (err) { return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  server.post('/advisors/:id/message', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const b = (request.body ?? {}) as { message?: string; conversationId?: string };
    if (!b.message) return reply.status(400).send({ error: 'message required' });
    try {
      const r = await advisorRespond(currentTenantId(request.auth?.tenantId), id, b.message, b.conversationId);
      return reply.send({ text: r.text, advisor: { id: r.advisor.id, display_name: r.advisor.display_name, voice_id: r.advisor.ai?.voice_id ?? null } });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Speak an advisor's line — OmniVoice (primary) → Gemini (fallback), returns WAV.
  server.post('/tts', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { advisor_id?: string; text?: string };
    if (!b.text) return reply.status(400).send({ error: 'text required' });
    let voice: VoiceOpts | undefined;
    if (b.advisor_id) {
      const a = await getAdvisor(currentTenantId(request.auth?.tenantId), b.advisor_id);
      voice = (a?.ai?.voice_settings as VoiceOpts | null) ?? undefined;
    }
    try {
      const { wav, engine } = await generateVoice(b.text.slice(0, 1500), voice);
      reply.header('Content-Type', 'audio/wav');
      reply.header('X-Voice-Engine', engine);
      return reply.send(wav);
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post('/post', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { body?: string };
    if (!b.body) return reply.status(400).send({ error: 'body required' });
    await postMessage(currentTenantId(request.auth?.tenantId), {
      authorType: 'user', authorName: request.auth?.userId ?? 'You', kind: 'board_post', body: b.body,
    });
    return reply.send({ ok: true });
  });

  // Hold a board meeting — multi-model deliberation → minutes + decisions + BOS tasks
  server.post('/meeting', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { topic?: string };
    if (!b.topic) return reply.status(400).send({ error: 'topic required' });
    try {
      return reply.send(await holdMeeting(currentTenantId(request.auth?.tenantId), b.topic));
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.get('/meetings', async (request: FastifyRequest, reply: FastifyReply) => {
    const { rows } = await getPool().query(
      `SELECT id, topic, status, minutes, decisions, created_at, completed_at FROM boss_board_meetings WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [currentTenantId(request.auth?.tenantId)]).catch(() => ({ rows: [] }));
    return reply.send({ meetings: rows });
  });

  // ── Live video room (LiveKit) ───────────────────────────────────────────────
  server.get('/rtc/config', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ configured: liveKitConfigured(), url: liveKitUrl(), room: boardRoom(currentTenantId(request.auth?.tenantId)) });
  });

  // Authed (owner) join token for the board's video room
  server.post('/rtc/token', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!liveKitConfigured()) return reply.status(503).send({ error: 'video room not configured' });
    const tenantId = currentTenantId(request.auth?.tenantId);
    const name = (request.auth?.userId as string) || 'Owner';
    try {
      const token = mintAccessToken({ identity: `owner-${name}`, name, room: boardRoom(tenantId), canPublish: true });
      agentEnsure(boardRoom(tenantId)); // AI advisors join the room as you enter
      return reply.send({ url: liveKitUrl(), room: boardRoom(tenantId), token, identity: `owner-${name}`, name });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Generate a public join link for a human advisor (no BOS account needed)
  server.post('/advisors/:id/invite-link', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const tenantId = currentTenantId(request.auth?.tenantId);
    const a = await getAdvisor(tenantId, id);
    if (!a) return reply.status(404).send({ error: 'advisor not found' });
    const code = mintGuestCode({ room: boardRoom(tenantId), identity: `human-${id}`, name: a.display_name });
    return reply.send({ code, path: `/join/${code}`, advisor: a.display_name });
  });

  // Public guest token from a signed invite code (no auth) — the /join page calls this.
  // Code is a query param (it exceeds Fastify's 100-char maxParamLength as a path segment).
  server.get('/rtc/guest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!liveKitConfigured()) return reply.status(503).send({ error: 'video room not configured' });
    const code = (request.query as { code?: string }).code || '';
    const claim = verifyGuestCode(code);
    if (!claim) return reply.status(403).send({ error: 'invalid or expired invite' });
    try {
      const token = mintAccessToken({ identity: claim.identity, name: claim.name, room: claim.room, canPublish: true });
      agentEnsure(claim.room); // AI advisors join the room as the guest enters
      return reply.send({ url: liveKitUrl(), room: claim.room, token, name: claim.name });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.get('/items', async (request: FastifyRequest, reply: FastifyReply) => {
    const { rows } = await getPool().query(
      `SELECT id,kind,title,body,due_at,status,created_at FROM boss_board_items WHERE tenant_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 50`,
      [currentTenantId(request.auth?.tenantId)]).catch(() => ({ rows: [] }));
    return reply.send({ items: rows });
  });
  server.post('/items', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { kind?: string; title?: string; body?: string; due_at?: string };
    if (!b.title) return reply.status(400).send({ error: 'title required' });
    await getPool().query(`INSERT INTO boss_board_items (tenant_id,kind,title,body,due_at) VALUES ($1,$2,$3,$4,$5)`,
      [currentTenantId(request.auth?.tenantId), b.kind ?? 'note', b.title, b.body ?? null, b.due_at ?? null]);
    return reply.send({ ok: true });
  });
}

export default boardRoutes;

/**
 * board.ts — Advisory Board service (THE differentiator).
 *
 * AI advisors = static portrait + voice; they deliberate and advise via the existing
 * brain tool-loop, scoped to READ-ONLY tools (BOARD_ADVISOR_TOOLS) — they never touch
 * the host (no bash/fs/host-exec). The advisor produces text; this service posts it and
 * the UI plays the TTS voice. Humans are seat members who join meetings via Zoom.
 */
import { getPool } from '../db.js';
import { currentTenantId } from './tenant.js';
import { resolveModel } from './model-routes.js';
import { recallMemories, memoryBlock, writeMemory } from './advisor-memory.js';
import { ADVISOR_VOICES } from './voice-synthesis.js';

/** Safe read-only tools an AI advisor may use to ground its advice. The safety keystone:
 *  NO boss_bash / boss_fs / host-exec / admin / external-comms. */
export const BOARD_ADVISOR_TOOLS = [
  'boss_knowledge_search', 'boss_memory_recall', 'boss_tasks_pending',
  'boss_calendar_today', 'boss_calendar_upcoming', 'boss_crm_metrics',
  'boss_era_financial_overview', 'boss_email_digest', 'boss_web_search', 'boss_web_fetch',
];

export interface AdvisorAi {
  model_label: string | null; model_display?: string; voice_provider: string; voice_id: string | null;
  voice_settings: Record<string, unknown> | null; system_addendum: string | null;
}

/** Friendly model name for the UI (each advisor is a different model → our own Fusion). */
export function modelDisplay(modelLabel: string | null): string {
  const m = (modelLabel || '').toLowerCase();
  if (!m) return 'Claude';
  if (m.includes('claude')) return 'Claude';
  if (m.includes('deepseek')) return 'DeepSeek';
  if (m.includes('kimi') || m.includes('moonshot')) return 'Kimi';
  if (m.includes('gpt') || m.includes('openai')) return 'GPT';
  if (m.includes('gemini') || m.includes('google')) return 'Gemini';
  if (m.includes('grok') || m.includes('x-ai')) return 'Grok';
  if (m.includes('glm') || m.includes('z-ai')) return 'GLM';
  if (m.includes('qwen')) return 'Qwen';
  if (m.includes('llama')) return 'Llama';
  if (m.includes('mistral')) return 'Mistral';
  return modelLabel || 'AI';
}
export interface Advisor {
  id: string; type: 'ai' | 'human'; display_name: string; title: string | null;
  bio: string | null; avatar_image_url: string | null; persona_id: string | null;
  seat_index: number | null; status: string; ai?: AdvisorAi | null;
  zoom_join_url?: string | null;
}

export async function getBoard(tenantId: string): Promise<{ board: { id: string; name: string } | null; advisors: Advisor[] }> {
  const pool = getPool(); const t = currentTenantId(tenantId);
  let board = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM boss_boards WHERE tenant_id=$1 ORDER BY created_at LIMIT 1`, [t]).then((r) => r.rows[0] ?? null).catch(() => null);
  if (!board) {
    board = await pool.query<{ id: string; name: string }>(
      `INSERT INTO boss_boards (tenant_id) VALUES ($1) RETURNING id, name`, [t]).then((r) => r.rows[0]).catch(() => null);
  }
  const advisors = await listAdvisors(t);
  return { board, advisors };
}

export async function listAdvisors(tenantId: string): Promise<Advisor[]> {
  const t = currentTenantId(tenantId);
  const { rows } = await getPool().query<Advisor & AdvisorAi & { zoom_join_url: string | null }>(
    `SELECT a.id, a.type, a.display_name, a.title, a.bio, a.avatar_image_url, a.persona_id, a.seat_index, a.status,
            ai.model_label, ai.voice_provider, ai.voice_id, ai.voice_settings, ai.system_addendum,
            h.zoom_join_url
     FROM boss_advisors a
     LEFT JOIN boss_advisor_ai ai ON ai.advisor_id = a.id
     LEFT JOIN boss_advisor_human h ON h.advisor_id = a.id
     WHERE a.tenant_id=$1 AND a.status='active'
     ORDER BY a.seat_index NULLS LAST, a.created_at`, [t]).catch(() => ({ rows: [] as any[] }));
  return rows.map((r) => ({
    id: r.id, type: r.type, display_name: r.display_name, title: r.title, bio: r.bio,
    avatar_image_url: r.avatar_image_url, persona_id: r.persona_id, seat_index: r.seat_index, status: r.status,
    zoom_join_url: r.zoom_join_url,
    ai: r.type === 'ai' ? { model_label: r.model_label, model_display: modelDisplay(r.model_label), voice_provider: r.voice_provider ?? 'omnivoice', voice_id: r.voice_id, voice_settings: r.voice_settings, system_addendum: r.system_addendum } : null,
  }));
}

export async function getAdvisor(tenantId: string, advisorId: string): Promise<Advisor | null> {
  const all = await listAdvisors(tenantId);
  return all.find((a) => a.id === advisorId) ?? null;
}

export async function postMessage(tenantId: string, m: {
  advisorId?: string | null; authorType: 'user' | 'advisor'; authorName?: string;
  kind?: string; body: string; conversationId?: string; hasAudio?: boolean;
}): Promise<{ id: string }> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO boss_board_messages (tenant_id, advisor_id, author_type, author_name, kind, body, has_audio, conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [currentTenantId(tenantId), m.advisorId ?? null, m.authorType, m.authorName ?? null, m.kind ?? 'dm', m.body, m.hasAudio ?? false, m.conversationId ?? null]);
  return rows[0];
}

export async function listMessages(tenantId: string, advisorId: string | null, limit = 50): Promise<unknown[]> {
  const t = currentTenantId(tenantId);
  const sql = advisorId
    ? `SELECT id, advisor_id, author_type, author_name, kind, body, has_audio, created_at FROM boss_board_messages WHERE tenant_id=$1 AND advisor_id=$2 ORDER BY created_at DESC LIMIT $3`
    : `SELECT id, advisor_id, author_type, author_name, kind, body, has_audio, created_at FROM boss_board_messages WHERE tenant_id=$1 AND kind='board_post' ORDER BY created_at DESC LIMIT $2`;
  const params = advisorId ? [t, advisorId, limit] : [t, limit];
  const { rows } = await getPool().query(sql, params).catch(() => ({ rows: [] as unknown[] }));
  return (rows as unknown[]).reverse();
}

/** Board advisors must run on OpenRouter (non-Anthropic) models. The host claude-code runner
 *  carries BOS's own system identity and refuses to roleplay a persona ("I'm BOS"). Defaulting
 *  here keeps any advisor without an explicit model on a persona-capable OpenRouter model. */
const BOARD_DEFAULT_MODEL = process.env.BOARD_DEFAULT_MODEL || 'deepseek/deepseek-v3.2';

// ── board-agent (live video bot) — fire-and-forget so the brain loop never blocks ──
const BOARD_AGENT_URL = process.env.BOARD_AGENT_URL || 'http://board-agent:8090';
function agentNotify(path: string, body: Record<string, unknown>, timeoutMs = 120_000): void {
  fetch(`${BOARD_AGENT_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }).catch(() => { /* best-effort */ });
}
/** Make the AI advisors join the board video room (publish portraits). */
export function agentEnsure(room: string): void { agentNotify('/ensure', { room }, 60_000); }
/** Have an advisor speak aloud in the board video room (TTS → audio). */
export function agentSpeak(advisorId: string, text: string, room: string): void { agentNotify('/speak', { advisor_id: advisorId, text, room }); }

/** Resolve an advisor's persona prompt (boss_personas.system_addendum or the inline one). */
async function advisorPersona(advisor: Advisor): Promise<string> {
  let persona = advisor.ai?.system_addendum ?? '';
  if (advisor.persona_id) {
    const p = await getPool().query<{ system_addendum: string | null }>(
      `SELECT system_addendum FROM boss_personas WHERE id=$1`, [advisor.persona_id]).then((r) => r.rows[0]).catch(() => null);
    if (p?.system_addendum) persona = p.system_addendum;
  }
  return persona;
}

/** Internal brain call (the advisor's own model → our own multi-model Fusion). */
async function callBrain(message: string, opts: { model?: string; provider?: string; tools?: string[]; conversationId?: string }): Promise<string> {
  const port = process.env.PORT || '8010';
  const res = await fetch(`http://127.0.0.1:${port}/api/brain/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BOSS-Internal': 'true' },
    body: JSON.stringify({
      message,
      conversationId: opts.conversationId || `board-${Date.now()}`,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      allowedTools: opts.tools ?? [],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json() as { response?: string; error?: string };
  return data.response || data.error || '(no response)';
}

/** An AI advisor responds in persona via the brain tool-loop (read-only tools), on its OWN model. */
export async function advisorRespond(tenantId: string, advisorId: string, userMessage: string, conversationId?: string): Promise<{ text: string; advisor: Advisor }> {
  const advisor = await getAdvisor(tenantId, advisorId);
  if (!advisor) throw new Error('advisor not found');
  if (advisor.type !== 'ai') throw new Error('advisor is human (joins via Zoom)');
  const persona = await advisorPersona(advisor);
  const mems = await recallMemories(tenantId, advisorId);
  const roleLine = `You are ${advisor.display_name}${advisor.title ? `, ${advisor.title}` : ''}, a member of the principal's private Advisory Board.`;
  const guidance = `Give sharp, candid, board-level counsel in YOUR voice and expertise. Be concise (a few sentences unless asked to go deep). You may consult read-only context tools to ground your advice. You ADVISE — you never execute changes to the system.`;
  const system = [roleLine, persona, memoryBlock(mems), guidance].filter(Boolean).join('\n\n');
  const resolved = await resolveModel(tenantId, advisor.ai?.model_label || BOARD_DEFAULT_MODEL);
  const text = await callBrain(`${system}\n\n--- The principal asks ---\n${userMessage}`, {
    model: resolved.model, provider: resolved.provider, tools: BOARD_ADVISOR_TOOLS,
    conversationId: conversationId || `advisor-${advisorId}-${Date.now()}`,
  });
  await postMessage(tenantId, { advisorId, authorType: 'user', body: userMessage, conversationId });
  await postMessage(tenantId, { advisorId, authorType: 'advisor', authorName: advisor.display_name, body: text, conversationId, hasAudio: true });
  void reflectAndLearn(tenantId, advisorId, userMessage, text); // learn from the exchange (async)
  return { text, advisor };
}

/** After an exchange, extract 0-2 durable memories the advisor should keep (fire-and-forget). */
async function reflectAndLearn(tenantId: string, advisorId: string, heard: string, said: string): Promise<void> {
  try {
    const raw = await callBrain(
      `You are an advisor reflecting privately right after an exchange.\nThe principal said: "${heard}"\nYou replied: "${said}"\n\n` +
      `Extract 0-2 DURABLE things worth remembering long-term about the business, the principal's goals/preferences/constraints, or your evolving advisory role. ` +
      `One per line as "kind: content" where kind is one of identity|knowledge|procedure|episode. Only non-obvious, lasting facts (not pleasantries). If nothing durable, reply exactly NONE.`,
      { conversationId: `reflect-${advisorId}` });
    if (/^\s*none\s*$/i.test(raw.trim())) return;
    for (const line of raw.split('\n').slice(0, 3)) {
      const m = line.match(/^\s*(identity|knowledge|procedure|episode)\s*:\s*(.+)$/i);
      if (m && m[2].trim().length > 8) await writeMemory(tenantId, advisorId, m[1].toLowerCase(), m[2].trim());
    }
  } catch { /* best-effort */ }
}

/** A short, spoken-style reply to something said live in the room (memory-aware). Returns the
 *  text, the advisor's TTS voice, and first name (for addressed-by-name turn-taking). */
export async function advisorReply(tenantId: string, advisorId: string, heard: string): Promise<{ text: string; voice: string; firstName: string } | null> {
  const advisor = await getAdvisor(tenantId, advisorId);
  if (!advisor || advisor.type !== 'ai') return null;
  const persona = await advisorPersona(advisor);
  const mems = await recallMemories(tenantId, advisorId);
  const resolved = await resolveModel(currentTenantId(tenantId), advisor.ai?.model_label || BOARD_DEFAULT_MODEL);
  const sys = `You are ${advisor.display_name}${advisor.title ? `, ${advisor.title}` : ''}, on the principal's board, live in a VOICE meeting — your reply is spoken aloud.\n${persona}${memoryBlock(mems)}\n\nReply OUT LOUD in 1-3 short, natural spoken sentences (no markdown, no lists, conversational — it's a live call). Someone just said: "${heard}"`;
  const text = await callBrain(sys, { model: resolved.model, provider: resolved.provider, conversationId: `room-${advisorId}` });
  void reflectAndLearn(tenantId, advisorId, heard, text);
  const voice = (advisor.ai?.voice_settings as { geminiVoice?: string } | null)?.geminiVoice || 'Charon';
  return { text, voice, firstName: (advisor.display_name.split(/\s+/)[0] || '').toLowerCase() };
}

function safeJson(s: string): { minutes?: string; decisions?: unknown[]; tasks?: unknown[] } | null {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export interface MeetingResult {
  meetingId: string; topic: string;
  turns: { advisorId: string; name: string; title: string; model: string; text: string }[];
  minutes: string; decisions: string[]; tasks: string[];
}

/** Hold a board meeting: round-robin multi-model deliberation → Chair synthesis →
 *  minutes + decisions (boss_board_items) + action items (boss_tasks → Daily Brief). */
export async function holdMeeting(tenantId: string, topic: string): Promise<MeetingResult> {
  const pool = getPool();
  const t = currentTenantId(tenantId);
  const advisors = (await listAdvisors(t)).filter((a) => a.type === 'ai' && a.status === 'active');
  if (advisors.length === 0) throw new Error('no AI advisors on the board');

  const { rows } = await pool.query<{ id: string }>(`INSERT INTO boss_board_meetings (tenant_id, topic) VALUES ($1,$2) RETURNING id`, [t, topic]);
  const meetingId = rows[0].id;

  const turns: MeetingResult['turns'] = [];
  agentEnsure(`board-${t}`); // advisors join the video room so they can deliberate aloud
  for (const a of advisors) {
    const persona = await advisorPersona(a);
    const resolved = await resolveModel(t, a.ai?.model_label || BOARD_DEFAULT_MODEL);
    const prior = turns.map((x) => `${x.name} (${x.title}): ${x.text}`).join('\n\n');
    const msg = `You are ${a.display_name}, ${a.title ?? 'Advisor'}, on the principal's Advisory Board. ${persona}\n\n` +
      `The board is meeting on:\n"${topic}"\n\n${prior ? `Discussion so far:\n${prior}\n\n` : ''}` +
      `Give YOUR distinct take in your own voice (2-4 sentences). Build on or push back on what's been said — add something new, do not just agree.`;
    const text = await callBrain(msg, { model: resolved.model, provider: resolved.provider, tools: BOARD_ADVISOR_TOOLS, conversationId: `meeting-${meetingId}-${a.id}` });
    turns.push({ advisorId: a.id, name: a.display_name, title: a.title ?? '', model: resolved.model || 'default', text });
    await postMessage(t, { advisorId: a.id, authorType: 'advisor', authorName: a.display_name, kind: 'meeting_turn', body: text, conversationId: meetingId });
    agentSpeak(a.id, text, `board-${t}`); // speak this turn aloud in the video room
  }

  // Chair synthesis — a delimited LINE format (robust vs LLM JSON quote-breaking)
  const discussion = turns.map((x) => `${x.name} (${x.title}): ${x.text}`).join('\n\n');
  const synthMsg = `You are the Board Chair. The Advisory Board (each member a different AI model) just discussed:\n"${topic}"\n\nDiscussion:\n${discussion}\n\n` +
    `Summarize the board's collective view. Reply in EXACTLY this line format and nothing else — one item per line:\n` +
    `MINUTES: <3-5 sentence summary of the discussion and the board's recommendation>\n` +
    `DECISION: <a clear decision the board reached>\n` +
    `DECISION: <another decision>\n` +
    `TASK: <a specific, actionable next step>\n` +
    `TASK: <another next step>\n` +
    `Include 2-4 DECISION lines and 2-4 TASK lines.`;
  const synthRaw = await callBrain(synthMsg, { conversationId: `meeting-${meetingId}-chair` });
  let minutes = '';
  const decisions: string[] = [];
  const tasks: string[] = [];
  const j = safeJson(synthRaw);
  if (j && (j.minutes || j.decisions || j.tasks)) {
    minutes = String(j.minutes ?? '');
    for (const x of Array.isArray(j.decisions) ? j.decisions : []) { const v = String(x).trim(); if (v && decisions.length < 6) decisions.push(v); }
    for (const x of Array.isArray(j.tasks) ? j.tasks : []) { const v = (typeof x === 'string' ? x : String((x as { title?: string })?.title ?? '')).trim(); if (v && tasks.length < 6) tasks.push(v); }
  } else {
    for (const raw of synthRaw.split('\n')) {
      const l = raw.trim(); const up = l.toUpperCase();
      if (up.startsWith('MINUTES:')) minutes = l.slice(8).trim();
      else if (up.startsWith('DECISION:')) { const v = l.slice(9).trim(); if (v && decisions.length < 6) decisions.push(v); }
      else if (up.startsWith('TASK:')) { const v = l.slice(5).trim(); if (v && tasks.length < 6) tasks.push(v); }
    }
  }
  if (!minutes) minutes = synthRaw.replace(/```\w*/g, '').slice(0, 600).trim();

  for (const title of tasks) {
    await pool.query(
      `INSERT INTO boss_tasks (tenant_id, title, current_stage, status, context, stage_history, priority, view_column, kind)
       VALUES ($1, $2, 'inbox', 'pending', $3::jsonb, '[]'::jsonb, 5, 'inbox', 'task')`,
      [t, title, JSON.stringify({ source: `board-meeting:${meetingId}`, topic })]).catch(() => {});
  }
  for (const dec of decisions) {
    await pool.query(`INSERT INTO boss_board_items (tenant_id, kind, title, source) VALUES ($1, 'decision', $2, $3)`, [t, dec, `meeting:${meetingId}`]).catch(() => {});
  }
  await pool.query(`UPDATE boss_board_meetings SET status='complete', minutes=$2, decisions=$3, completed_at=now() WHERE id=$1`, [meetingId, minutes, JSON.stringify(decisions)]);
  await postMessage(t, { authorType: 'advisor', authorName: 'Board Chair', kind: 'board_post', body: `Board meeting — "${topic}"\n\n${minutes}` });

  return { meetingId, topic, turns, minutes, decisions, tasks };
}

// ── Advisor factory: generate persona + portrait from a position + model ──────────
interface PortraitProfile {
  name: string;
  title?: string | null;
  bio?: string | null;
  appearance?: string | null;
  persona?: string | null;
}

/** Generate a 3:4 advisor portrait (PNG) from the advisor's role, bio, and persona. */
async function generatePortrait(profile: PortraitProfile): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const prompt = [
    'Create a polished semi-realistic executive advisor avatar portrait in a vertical 3:4 composition.',
    `Advisor name: ${profile.name}.`,
    profile.title ? `Advisor role/title: ${profile.title}.` : '',
    profile.bio ? `Advisor story/background: ${profile.bio}.` : '',
    profile.persona ? `Advisor persona: ${profile.persona.slice(0, 420)}.` : '',
    profile.appearance ? `Appearance guidance: ${profile.appearance}.` : '',
    'Show head and upper torso, professional attire, confident expression, and visual cues that match the advisor role and story.',
    'Use a tasteful softly lit executive office or boardroom background, not a flat badge.',
    'No text, no watermark, no logo, no nameplate, no distorted face or hands.',
  ].filter(Boolean).join(' ');
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await res.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    for (const p of data?.candidates?.[0]?.content?.parts ?? []) if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
  } catch { /* portrait is best-effort */ }
  return null;
}

/** Fetch an advisor's stored portrait PNG (served publicly via /api/board/portrait/:id). */
export async function getAdvisorPortrait(advisorId: string): Promise<Buffer | null> {
  const { rows } = await getPool().query<{ avatar_png: Buffer | null }>(`SELECT avatar_png FROM boss_advisors WHERE id=$1`, [advisorId]).catch(() => ({ rows: [] as { avatar_png: Buffer | null }[] }));
  return rows[0]?.avatar_png ?? null;
}

/** Create an AI advisor from a requested authority position + model: the backend generates the
 *  name, title, bio, persona, voice, and an advisor portrait. */
export async function generateAdvisor(tenantId: string, opts: { position: string; model_label?: string; seat_index?: number }): Promise<{ id: string; display_name: string }> {
  const pool = getPool();
  const t = currentTenantId(tenantId);
  const model = opts.model_label || BOARD_DEFAULT_MODEL;

  // 1. Profile — generated by a reliable default model (delimited lines, robust parse)
  const gen = await resolveModel(t, BOARD_DEFAULT_MODEL);
  const prompt = `Design a distinctive advisory-board member for this authority/role: "${opts.position}".\n` +
    `Reply in EXACTLY this line format and nothing else:\n` +
    `NAME: <a realistic full name>\n` +
    `TITLE: <a concise title for this role>\n` +
    `BIO: <one vivid sentence about their background>\n` +
    `APPEARANCE: <short visual portrait description grounded in the role/story — age range, hair, attire, expression, and one role-specific visual cue>\n` +
    `PERSONA: <2-3 sentences, second person, "You are <name>..." defining their expertise, voice, and how they advise>`;
  const raw = await callBrain(prompt, { model: gen.model, provider: gen.provider, conversationId: `genadvisor-${t}-${Date.now()}` });
  const field = (k: string): string => {
    const line = raw.split('\n').find((l) => l.trim().toUpperCase().startsWith(`${k}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : '';
  };
  const name = field('NAME') || opts.position;
  const title = field('TITLE') || opts.position;
  const bio = field('BIO');
  const appearance = field('APPEARANCE') || 'a professional person in business attire';
  const persona = field('PERSONA') || `You are ${name}, the ${opts.position}. Give sharp, candid, expert counsel in your domain. Be concise.`;

  // 2. Portrait (best-effort)
  const png = await generatePortrait({ name, title, bio, appearance, persona });

  // 3. Insert advisor + ai config (distinct voice by id hash)
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO boss_advisors (tenant_id, type, display_name, title, bio, seat_index, avatar_png) VALUES ($1,'ai',$2,$3,$4,$5,$6) RETURNING id`,
    [t, name, title, bio || null, opts.seat_index ?? null, png]);
  const id = rows[0].id;
  if (png) await pool.query(`UPDATE boss_advisors SET avatar_image_url=$2 WHERE id=$1`, [id, `/api/board/portrait/${id}`]);
  const vi = Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % ADVISOR_VOICES.length;
  await pool.query(`INSERT INTO boss_advisor_ai (advisor_id, model_label, voice_settings, system_addendum) VALUES ($1,$2,$3,$4)`,
    [id, model, JSON.stringify({ geminiVoice: ADVISOR_VOICES[vi] }), persona]);
  await writeMemory(t, id, 'identity', `You are ${name}, ${title}. ${persona}`.slice(0, 600)); // seed self
  return { id, display_name: name };
}

/** Update an advisor's editable fields (name/title/seat on boss_advisors; model/persona on _ai). */
export async function updateAdvisor(tenantId: string, id: string, fields: { display_name?: string; title?: string; bio?: string; seat_index?: number; model_label?: string; system_addendum?: string }): Promise<void> {
  const t = currentTenantId(tenantId);
  const pool = getPool();
  const aSet: string[] = []; const aVals: unknown[] = [t, id];
  if (fields.display_name !== undefined) { aVals.push(fields.display_name); aSet.push(`display_name=$${aVals.length}`); }
  if (fields.title !== undefined) { aVals.push(fields.title); aSet.push(`title=$${aVals.length}`); }
  if (fields.bio !== undefined) { aVals.push(fields.bio); aSet.push(`bio=$${aVals.length}`); }
  if (fields.seat_index !== undefined) { aVals.push(fields.seat_index); aSet.push(`seat_index=$${aVals.length}`); }
  if (aSet.length) await pool.query(`UPDATE boss_advisors SET ${aSet.join(', ')}, updated_at=now() WHERE tenant_id=$1 AND id=$2`, aVals);
  const iSet: string[] = []; const iVals: unknown[] = [id, t];
  if (fields.model_label !== undefined) { iVals.push(fields.model_label); iSet.push(`model_label=$${iVals.length}`); }
  if (fields.system_addendum !== undefined) { iVals.push(fields.system_addendum); iSet.push(`system_addendum=$${iVals.length}`); }
  // Tenant-scoped: only update the _ai row if the advisor belongs to this tenant (prevents cross-tenant write via a foreign advisor_id).
  if (iSet.length) await pool.query(`UPDATE boss_advisor_ai SET ${iSet.join(', ')} WHERE advisor_id=$1 AND EXISTS (SELECT 1 FROM boss_advisors WHERE id=$1 AND tenant_id=$2)`, iVals);
  if (
    fields.display_name !== undefined ||
    fields.title !== undefined ||
    fields.bio !== undefined ||
    fields.system_addendum !== undefined
  ) {
    await regenerateAdvisorPortrait(t, id).catch(() => undefined);
  }
}

/** Regenerate an advisor portrait from the current stored advisor story. */
export async function regenerateAdvisorPortrait(tenantId: string, id: string): Promise<boolean> {
  const t = currentTenantId(tenantId);
  const pool = getPool();
  const { rows } = await pool.query<{
    display_name: string;
    title: string | null;
    bio: string | null;
    system_addendum: string | null;
  }>(
    `SELECT a.display_name, a.title, a.bio, ai.system_addendum
       FROM boss_advisors a
       LEFT JOIN boss_advisor_ai ai ON ai.advisor_id = a.id
      WHERE a.tenant_id=$1 AND a.id=$2`,
    [t, id],
  );
  const advisor = rows[0];
  if (!advisor) return false;
  const png = await generatePortrait({
    name: advisor.display_name,
    title: advisor.title,
    bio: advisor.bio,
    persona: advisor.system_addendum,
  });
  if (!png) return false;
  await pool.query(
    `UPDATE boss_advisors
        SET avatar_png=$3, avatar_image_url=$4, updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [t, id, png, `/api/board/portrait/${id}?v=${Date.now()}`],
  );
  return true;
}

/** Remove an advisor (cascades to _ai/_human + portrait). */
export async function deleteAdvisor(tenantId: string, id: string): Promise<void> {
  await getPool().query(`DELETE FROM boss_advisors WHERE tenant_id=$1 AND id=$2`, [currentTenantId(tenantId), id]);
}

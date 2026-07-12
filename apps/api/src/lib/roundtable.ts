/**
 * roundtable.ts — the interactive voice loop. A Recall bot per AI advisor joins the Zoom meeting,
 * streams live transcripts to our webhook, and when the advisor is addressed by name the brain
 * (memory-aware) forms a reply → Gemini TTS → mp3 (lamejs, no ffmpeg) → Recall output_audio → spoken.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { advisorReply } from './board.js';

const RECALL_KEY = process.env.RECALL_API_KEY || '';
const RECALL_BASE = process.env.RECALL_BASE || 'https://us-west-2.recall.ai/api/v1';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const lastReplyAt = new Map<string, number>(); // botId -> ts (debounce)

async function geminiPcm(text: string, voice: string): Promise<Buffer | null> {
  if (!GEMINI_KEY) return null;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await res.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
  for (const p of d?.candidates?.[0]?.content?.parts ?? []) if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
  return null;
}

function pcmToMp3B64(pcm: Buffer, rate = 24000): string {
  const enc = new Mp3Encoder(1, rate, 64);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const out: Buffer[] = [];
  for (let i = 0; i < samples.length; i += 1152) {
    const buf = enc.encodeBuffer(samples.subarray(i, i + 1152));
    if (buf.length) out.push(Buffer.from(buf));
  }
  const end = enc.flush();
  if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out).toString('base64');
}

function silentMp3B64(): string {
  return pcmToMp3B64(Buffer.from(new Int16Array(12000).buffer)); // ~0.5s silence (enables output_audio)
}

async function outputAudio(botId: string, mp3b64: string): Promise<void> {
  await fetch(`${RECALL_BASE}/bot/${botId}/output_audio/`, {
    method: 'POST', headers: { Authorization: 'Token ' + RECALL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'mp3', b64_data: mp3b64 }), signal: AbortSignal.timeout(20_000),
  }).catch(() => { /* best-effort */ });
}

/** Parse a Recall transcript.data webhook event defensively. */
function parseTranscript(ev: Record<string, unknown>): { botId?: string; speaker: string; text: string; isFinal: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = ev as any;
  const data = e?.data?.data ?? e?.data ?? e;
  const botId = e?.data?.bot?.id || e?.bot?.id || data?.bot_id || data?.bot?.id;
  const words = data?.words || data?.transcript?.words;
  const text = String(Array.isArray(words) ? words.map((w: { text?: string; word?: string }) => w.text || w.word || '').join(' ') : (data?.text || data?.transcript?.text || '')).trim();
  const speaker = String(data?.participant?.name || data?.speaker || data?.participant?.id || '');
  const isFinal = data?.is_final ?? data?.transcript?.is_final ?? true;
  return { botId, speaker, text, isFinal: Boolean(isFinal) };
}

/** Live utterance → if the advisor is addressed by name, they reply aloud in the room. */
export async function handleUtterance(tenantId: string, advisorId: string, firstName: string, ev: Record<string, unknown>): Promise<void> {
  const { botId, speaker, text, isFinal } = parseTranscript(ev);
  if (!botId || !isFinal || text.length < 4) return;
  if (/advisor/i.test(speaker)) return; // ignore the advisor bots' own speech
  if (!firstName || !text.toLowerCase().includes(firstName)) return; // addressed-by-name turn-taking
  const now = Date.now();
  if (now - (lastReplyAt.get(botId) || 0) < 6000) return; // debounce
  lastReplyAt.set(botId, now);
  const reply = await advisorReply(tenantId, advisorId, text);
  if (!reply?.text) return;
  const pcm = await geminiPcm(reply.text, reply.voice);
  if (pcm) await outputAudio(botId, pcmToMp3B64(pcm));
}

/** Spawn a Recall bot for an advisor: joins the meeting, listens (transcript→webhook), speaks. */
export async function spawnAdvisorBot(opts: { meetingUrl: string; advisorId: string; advisorName: string; firstName: string; webhookBase: string; secret: string }): Promise<{ id?: string; error?: string }> {
  if (!RECALL_KEY) return { error: 'RECALL_API_KEY not set' };
  const url = `${opts.webhookBase}/api/roundtable/transcript?advisor=${opts.advisorId}&name=${encodeURIComponent(opts.firstName)}&secret=${opts.secret}`;
  const res = await fetch(`${RECALL_BASE}/bot/`, {
    method: 'POST', headers: { Authorization: 'Token ' + RECALL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meeting_url: opts.meetingUrl,
      bot_name: `${opts.advisorName} — AI Advisor`,
      automatic_audio_output: { in_call_recording: { data: { kind: 'mp3', b64_data: silentMp3B64() } } },
      recording_config: {
        transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: 'en' } } },
        realtime_endpoints: [{ type: 'webhook', url, events: ['transcript.data'] }],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await res.json() as { id?: string; detail?: string };
  return res.ok ? { id: d.id } : { error: d?.detail || JSON.stringify(d).slice(0, 160) };
}

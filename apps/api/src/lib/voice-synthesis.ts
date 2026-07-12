export interface VoiceOpts {
  instruct?: string;
  omniInstruct?: string;
  omniEngine?: string;
  omniVoice?: string;
  profile_id?: string;
  effect_preset?: string;
  speed?: number;
  geminiVoice?: string;
}

export interface PersonaVoiceRequest {
  surface?: string;
  handle?: string;
  displayName?: string;
  title?: string;
  voice?: VoiceOpts;
}

export const ADVISOR_VOICES = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Aoede', 'Zephyr', 'Orus', 'Leda'];

const OMNIVOICE_URL = process.env.OMNIVOICE_URL || 'http://host.docker.internal:3900';
const OMNIVOICE_ENGINE = process.env.OMNIVOICE_ENGINE || 'kittentts';
const OMNIVOICE_TIMEOUT_MS = Number(process.env.OMNIVOICE_TIMEOUT_MS || 120_000);
const KITTEN_VOICES = [
  'expr-voice-2-m',
  'expr-voice-2-f',
  'expr-voice-3-m',
  'expr-voice-3-f',
  'expr-voice-4-m',
  'expr-voice-4-f',
  'expr-voice-5-m',
  'expr-voice-5-f',
];

const PERSONA_VOICES: Record<string, VoiceOpts> = {
  office: {
    geminiVoice: 'Kore',
    omniVoice: 'expr-voice-4-f',
    omniInstruct: 'female, american accent, middle-aged, moderate pitch',
    effect_preset: 'broadcast',
    speed: 0.96,
    instruct: 'Polished executive assistant voice: warm, calm, competent, concise, and discreet. Natural conversational pacing.',
  },
  gio: {
    geminiVoice: 'Orus',
    omniVoice: 'expr-voice-3-m',
    omniInstruct: 'male, american accent, middle-aged, low pitch',
    effect_preset: 'broadcast',
    speed: 0.98,
    instruct: 'Present technical operator voice: warm, grounded, precise, and collaborative. Confident without sounding robotic.',
  },
  codex: {
    geminiVoice: 'Orus',
    omniVoice: 'expr-voice-2-m',
    omniInstruct: 'male, american accent, young adult, moderate pitch',
    effect_preset: 'broadcast',
    speed: 0.98,
    instruct: 'Senior engineering collaborator voice: intelligent, warm, clear, lightly playful, and steady under pressure.',
  },
  spanky: { geminiVoice: 'Puck', omniVoice: 'expr-voice-5-m', omniInstruct: 'male, american accent, young adult, high pitch', speed: 1.04, instruct: 'Bright ringleader voice: quick, cheerful, resourceful, and punchy. Keep it natural, not cartoonish.' },
  alfalfa: { geminiVoice: 'Zephyr', omniVoice: 'expr-voice-2-m', omniInstruct: 'male, american accent, teenager, moderate pitch', speed: 1.0, instruct: 'Earnest comic voice: upbeat, slightly theatrical, sincere, and endearing. Avoid parody.' },
  buckwheat: { geminiVoice: 'Leda', omniVoice: 'expr-voice-2-f', omniInstruct: 'female, american accent, young adult, moderate pitch', speed: 0.98, instruct: 'Gentle helpful voice: clear, warm, curious, and quietly funny. Avoid caricature.' },
  butch: { geminiVoice: 'Fenrir', omniVoice: 'expr-voice-4-m', omniInstruct: 'male, american accent, middle-aged, low pitch', speed: 0.96, instruct: 'Blunt street-smart voice: compact, confident, and skeptical, with a dry edge.' },
  darla: { geminiVoice: 'Aoede', omniVoice: 'expr-voice-3-f', omniInstruct: 'female, american accent, young adult, moderate pitch', speed: 0.98, instruct: 'Clear warm coordinator voice: charming, direct, organized, and socially sharp.' },
  froggy: { geminiVoice: 'Puck', omniVoice: 'expr-voice-5-m', omniInstruct: 'male, american accent, young adult, high pitch', speed: 1.02, instruct: 'Distinctive comic voice: lively, raspy energy, fast instincts, and playful timing without becoming a bit.' },
  msroberts: { geminiVoice: 'Kore', omniVoice: 'expr-voice-4-f', omniInstruct: 'female, american accent, middle-aged, moderate pitch', speed: 0.94, instruct: 'Teacher-manager voice: patient, crisp, capable, and kind, with gentle authority.' },
  petey: { geminiVoice: 'Leda', omniVoice: 'expr-voice-2-f', omniInstruct: 'female, american accent, young adult, high pitch', speed: 1.02, instruct: 'Loyal scout voice: light, attentive, alert, and friendly.' },
  porky: { geminiVoice: 'Puck', omniVoice: 'expr-voice-5-m', omniInstruct: 'male, american accent, teenager, high pitch', speed: 1.03, instruct: 'Helpful comic sidekick voice: bright, practical, and quick to volunteer. Natural, never shrill.' },
  stymie: { geminiVoice: 'Charon', omniVoice: 'expr-voice-3-m', omniInstruct: 'male, american accent, middle-aged, low pitch', speed: 0.95, instruct: 'Wise-beyond-the-room voice: warm, dry, observant, and confident with careful pacing.' },
  wheezer: { geminiVoice: 'Zephyr', omniVoice: 'expr-voice-2-f', omniInstruct: 'female, american accent, young adult, moderate pitch', speed: 0.97, instruct: 'Soft-spoken analyst voice: gentle, thoughtful, and precise.' },
  ponyboy: { geminiVoice: 'Leda', omniVoice: 'expr-voice-3-m', omniInstruct: 'male, american accent, young adult, moderate pitch', speed: 0.96, instruct: 'Reflective creative voice: observant, sensitive, literary, and quietly brave.' },
  sodapop: { geminiVoice: 'Puck', omniVoice: 'expr-voice-5-m', omniInstruct: 'male, american accent, young adult, moderate pitch', speed: 1.02, instruct: 'Friendly operations voice: energetic, optimistic, smooth, and people-first.' },
  dally: { geminiVoice: 'Fenrir', omniVoice: 'expr-voice-4-m', omniInstruct: 'male, american accent, young adult, very low pitch', speed: 0.97, instruct: 'Hard-edged fixer voice: terse, protective, and unsentimental, with controlled intensity.' },
  darry: { geminiVoice: 'Charon', omniVoice: 'expr-voice-3-m', omniInstruct: 'male, american accent, middle-aged, low pitch', speed: 0.94, instruct: 'Responsible older-brother voice: grounded, protective, firm, and practical.' },
  buckley: { geminiVoice: 'Orus', omniVoice: 'expr-voice-4-m', omniInstruct: 'male, american accent, middle-aged, low pitch', speed: 0.96, instruct: 'Strategic producer voice: composed, commercially sharp, and direct.' },
  mercury: { geminiVoice: 'Zephyr', omniVoice: 'expr-voice-2-m', omniInstruct: 'male, american accent, young adult, high pitch', speed: 1.03, instruct: 'Fast creative technologist voice: bright, nimble, clever, and concise.' },
  slack: { geminiVoice: 'Aoede', omniVoice: 'expr-voice-3-f', omniInstruct: 'female, american accent, young adult, moderate pitch', speed: 0.98, instruct: 'Team comms voice: friendly, social, clear, and action-oriented.' },
  board: {
    geminiVoice: 'Charon',
    omniVoice: 'expr-voice-4-m',
    omniInstruct: 'male, american accent, middle-aged, low pitch',
    effect_preset: 'broadcast',
    speed: 0.94,
    instruct: 'Board-chair voice: mature, composed, concise, and decisive. Sound like a trusted advisor summarizing the room.',
  },
};

function hashString(value: string): number {
  let h = 0;
  for (const char of value) h = (h * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function normalizeKey(value?: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function mergeVoice(base: VoiceOpts, override?: VoiceOpts): VoiceOpts {
  return { ...base, ...(override ?? {}) };
}

export function resolvePersonaVoice(req: PersonaVoiceRequest = {}): VoiceOpts {
  const candidates = [
    normalizeKey(req.handle),
    normalizeKey(req.displayName),
    normalizeKey(req.surface),
  ].filter(Boolean);

  for (const key of candidates) {
    if (PERSONA_VOICES[key]) return mergeVoice(PERSONA_VOICES[key], req.voice);
  }

  const seed = `${req.surface || ''}:${req.displayName || req.handle || req.title || 'default'}`;
  const geminiVoice = ADVISOR_VOICES[hashString(seed) % ADVISOR_VOICES.length];
  const omniVoice = KITTEN_VOICES[hashString(seed) % KITTEN_VOICES.length];
  const role = [req.displayName, req.title].filter(Boolean).join(', ') || 'assistant';
  return mergeVoice({
    geminiVoice,
    omniVoice,
    omniInstruct: omniVoice.endsWith('-f')
      ? 'female, american accent, young adult, moderate pitch'
      : 'male, american accent, young adult, moderate pitch',
    effect_preset: 'broadcast',
    speed: 0.98,
    instruct: `Distinct voice for ${role}: natural, persona-appropriate, concise, and emotionally aligned with the role. Avoid parody or imitation.`,
  }, req.voice);
}

function wavHeader(pcmLen: number, rate = 24000, bits = 16, ch = 1): Buffer {
  const byteRate = (rate * ch * bits) / 8;
  const blockAlign = (ch * bits) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcmLen, 40);
  return h;
}

/** PRIMARY voice: self-hosted OmniVoice Studio. */
async function omniVoiceTts(text: string, voice?: VoiceOpts): Promise<Buffer> {
  const model = voice?.omniEngine ?? OMNIVOICE_ENGINE;
  const payload: Record<string, string | number | boolean> = {
    model,
    input: text,
    voice: voice?.omniVoice ?? voice?.profile_id ?? (model === 'omnivoice' ? 'demo0001' : 'expr-voice-2-f'),
    response_format: 'wav',
    speed: voice?.speed ?? 1.0,
  };
  if (model === 'omnivoice' && voice?.omniInstruct) payload.instruct = voice.omniInstruct;

  const res = await fetch(`${OMNIVOICE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3900' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OMNIVOICE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`omnivoice ${res.status}: ${body.slice(0, 220)}`);
  }
  if (!(res.headers.get('content-type') || '').includes('audio')) throw new Error('omnivoice non-audio');
  return Buffer.from(await res.arrayBuffer());
}

/** FALLBACK voice: Google Gemini TTS. */
async function geminiTts(text: string, voiceName = 'Charon'): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
  let b64: string | undefined;
  for (const p of data?.candidates?.[0]?.content?.parts ?? []) if (p.inlineData?.data) b64 = p.inlineData.data;
  if (!b64) throw new Error('no audio from Gemini TTS');
  const pcm = Buffer.from(b64, 'base64');
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

/** Persona voice: OmniVoice first, Gemini fallback. Returns playable audio bytes. */
export async function generateVoice(text: string, voice?: VoiceOpts): Promise<{ wav: Buffer; engine: string }> {
  try {
    return { wav: await omniVoiceTts(text, voice), engine: 'omnivoice' };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[voice] OmniVoice TTS failed, falling back to Gemini:', (err as Error).message);
    return { wav: await geminiTts(text, voice?.geminiVoice ?? 'Charon'), engine: 'gemini' };
  }
}

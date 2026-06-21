/**
 * Voice routes — /api/voice/*
 *
 *   GET  /devices              — list known voice-capable devices
 *   PUT  /devices/:deviceId    — update device configuration
 *   GET  /stream               — WebSocket endpoint for bi-directional voice streaming
 *
 * Phase 4: @boss/voice is a stub.  These routes declare the full contract
 * so clients can be built now; actual STT/TTS processing ships in Phase 4.
 *
 * WebSocket protocol (v1):
 *   Client → Server:  { type: "audio_chunk", payload: "<base64 PCM 16kHz mono>" }
 *                     { type: "end_utterance" }
 *   Server → Client:  { type: "transcript", text: "...", isFinal: bool }
 *                     { type: "tts_audio",  payload: "<base64 PCM>" }
 *                     { type: "error",      message: "..." }
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// Voice-pipeline backends (edge-tts + whisper stt containers).
const STT_URL = process.env.STT_URL || 'http://stt:8000';
const TTS_URL = process.env.TTS_URL || 'http://tts:8003/speak';
const VOICE_JOBS_DIR = process.env.VOICE_JOBS_DIR || '/tmp/boss-jobs';

fs.mkdir(VOICE_JOBS_DIR, { recursive: true }).catch(() => {});

async function gcVoiceJobsDir(maxAgeMs = 3_600_000): Promise<void> {
  try {
    const now = Date.now();
    const files = await fs.readdir(VOICE_JOBS_DIR);
    await Promise.all(
      files.map(async (f) => {
        try {
          const p = path.join(VOICE_JOBS_DIR, f);
          const st = await fs.stat(p);
          if (now - st.mtimeMs > maxAgeMs) await fs.unlink(p);
        } catch {
          /* best effort */
        }
      }),
    );
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// In-memory device registry (Phase 4 — replace with DB)
// ---------------------------------------------------------------------------

export interface VoiceDevice {
  id: string;
  tenantId: string;
  label: string;
  type: 'smart_speaker' | 'browser' | 'mobile' | 'desktop';
  enabled: boolean;
  wakeWord?: string;
  language: string;
  sttProvider: string;
  ttsProvider: string;
  ttsVoice?: string;
  updatedAt: Date;
}

const deviceRegistry = new Map<string, VoiceDevice>();

// Seed a default browser device
deviceRegistry.set('device-browser-default', {
  id: 'device-browser-default',
  tenantId: 'default',
  label: 'Browser (default)',
  type: 'browser',
  enabled: true,
  language: 'en-US',
  sttProvider: 'web-speech',
  ttsProvider: 'web-speech',
  updatedAt: new Date(),
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const deviceIdParam = {
  type: 'object',
  required: ['deviceId'],
  properties: { deviceId: { type: 'string', minLength: 1 } },
} as const;

const deviceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string' },
    label: { type: 'string' },
    type: { type: 'string' },
    enabled: { type: 'boolean' },
    wakeWord: { type: 'string' },
    language: { type: 'string' },
    sttProvider: { type: 'string' },
    ttsProvider: { type: 'string' },
    ttsVoice: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const updateDeviceBodySchema = {
  type: 'object',
  properties: {
    label: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    wakeWord: { type: 'string' },
    language: { type: 'string' },
    sttProvider: { type: 'string' },
    ttsProvider: { type: 'string' },
    ttsVoice: { type: 'string' },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdateDeviceBody {
  label?: string;
  enabled?: boolean;
  wakeWord?: string;
  language?: string;
  sttProvider?: string;
  ttsProvider?: string;
  ttsVoice?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function voiceRoutes(server: FastifyInstance) {
  /**
   * GET /api/voice/devices
   * List all registered voice devices for the current tenant.
   *
   * Example response:
   *   [{ "id": "device-browser-default", "label": "Browser (default)", "enabled": true, ... }]
   */
  server.get(
    '/devices',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: deviceSchema,
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const devices = Array.from(deviceRegistry.values())
        .filter((d) => d.tenantId === tenantId || d.tenantId === 'default')
        .map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() }));

      return reply.status(200).send(devices);
    },
  );

  /**
   * PUT /api/voice/devices/:deviceId
   * Update a voice device's configuration.
   *
   * Example request:
   *   PUT /api/voice/devices/device-browser-default
   *   { "enabled": false, "language": "es-ES" }
   *
   * Example response:
   *   { "id": "device-browser-default", "enabled": false, "language": "es-ES", ... }
   */
  server.put<{ Params: { deviceId: string }; Body: UpdateDeviceBody }>(
    '/devices/:deviceId',
    {
      schema: {
        params: deviceIdParam,
        body: updateDeviceBodySchema,
        response: { 200: deviceSchema },
      },
    },
    async (
      request: FastifyRequest<{ Params: { deviceId: string }; Body: UpdateDeviceBody }>,
      reply: FastifyReply,
    ) => {
      const { deviceId } = request.params;
      const existing = deviceRegistry.get(deviceId);

      if (!existing) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Voice device '${deviceId}' not found`,
        });
      }

      const updated: VoiceDevice = {
        ...existing,
        ...request.body,
        id: existing.id,         // never allow ID change
        tenantId: existing.tenantId,
        updatedAt: new Date(),
      };

      deviceRegistry.set(deviceId, updated);
      request.log.info({ deviceId, userId: request.auth?.userId }, 'Voice device updated');

      return reply.status(200).send({ ...updated, updatedAt: updated.updatedAt.toISOString() });
    },
  );

  /**
   * GET /api/voice/stream
   * WebSocket endpoint for real-time bi-directional voice streaming.
   *
   * Protocol:
   *   Upgrade: websocket
   *   On connection: server sends { type: "ready", deviceId: "..." }
   *   Client sends audio chunks; server responds with transcripts and TTS audio.
   *
   * Phase 4 stub: accepts the WebSocket upgrade and immediately sends a
   * "not_available" message, then closes gracefully.
   */
  server.get(
    '/stream',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            deviceId: { type: 'string' },
            language: { type: 'string', default: 'en-US' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Check for WebSocket upgrade request
      const upgradeHeader = request.headers.upgrade?.toLowerCase();
      if (upgradeHeader === 'websocket') {
        // Raw WebSocket upgrade handling — until @fastify/websocket is wired
        return reply.status(426).send({
          error: 'Upgrade Required',
          message:
            'WebSocket voice streaming requires @fastify/websocket (Phase 4). ' +
            'Upgrade the connection with a proper WebSocket client.',
        });
      }

      // Regular HTTP fallback — returns streaming status
      return reply.status(200).send({
        status: 'pending',
        message: 'Voice streaming endpoint ready. Connect via WebSocket.',
        protocol: 'ws',
        endpoint: '/api/voice/stream',
      });
    },
  );

  /**
   * POST /api/voice/command
   * Full voice pipeline: audio → STT (whisper) → echo response → TTS (edge-tts)
   *   Body: { audio: base64, audioFormat?: "audio/wav"|"audio/mpeg", filename?: string }
   *   Returns: { transcript, response, audioUrl }
   *
   * V.1 uses an echo response ("I heard you say: ..."); V.3 will route the
   * transcript through the brain router for real answers. TTS goes through
   * the free edge-tts container on http://tts:8003/speak — NOT the Google TTS
   * route at /api/tts/synthesize (which remains available for callers that
   * want Wavenet voices and have GOOGLE_TTS_API_KEY set).
   */
  server.post<{ Body: { audio: string; audioFormat?: string; filename?: string } }>(
    '/command',
    {
      schema: {
        body: {
          type: 'object',
          required: ['audio'],
          properties: {
            audio: { type: 'string', maxLength: 50_000_000 },
            audioFormat: { type: 'string' },
            filename: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { audio, audioFormat = 'audio/mpeg', filename = 'voice.mp3' } = request.body;

      let audioBuffer: Buffer;
      try {
        audioBuffer = Buffer.from(audio, 'base64');
      } catch {
        return reply.status(400).send({ error: 'Invalid base64 audio' });
      }

      let transcript = '';
      try {
        const form = new FormData();
        form.append('file', new Blob([audioBuffer], { type: audioFormat }), filename);
        const sttRes = await fetch(`${STT_URL}/transcribe`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
        if (!sttRes.ok) {
          const t = await sttRes.text();
          return reply.status(502).send({ error: 'STT failed', message: t.slice(0, 300) });
        }
        const sttData = (await sttRes.json()) as { text?: string };
        transcript = (sttData.text || '').trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'STT error');
        return reply.status(502).send({ error: 'STT error', message: msg });
      }

      if (!transcript) {
        return reply.status(200).send({ transcript: '', response: 'No speech detected', audioUrl: null });
      }

      const responseText = `I heard you say: ${transcript}`;

      let audioUrl: string | null = null;
      try {
        const ttsRes = await fetch(TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: responseText }),
          signal: AbortSignal.timeout(30_000),
        });
        if (ttsRes.ok) {
          const audioBytes = Buffer.from(await ttsRes.arrayBuffer());
          void gcVoiceJobsDir();
          const audioId = randomUUID();
          await fs.writeFile(path.join(VOICE_JOBS_DIR, `${audioId}.mp3`), audioBytes);
          audioUrl = `/api/voice/audio/${audioId}`;
        } else {
          request.log.warn({ status: ttsRes.status }, 'TTS non-OK — sending text-only response');
        }
      } catch (err) {
        request.log.warn({ err }, 'TTS synthesis failed — sending text-only response');
      }

      return reply.status(200).send({ transcript, response: responseText, audioUrl });
    },
  );

  /**
   * POST /api/voice/synthesize
   * Text → edge-tts mp3 (free, no API key). Returns {audioUrl} for the
   * browser to fetch via <audio>. Used by VoiceControl.tsx as a drop-in
   * free alternative to /api/tts/synthesize (Google Wavenet, paid).
   *
   *   Body: { text: string }
   *   Returns: { audioUrl: string, textLength: number }
   */
  server.post<{ Body: { text: string } }>(
    '/synthesize',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { text } = request.body;
      const clean = text.trim();
      if (!clean) {
        return reply.status(400).send({ error: 'text is required and non-empty' });
      }
      try {
        const ttsRes = await fetch(TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!ttsRes.ok) {
          const body = await ttsRes.text();
          request.log.error({ status: ttsRes.status, body: body.slice(0, 300) }, 'edge-tts error');
          return reply.status(502).send({ error: 'TTS synthesis failed' });
        }
        const audioBytes = Buffer.from(await ttsRes.arrayBuffer());
        void gcVoiceJobsDir();
        const audioId = randomUUID();
        await fs.writeFile(path.join(VOICE_JOBS_DIR, `${audioId}.mp3`), audioBytes);
        return reply.status(200).send({
          audioUrl: `/api/voice/audio/${audioId}`,
          textLength: clean.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'synthesize error');
        return reply.status(502).send({ error: 'TTS error', message: msg });
      }
    },
  );

  /**
   * GET /api/voice/audio/:audioId
   * Serves a previously synthesized voice-response mp3. Public (skipAuth) so
   * browser <audio> tags can fetch without an Authorization header — the
   * audioId is a server-minted UUID that is only returned to an authenticated
   * caller of POST /command, so it is effectively a single-use capability.
   */
  server.get<{ Params: { audioId: string } }>(
    '/audio/:audioId',
    {
      config: { skipAuth: true },
      schema: {
        params: {
          type: 'object',
          required: ['audioId'],
          properties: { audioId: { type: 'string', pattern: '^[a-zA-Z0-9-]{8,64}$' } },
        },
      },
    },
    async (request, reply) => {
      const { audioId } = request.params;
      const filePath = path.join(VOICE_JOBS_DIR, `${audioId}.mp3`);
      try {
        const data = await fs.readFile(filePath);
        return reply.type('audio/mpeg').send(data);
      } catch {
        return reply.status(404).send({ error: 'audio expired or not found' });
      }
    },
  );

  /**
   * POST /api/voice/transcribe
   * Pure speech-to-text. Accepts a base64 audio payload, forwards it to
   * the internal STT service, returns the transcript. Used by the
   * dictation mics on the agent chat surfaces (COO / Rascals / Outsiders)
   * — they need transcript-only, not the full STT→brain→TTS loop that
   * /command runs.
   */
  server.post<{ Body: { audio: string; audioFormat?: string; filename?: string } }>(
    '/transcribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['audio'],
          properties: {
            audio: { type: 'string', maxLength: 50_000_000 },
            audioFormat: { type: 'string' },
            filename: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { audio, audioFormat = 'audio/webm', filename = 'voice.webm' } = request.body;
      let audioBuffer: Buffer;
      try {
        audioBuffer = Buffer.from(audio, 'base64');
      } catch {
        return reply.status(400).send({ error: 'Invalid base64 audio' });
      }
      try {
        const form = new FormData();
        form.append('file', new Blob([audioBuffer], { type: audioFormat }), filename);
        const sttRes = await fetch(`${STT_URL}/transcribe`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
        if (!sttRes.ok) {
          const t = await sttRes.text();
          return reply.status(502).send({ error: 'STT failed', message: t.slice(0, 300) });
        }
        const sttData = (await sttRes.json()) as { text?: string };
        const transcript = (sttData.text || '').trim();
        return reply.status(200).send({ transcript });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'STT error');
        return reply.status(502).send({ error: 'STT error', message: msg });
      }
    },
  );

  /**
   * POST /api/voice/sessions/cleanup
   * Kill all voice-* tmux sessions. Called when voice mode is muted.
   */
  server.post(
    '/sessions/cleanup',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { stdout } = await execFileAsync(
          '/home/boss/boss-dev/scripts/voice-session-cleanup.sh',
          [],
          { timeout: 10_000, env: { ...process.env, HOME: '/home/boss' } },
        );
        const result = JSON.parse(stdout.trim());
        request.log.info({ result }, 'Voice sessions cleaned up');
        return reply.status(200).send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'Voice session cleanup failed');
        return reply.status(500).send({ error: msg });
      }
    },
  );
}

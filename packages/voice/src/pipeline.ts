/**
 * Voice pipeline — full round-trip: audio in -> STT -> brain router -> TTS -> audio out.
 *
 * Flow:
 *   1. Receive raw audio from Voice PE (WebSocket or browser)
 *   2. STT: audio -> transcript
 *   3. Build brain request with room context injected
 *   4. Brain router: transcript -> text response
 *   5. TTS: text -> audio
 *   6. Return audio to caller for playback on the device
 */

import type { STTEngine } from './stt/engine.js';
import type { TTSEngine } from './tts/engine.js';
import { buildRoomContext, formatContextForPrompt } from './context.js';
import type { DeviceRegistry } from './devices.js';

// Minimal brain-router surface required by the pipeline.
// The full BrainRouter type lives in @boss/brain — we depend only on the interface
// to avoid a circular package dependency.
export interface PipelineBrainAdapter {
  route(request: PipelineBrainRequest): Promise<PipelineBrainResponse>;
}

export interface PipelineBrainRequest {
  id: string;
  tenantId: string;
  userId: string;
  prompt: string;
  type: 'chat';
  context?: Record<string, unknown>;
}

export interface PipelineBrainResponse {
  content: string;
  error?: string;
}

// ── Pipeline types ────────────────────────────────────────────

export interface VoiceRequest {
  /** Originating device ID — used to resolve room context. */
  deviceId: string;
  tenantId: string;
  userId: string;
  /** Raw audio buffer (WAV/PCM/WebM) received from the device. */
  audio: Buffer;
  /** Spoken language hint for STT. */
  language?: string;
}

export interface VoiceResponse {
  /** Text transcript of what the user said. */
  transcript: string;
  /** Text of BOS's reply. */
  reply: string;
  /** Audio buffer to play back on the device. */
  audio: Buffer;
  /** Audio format of the output. */
  audioFormat: 'wav' | 'mp3' | 'opus' | 'pcm';
  latency: {
    sttMs: number;
    brainMs: number;
    ttsMs: number;
    totalMs: number;
  };
}

export interface PipelineConfig {
  stt: STTEngine;
  tts: TTSEngine;
  brain: PipelineBrainAdapter;
  devices: DeviceRegistry;
}

// ── Pipeline implementation ───────────────────────────────────

export class VoicePipeline {
  private stt: STTEngine;
  private tts: TTSEngine;
  private brain: PipelineBrainAdapter;
  private devices: DeviceRegistry;

  constructor(config: PipelineConfig) {
    this.stt = config.stt;
    this.tts = config.tts;
    this.brain = config.brain;
    this.devices = config.devices;
  }

  /**
   * Process a full voice turn.
   * Returns transcript, text reply, and audio reply.
   */
  async process(request: VoiceRequest): Promise<VoiceResponse> {
    const pipelineStart = Date.now();

    // ── Step 1: STT ────────────────────────────────────────
    const sttStart = Date.now();
    const sttResult = await this.stt.transcribe(request.audio, {
      language: request.language,
    });
    const sttMs = Date.now() - sttStart;

    if (!sttResult.text) {
      throw new Error('STT returned empty transcript');
    }

    // ── Step 2: Build prompt with room context ─────────────
    const roomCtx = buildRoomContext(request.deviceId, this.devices);
    const contextHeader = roomCtx ? formatContextForPrompt(roomCtx) : '';
    const prompt = contextHeader
      ? `${contextHeader}\n\nUser said: ${sttResult.text}`
      : sttResult.text;

    // ── Step 3: Brain ──────────────────────────────────────
    const brainStart = Date.now();
    const brainResponse = await this.brain.route({
      id: `voice-${Date.now()}-${request.deviceId}`,
      tenantId: request.tenantId,
      userId: request.userId,
      prompt,
      type: 'chat',
      context: roomCtx ? { room: roomCtx.room, deviceId: roomCtx.deviceId } : undefined,
    });
    const brainMs = Date.now() - brainStart;

    const replyText = brainResponse.error
      ? 'I ran into a problem processing that. Please try again.'
      : brainResponse.content;

    // ── Step 4: TTS ────────────────────────────────────────
    const ttsStart = Date.now();
    const ttsResult = await this.tts.synthesize(replyText);
    const ttsMs = Date.now() - ttsStart;

    return {
      transcript: sttResult.text,
      reply: replyText,
      audio: ttsResult.audio,
      audioFormat: ttsResult.format,
      latency: {
        sttMs,
        brainMs,
        ttsMs,
        totalMs: Date.now() - pipelineStart,
      },
    };
  }

  /**
   * Health check across all three pipeline components.
   */
  async health(): Promise<{ stt: boolean; tts: boolean }> {
    const [sttOk, ttsOk] = await Promise.all([
      this.stt.healthCheck(),
      this.tts.healthCheck(),
    ]);
    return { stt: sttOk, tts: ttsOk };
  }
}

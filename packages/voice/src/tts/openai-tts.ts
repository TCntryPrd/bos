/**
 * OpenAI TTS integration.
 * Uses the OpenAI audio/speech endpoint.
 * Endpoint: POST https://api.openai.com/v1/audio/speech
 */

import type { TTSEngine, TTSOptions, TTSResult } from './engine.js';

export interface OpenAITTSConfig {
  apiKey: string;
  /** Default voice. One of: alloy, echo, fable, onyx, nova, shimmer. Default: 'nova' */
  defaultVoice?: OpenAIVoice;
  /** Model. Default: 'tts-1' (low-latency). Use 'tts-1-hd' for higher quality. */
  model?: 'tts-1' | 'tts-1-hd';
  /** Request timeout in milliseconds. Default: 15_000 */
  timeoutMs?: number;
}

export type OpenAIVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

const OPENAI_BASE = 'https://api.openai.com/v1';
const AVAILABLE_VOICES: OpenAIVoice[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export class OpenAITTS implements TTSEngine {
  readonly name = 'openai-tts';

  private readonly config: Required<OpenAITTSConfig>;

  constructor(config: OpenAITTSConfig) {
    this.config = {
      apiKey: config.apiKey,
      defaultVoice: config.defaultVoice ?? 'nova',
      model: config.model ?? 'tts-1',
      timeoutMs: config.timeoutMs ?? 15_000,
    };
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const voice = (options.voiceId as OpenAIVoice | undefined) ?? this.config.defaultVoice;
    const format = options.format ?? 'mp3';

    // OpenAI accepts: mp3, opus, aac, flac, wav, pcm
    const responseFormat = format === 'pcm' ? 'pcm' : format === 'wav' ? 'wav' : 'mp3';

    const start = Date.now();

    const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
        voice,
        response_format: responseFormat,
        speed: options.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI TTS error ${res.status}: ${body}`);
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());

    return {
      audio: audioBuffer,
      format: responseFormat as TTSResult['format'],
      durationMs: Date.now() - start,
    };
  }

  async listVoices(): Promise<string[]> {
    // OpenAI voices are static — no discovery endpoint needed.
    return [...AVAILABLE_VOICES];
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Lightweight models endpoint as a proxy health check
      const res = await fetch(`${OPENAI_BASE}/models/tts-1`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

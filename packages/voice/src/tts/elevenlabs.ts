/**
 * ElevenLabs TTS integration.
 * Uses the ElevenLabs v1 text-to-speech API.
 * Endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 */

import type { TTSEngine, TTSOptions, TTSResult } from './engine.js';

export interface ElevenLabsConfig {
  apiKey: string;
  /** Default voice ID. ElevenLabs-assigned voice identifier. */
  defaultVoiceId?: string;
  /** Model ID. Default: 'eleven_turbo_v2' */
  modelId?: string;
  /** Request timeout in milliseconds. Default: 15_000 */
  timeoutMs?: number;
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
}

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // ElevenLabs "Rachel" — clear, neutral

export class ElevenLabsTTS implements TTSEngine {
  readonly name = 'elevenlabs';

  private readonly config: Required<ElevenLabsConfig>;

  constructor(config: ElevenLabsConfig) {
    this.config = {
      apiKey: config.apiKey,
      defaultVoiceId: config.defaultVoiceId ?? DEFAULT_VOICE,
      modelId: config.modelId ?? 'eleven_turbo_v2',
      timeoutMs: config.timeoutMs ?? 15_000,
    };
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const voiceId = options.voiceId ?? this.config.defaultVoiceId;
    const format = options.format ?? 'mp3';

    // ElevenLabs output format param
    const outputFormat = format === 'mp3' ? 'mp3_44100_128' : 'pcm_22050';

    const start = Date.now();

    const res = await fetch(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=${outputFormat}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: this.config.modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: options.speed ?? 1.0,
          },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs error ${res.status}: ${body}`);
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());

    return {
      audio: audioBuffer,
      format: format === 'mp3' ? 'mp3' : 'pcm',
      durationMs: Date.now() - start,
    };
  }

  async listVoices(): Promise<string[]> {
    const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
      headers: { 'xi-api-key': this.config.apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs voices error ${res.status}`);
    }

    const data = (await res.json()) as { voices: ElevenLabsVoice[] };
    return data.voices.map((v) => v.voice_id);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${ELEVENLABS_BASE}/user`, {
        headers: { 'xi-api-key': this.config.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

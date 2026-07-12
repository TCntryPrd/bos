/**
 * faster-whisper STT integration.
 * Calls the STT service container running on port 8002.
 * Endpoint: POST http://localhost:8002/transcribe
 * Body: multipart/form-data with `file` (audio) and optional `language` / `prompt`.
 */

import type { STTEngine, STTOptions, STTResult } from './engine.js';

export interface WhisperSTTConfig {
  /** Base URL of the faster-whisper service. Default: http://localhost:8002 */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default: 30_000 */
  timeoutMs?: number;
  /** Whisper model to use (must be preloaded in the container). Default: 'base' */
  model?: string;
}

interface WhisperResponse {
  text: string;
  language?: string;
  segments?: Array<{
    text: string;
    start: number;
    end: number;
  }>;
}

export class WhisperSTT implements STTEngine {
  readonly name = 'faster-whisper';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly model: string;

  constructor(config: WhisperSTTConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:8002').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.model = config.model ?? 'base';
  }

  async transcribe(audio: Buffer, options: STTOptions = {}): Promise<STTResult> {
    const form = new FormData();

    // Attach audio as a file blob
    const blob = new Blob([audio], { type: 'audio/wav' });
    form.append('file', blob, 'audio.wav');
    form.append('model', this.model);

    if (options.language) {
      form.append('language', options.language);
    }
    if (options.prompt) {
      form.append('initial_prompt', options.prompt);
    }

    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`faster-whisper error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as WhisperResponse;

    return {
      text: data.text.trim(),
      language: data.language,
      durationMs: Date.now() - start,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

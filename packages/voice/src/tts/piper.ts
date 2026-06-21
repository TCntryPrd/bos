/**
 * Piper local TTS integration.
 * Piper is a fast, offline, neural TTS engine.
 * Runs as a subprocess: echo "text" | piper --model <model> --output-raw
 * Or via an optional HTTP wrapper on configurable port.
 *
 * Output: raw 16-bit PCM at 22050 Hz (model-dependent).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TTSEngine, TTSOptions, TTSResult } from './engine.js';

const execFileAsync = promisify(execFile);

export type PiperMode = 'subprocess' | 'http';

export interface PiperConfig {
  mode?: PiperMode;
  /** Absolute path to piper binary. Only used in 'subprocess' mode. Default: 'piper' (on PATH) */
  binaryPath?: string;
  /** Path to the .onnx voice model. Required in 'subprocess' mode. */
  modelPath?: string;
  /** Base URL of the Piper HTTP server. Only used in 'http' mode. Default: http://localhost:5500 */
  baseUrl?: string;
  /** Timeout in milliseconds. Default: 15_000 */
  timeoutMs?: number;
  /** Sample rate of the output PCM. Default: 22050 */
  sampleRate?: number;
}

interface PiperHttpResponse {
  audio: string; // base64-encoded PCM
}

export class PiperTTS implements TTSEngine {
  readonly name = 'piper';

  private readonly config: Required<PiperConfig>;

  constructor(config: PiperConfig = {}) {
    this.config = {
      mode: config.mode ?? 'subprocess',
      binaryPath: config.binaryPath ?? 'piper',
      modelPath: config.modelPath ?? '',
      baseUrl: (config.baseUrl ?? 'http://localhost:5500').replace(/\/$/, ''),
      timeoutMs: config.timeoutMs ?? 15_000,
      sampleRate: config.sampleRate ?? 22050,
    };
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const start = Date.now();

    if (this.config.mode === 'http') {
      return this.synthesizeHttp(text, options, start);
    }

    return this.synthesizeSubprocess(text, start);
  }

  async listVoices(): Promise<string[]> {
    if (this.config.mode === 'subprocess') {
      // Return the configured model path as the only "voice" in subprocess mode.
      return this.config.modelPath ? [this.config.modelPath] : [];
    }

    try {
      const res = await fetch(`${this.config.baseUrl}/voices`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { voices: string[] };
      return data.voices ?? [];
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    if (this.config.mode === 'subprocess') {
      try {
        await execFileAsync(this.config.binaryPath, ['--version'], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    }

    try {
      const res = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Subprocess mode ───────────────────────────────────────

  private async synthesizeSubprocess(text: string, start: number): Promise<TTSResult> {
    if (!this.config.modelPath) {
      throw new Error('Piper subprocess mode requires a modelPath');
    }

    const args = ['--model', this.config.modelPath, '--output-raw'];

    const { execFile: execRaw } = await import('node:child_process');

    const audio = await new Promise<Buffer>((resolve, reject) => {
      const proc = execRaw(
        this.config.binaryPath,
        args,
        { timeout: this.config.timeoutMs, encoding: 'buffer' },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout as unknown as Buffer);
        },
      );

      if (proc.stdin) {
        proc.stdin.write(text);
        proc.stdin.end();
      }
    });

    return {
      audio,
      format: 'pcm',
      durationMs: Date.now() - start,
    };
  }

  // ── HTTP mode ─────────────────────────────────────────────

  private async synthesizeHttp(
    text: string,
    options: TTSOptions,
    start: number,
  ): Promise<TTSResult> {
    const res = await fetch(`${this.config.baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: options.voiceId,
        speed: options.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Piper HTTP error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as PiperHttpResponse;
    const audio = Buffer.from(data.audio, 'base64');

    return {
      audio,
      format: 'pcm',
      durationMs: Date.now() - start,
    };
  }
}

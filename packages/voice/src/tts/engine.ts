/**
 * TTS abstraction interface.
 * All TTS implementations satisfy this contract.
 */

export interface TTSOptions {
  /** Voice ID or name, specific to the provider. */
  voiceId?: string;
  /** Speaking rate multiplier. 1.0 = normal. */
  speed?: number;
  /** Output audio format. Default: 'wav' */
  format?: 'wav' | 'mp3' | 'opus' | 'pcm';
}

export interface TTSResult {
  /** Raw audio bytes in the requested format. */
  audio: Buffer;
  /** Format of the returned audio data. */
  format: 'wav' | 'mp3' | 'opus' | 'pcm';
  durationMs?: number;
}

export interface TTSEngine {
  readonly name: string;

  /**
   * Synthesize text to audio.
   * @param text - Plain text to synthesize (no SSML required)
   * @param options - Voice and format options
   */
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;

  /** List available voice IDs from this provider. */
  listVoices(): Promise<string[]>;

  /** Check whether the TTS backend is reachable and functional. */
  healthCheck(): Promise<boolean>;
}

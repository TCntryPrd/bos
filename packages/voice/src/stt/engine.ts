/**
 * STT abstraction interface.
 * All STT implementations satisfy this contract.
 */

export interface STTResult {
  text: string;
  language?: string;
  /** Confidence score 0-1, where available. */
  confidence?: number;
  durationMs?: number;
}

export interface STTOptions {
  language?: string;
  /** Hint text to improve transcription accuracy. */
  prompt?: string;
}

export interface STTEngine {
  readonly name: string;

  /**
   * Transcribe raw audio bytes to text.
   * @param audio - Raw PCM or encoded audio buffer (WAV/FLAC/WebM)
   * @param options - Optional transcription hints
   */
  transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult>;

  /** Check whether the STT backend is reachable and functional. */
  healthCheck(): Promise<boolean>;
}

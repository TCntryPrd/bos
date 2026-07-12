// @boss/voice — Voice pipeline, STT, TTS, device management

// Server
export { VoiceServer } from './server.js';
export type { VoiceServerConfig } from './server.js';

// Device registry
export { DeviceRegistry } from './devices.js';
export type { VoiceDevice, DeviceStatus, DeviceRegistration } from './devices.js';

// STT
export type { STTEngine, STTResult, STTOptions } from './stt/engine.js';
export { WhisperSTT } from './stt/whisper.js';
export type { WhisperSTTConfig } from './stt/whisper.js';

// TTS
export type { TTSEngine, TTSResult, TTSOptions } from './tts/engine.js';
export { ElevenLabsTTS } from './tts/elevenlabs.js';
export type { ElevenLabsConfig } from './tts/elevenlabs.js';
export { OpenAITTS } from './tts/openai-tts.js';
export type { OpenAITTSConfig, OpenAIVoice } from './tts/openai-tts.js';
export { PiperTTS } from './tts/piper.js';
export type { PiperConfig, PiperMode } from './tts/piper.js';

// Pipeline
export { VoicePipeline } from './pipeline.js';
export type {
  VoiceRequest,
  VoiceResponse,
  PipelineConfig,
  PipelineBrainAdapter,
  PipelineBrainRequest,
  PipelineBrainResponse,
} from './pipeline.js';

// Room context
export {
  buildRoomContext,
  buildHints,
  formatContextForPrompt,
  isRoomScoped,
} from './context.js';
export type { RoomContext } from './context.js';

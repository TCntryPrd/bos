/**
 * Default app configuration constants.
 * Server URL and other runtime config is stored in SecureStore and
 * overrides these defaults.
 */

export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_WS_URL = 'ws://localhost:3000';

export const API_TIMEOUT_MS = 10_000;
export const VOICE_WS_RECONNECT_DELAY_MS = 3_000;
export const HEALTH_POLL_INTERVAL_MS = 30_000;
export const ACTIVITY_POLL_INTERVAL_MS = 15_000;

export const STORAGE_KEYS = {
  API_URL: 'boss.api_url',
  AUTH_TOKEN: 'boss.auth_token',
  USER_ID: 'boss.user_id',
  TENANT_ID: 'boss.tenant_id',
  TTS_VOICE: 'boss.tts_voice',
  PUSH_ENABLED: 'boss.push_enabled',
  ALWAYS_LISTEN: 'boss.always_listen',
} as const;

export const TTS_VOICES = [
  { id: 'elevenlabs_rachel', label: 'Rachel (ElevenLabs)', provider: 'elevenlabs' },
  { id: 'elevenlabs_adam', label: 'Adam (ElevenLabs)', provider: 'elevenlabs' },
  { id: 'openai_alloy', label: 'Alloy (OpenAI)', provider: 'openai' },
  { id: 'openai_nova', label: 'Nova (OpenAI)', provider: 'openai' },
  { id: 'piper_en_us', label: 'Piper US English (Local)', provider: 'piper' },
] as const;

export type TtsVoiceId = typeof TTS_VOICES[number]['id'];

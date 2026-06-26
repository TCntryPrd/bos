/**
 * TTS tools — Google Cloud Text-to-Speech for BOS voice output.
 * Uses the same GEMINI_API_KEY (Google API key).
 */

import type { BrainTool } from '@boss/brain';

export const ttsSpeakTool: BrainTool = {
  name: 'boss_tts_speak',
  description:
    'Convert text to speech audio. Returns base64-encoded audio that can be played in the browser. ' +
    'Use when Kevin asks BOS to read something aloud or when voice output is requested.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to speak' },
      voice: {
        type: 'string',
        description: 'Voice name (default: en-US-Wavenet-J). Options: en-US-Wavenet-J (male), en-US-Neural2-F (female), en-US-Studio-M (studio male), en-US-Studio-O (studio female)',
      },
      speed: { type: 'number', description: 'Speaking rate 0.25-4.0 (default: 1.0)' },
    },
    required: ['text'],
  },
};

export const ALL_TTS_TOOLS: BrainTool[] = [ttsSpeakTool];

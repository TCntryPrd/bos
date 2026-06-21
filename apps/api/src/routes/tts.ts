/**
 * TTS routes — /api/tts/*
 *
 *   POST /synthesize — convert text to speech, returns audio
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface SynthesizeBody {
  text: string;
  voice?: string;
  speed?: number;
}

export async function ttsRoutes(server: FastifyInstance) {
  server.post<{ Body: SynthesizeBody }>(
    '/synthesize',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', maxLength: 5000 },
            voice: { type: 'string' },
            speed: { type: 'number', minimum: 0.25, maximum: 4.0 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SynthesizeBody }>, reply: FastifyReply) => {
      const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return reply.status(503).send({ error: 'Google API key not configured' });
      }

      const { text, voice = 'en-US-Wavenet-J', speed = 1.0 } = request.body;

      // Google Cloud TTS API
      const ttsBody = {
        input: { text },
        voice: {
          languageCode: 'en-US',
          name: voice,
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: speed,
          pitch: 0,
        },
      };

      try {
        const res = await fetch(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ttsBody),
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (!res.ok) {
          const errText = await res.text();
          request.log.error({ status: res.status, error: errText.substring(0, 300) }, 'TTS API error');
          return reply.status(res.status).send({
            error: 'TTS synthesis failed',
            message: errText.substring(0, 300),
          });
        }

        const data = await res.json() as { audioContent: string };

        // Return base64 audio
        return reply.status(200).send({
          audio: data.audioContent,
          format: 'mp3',
          voice,
          textLength: text.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, 'TTS error');
        return reply.status(502).send({ error: 'TTS error', message: msg });
      }
    },
  );
}

/**
 * Google Gemini image generation tool definitions for BOS brain tool calling.
 *
 * These BrainTool descriptors let the brain generate images from text prompts,
 * edit existing images with natural language instructions, and describe image
 * contents using Gemini's vision capability.
 * Execution logic lives in executor.ts.
 *
 * Tools are only registered when GEMINI_API_KEY is present in the environment.
 *
 * API base: https://generativelanguage.googleapis.com/v1beta
 * Auth header: x-goog-api-key: <api-key>
 * Get a key at: aistudio.google.com — click "Get API key"
 */

import type { BrainTool } from '@boss/brain';

// ── Image generation ──────────────────────────────────────────────────────────

export const imageGenerateTool: BrainTool = {
  name: 'boss_image_generate',
  description:
    'Generate an image from a text prompt using Google Gemini. Returns the generated image as base64 data that the frontend can render directly. Supports optional style and aspect ratio hints.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Text description of the image to generate. Be specific — include subject, setting, lighting, mood, and any important details.',
      },
      style: {
        type: 'string',
        enum: ['photo', 'illustration', 'painting', '3d'],
        description:
          'Optional visual style. "photo" = photorealistic, "illustration" = digital art / flat design, "painting" = traditional or fine-art style, "3d" = rendered 3-D scene. Omit to let the model decide.',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3'],
        description:
          'Optional aspect ratio hint appended to the prompt. "1:1" = square, "16:9" = landscape widescreen, "9:16" = portrait / mobile, "4:3" = standard screen. Omit for default (square).',
      },
    },
    required: ['prompt'],
  },
};

// ── Image editing ─────────────────────────────────────────────────────────────

export const imageEditTool: BrainTool = {
  name: 'boss_image_edit',
  description:
    'Edit an existing image using a natural language instruction. Provide the image as a URL or base64 string together with an instruction such as "remove the background", "change the sky to sunset", or "add a hat to the person". Returns the edited image as base64 data.',
  parameters: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description:
          'Natural language editing instruction describing what to change in the image.',
      },
      image_url: {
        type: 'string',
        description:
          'URL of the source image to edit. Provide either image_url or image_base64, not both.',
      },
      image_base64: {
        type: 'string',
        description:
          'Raw base64-encoded image data (no data URI prefix). Provide either image_url or image_base64, not both.',
      },
    },
    required: ['instruction'],
  },
};

// ── Image description ─────────────────────────────────────────────────────────

export const imageDescribeTool: BrainTool = {
  name: 'boss_image_describe',
  description:
    'Describe the contents of an image using Gemini vision. Returns a detailed text description. Optionally ask a specific question about the image.',
  parameters: {
    type: 'object',
    properties: {
      image_url: {
        type: 'string',
        description:
          'URL of the image to describe. Provide either image_url or image_base64, not both.',
      },
      image_base64: {
        type: 'string',
        description:
          'Raw base64-encoded image data (no data URI prefix). Provide either image_url or image_base64, not both.',
      },
      question: {
        type: 'string',
        description:
          'Optional specific question to answer about the image, e.g. "What text is visible?" or "How many people are in this photo?".',
      },
    },
    required: [],
  },
};

// ── Full export list ──────────────────────────────────────────────────────────

export const ALL_GEMINI_TOOLS: BrainTool[] = [
  imageGenerateTool,
  imageEditTool,
  imageDescribeTool,
];

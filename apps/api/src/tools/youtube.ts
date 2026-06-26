/**
 * YouTube tools — search videos and pull transcripts.
 *
 * Uses YouTube Data API v3 for search and a free transcript extraction
 * approach (no API key needed for transcripts — uses the public innertube endpoint).
 *
 * Gated on YOUTUBE_API_KEY env var for search. Transcripts are free.
 */

import type { BrainTool } from '@boss/brain';

export const youtubeSearchTool: BrainTool = {
  name: 'boss_youtube_search',
  description:
    'Search YouTube for videos. Returns titles, channel names, view counts, and video IDs. ' +
    'Use this to find relevant content, tutorials, talks, or any video topic.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g., "AI automation for small business")' },
      max_results: { type: 'number', description: 'Number of results (1-20, default 5)' },
    },
    required: ['query'],
  },
};

export const youtubeTranscriptTool: BrainTool = {
  name: 'boss_youtube_transcript',
  description:
    'Get the transcript/captions of a YouTube video. Returns the full text of what was said. ' +
    'Use after searching to read a video\'s content without watching it. Provide a video ID or full URL.',
  parameters: {
    type: 'object',
    properties: {
      video_id: {
        type: 'string',
        description: 'YouTube video ID (e.g., "dQw4w9WgXcQ") or full URL',
      },
    },
    required: ['video_id'],
  },
};

export const ALL_YOUTUBE_TOOLS: BrainTool[] = [
  youtubeSearchTool,
  youtubeTranscriptTool,
];

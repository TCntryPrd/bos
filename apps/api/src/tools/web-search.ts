/**
 * Web search tool definitions for BOS brain.
 * Uses DuckDuckGo instant answers (free, no API key) + optional Google Custom Search.
 */

import type { BrainTool } from '@boss/brain';

export const webSearchTool: BrainTool = {
  name: 'boss_web_search',
  description:
    'Search the web for current information. Returns search results with titles, URLs, and snippets.\n\n' +
    'Use this when you need:\n' +
    '- Current news or events\n' +
    '- Information about companies, people, or products\n' +
    '- Technical documentation or tutorials\n' +
    '- Prices, availability, or market data\n' +
    '- Anything not in your training data or local knowledge',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string.' },
      max_results: { type: 'number', description: 'Max results to return (default: 5, max: 10).' },
    },
    required: ['query'],
  },
};

export const webFetchTool: BrainTool = {
  name: 'boss_web_fetch',
  description:
    'Fetch and extract text content from a URL. Returns the readable text from a web page.\n\n' +
    'Use this to read articles, documentation, or any web page content.\n' +
    'Returns plain text (HTML tags stripped). Limited to 15,000 characters.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to fetch (must start with http:// or https://).' },
    },
    required: ['url'],
  },
};

export const ALL_WEB_TOOLS: BrainTool[] = [webSearchTool, webFetchTool];

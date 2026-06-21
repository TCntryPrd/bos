/**
 * Notion tool definitions for BOS brain tool calling.
 *
 * Covers search, page retrieval, page creation, and database listing.
 * Execution logic lives in executor.ts.
 *
 * Auth: Bearer token via NOTION_API_KEY environment variable.
 * API version: 2022-06-28
 */

import type { BrainTool } from '@boss/brain';

// ── Search ────────────────────────────────────────────────────────────────────

export const notionSearchTool: BrainTool = {
  name: 'boss_notion_search',
  description:
    'Search Notion pages and databases by title or content. Returns matching pages and databases with their titles, types, and links.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for across Notion pages and databases.',
      },
      filter_type: {
        type: 'string',
        description:
          'Restrict results to "page" or "database". Omit to search both.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (1–50). Defaults to 10.',
      },
    },
    required: ['query'],
  },
};

// ── Get page ──────────────────────────────────────────────────────────────────

export const notionGetPageTool: BrainTool = {
  name: 'boss_notion_get_page',
  description:
    "Get a Notion page's full content. Retrieves the page's title, properties, and all block content (text, headings, bullets, to-dos, etc.).",
  parameters: {
    type: 'object',
    properties: {
      page_id: {
        type: 'string',
        description:
          'The Notion page ID. Accepts the full UUID (with or without dashes) or the page URL.',
      },
    },
    required: ['page_id'],
  },
};

// ── Create page ───────────────────────────────────────────────────────────────

export const notionCreatePageTool: BrainTool = {
  name: 'boss_notion_create_page',
  description:
    'Create a new page in a Notion database. Returns the created page ID and link.',
  parameters: {
    type: 'object',
    properties: {
      database_id: {
        type: 'string',
        description:
          'The ID of the Notion database to create the page in. Use boss_notion_list_databases to find available database IDs.',
      },
      title: {
        type: 'string',
        description: 'Title of the new page.',
      },
      content: {
        type: 'string',
        description:
          'Optional plain-text content to add as the page body. Written as a single paragraph block.',
      },
      properties: {
        type: 'object',
        description:
          'Optional additional database property values as key-value pairs. Values must be plain strings. Example: {"Status": "In Progress", "Priority": "High"}.',
      },
    },
    required: ['database_id', 'title'],
  },
};

// ── List databases ────────────────────────────────────────────────────────────

export const notionListDatabasesTool: BrainTool = {
  name: 'boss_notion_list_databases',
  description:
    'List all Notion databases accessible to the integration. Returns each database name, its ID, and a link. Use the ID with boss_notion_create_page or boss_notion_search.',
  parameters: {
    type: 'object',
    properties: {
      max_results: {
        type: 'number',
        description: 'Maximum number of databases to return (1–50). Defaults to 25.',
      },
    },
    required: [],
  },
};

// ── Exports ───────────────────────────────────────────────────────────────────

export const READONLY_NOTION_TOOLS: BrainTool[] = [
  notionSearchTool,
  notionGetPageTool,
  notionListDatabasesTool,
];

export const WRITE_NOTION_TOOLS: BrainTool[] = [
  notionCreatePageTool,
];

export const ALL_NOTION_TOOLS: BrainTool[] = [
  ...READONLY_NOTION_TOOLS,
  ...WRITE_NOTION_TOOLS,
];

/**
 * Memory tools — let BOS save and recall learnings, preferences, and facts.
 */

import type { BrainTool } from '@boss/brain';

export const memorySaveTool: BrainTool = {
  name: 'boss_memory_save',
  description:
    'Save something to long-term memory. Use when you learn something about Kevin, his preferences, ' +
    'processes, contacts, or important facts that should be remembered across conversations.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['preference', 'pattern', 'fact', 'contact', 'process', 'correction'],
        description: 'Type of memory: preference (Kevin likes/wants), pattern (recurring behavior), fact (business info), contact (person details), process (how things work), correction (Kevin corrected me)',
      },
      content: { type: 'string', description: 'What to remember. Be specific and concise.' },
      confidence: { type: 'number', description: 'How confident (0.0-1.0). Default 0.8. Use 0.9+ for explicit statements.' },
    },
    required: ['category', 'content'],
  },
};

export const memoryRecallTool: BrainTool = {
  name: 'boss_memory_recall',
  description:
    'Search long-term memory for relevant information. Use before answering questions about Kevin\'s ' +
    'preferences, contacts, processes, or past corrections.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for in memory' },
      category: {
        type: 'string',
        enum: ['preference', 'pattern', 'fact', 'contact', 'process', 'correction'],
        description: 'Optional: filter by category',
      },
      limit: { type: 'number', description: 'Max results (default: 10)' },
    },
    required: ['query'],
  },
};

export const memoryListTool: BrainTool = {
  name: 'boss_memory_list',
  description: 'List all memories, optionally filtered by category. Use to review what BOS has learned.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['preference', 'pattern', 'fact', 'contact', 'process', 'correction'],
      },
      limit: { type: 'number', description: 'Max results (default: 20)' },
    },
    required: [],
  },
};

export const ALL_MEMORY_TOOLS: BrainTool[] = [
  memorySaveTool,
  memoryRecallTool,
  memoryListTool,
];

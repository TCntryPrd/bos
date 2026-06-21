/**
 * Telegram tool definitions for BOS brain tool calling.
 *
 * Covers retrieving updates, sending messages, and listing recent chats.
 * Execution logic lives in executor.ts.
 *
 * Auth: TELEGRAM_BOT_TOKEN env var
 * API base: https://api.telegram.org/bot<token>/
 */

import type { BrainTool } from '@boss/brain';

// ── Update / inbox tools ──────────────────────────────────────────────────────

export const telegramGetUpdatesTool: BrainTool = {
  name: 'boss_telegram_get_updates',
  description:
    'Get recent messages and updates received by the Telegram bot. Returns message text, sender name, chat title, and timestamp.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of updates to retrieve (1–100). Defaults to 20.',
      },
      offset: {
        type: 'number',
        description:
          'Update ID offset — only return updates with ID greater than this value. Use to page through updates.',
      },
    },
    required: [],
  },
};

export const telegramListChatsTool: BrainTool = {
  name: 'boss_telegram_list_chats',
  description:
    'List recent chats (users and groups) the Telegram bot has received messages from. Returns chat IDs, names, and types.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of distinct chats to return (1–50). Defaults to 20.',
      },
    },
    required: [],
  },
};

// ── Messaging tools ───────────────────────────────────────────────────────────

export const telegramSendMessageTool: BrainTool = {
  name: 'boss_telegram_send_message',
  description:
    'Send a message via the Telegram bot to a specific chat. Returns confirmation with the message ID.',
  parameters: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description:
          'Telegram chat ID (numeric string, e.g. "123456789") or @username for public channels.',
      },
      text: {
        type: 'string',
        description: 'The message text to send. Supports Markdown formatting.',
      },
      parse_mode: {
        type: 'string',
        description: 'Text formatting mode: "Markdown", "MarkdownV2", or "HTML". Defaults to plain text.',
      },
    },
    required: ['chat_id', 'text'],
  },
};

export const telegramSendAndWaitTool: BrainTool = {
  name: 'boss_telegram_send_and_wait',
  description:
    'Send a Telegram message and wait for the recipient to reply. Polls for up to 120 seconds.\n' +
    'Use this for approval flows — send a request and wait for the user to respond.\n' +
    'Returns the reply text when received, or a timeout message if no reply.\n\n' +
    'Kevin\'s chat ID: check boss_telegram_list_chats or use the admin chat ID from config.',
  parameters: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: 'Telegram chat ID to send to.' },
      text: { type: 'string', description: 'Message text to send.' },
      wait_seconds: { type: 'number', description: 'How long to wait for reply (default: 60, max: 120).' },
    },
    required: ['chat_id', 'text'],
  },
};

// ── Export lists ──────────────────────────────────────────────────────────────

export const READONLY_TELEGRAM_TOOLS: BrainTool[] = [
  telegramGetUpdatesTool,
  telegramListChatsTool,
];

export const WRITE_TELEGRAM_TOOLS: BrainTool[] = [
  telegramSendMessageTool,
  telegramSendAndWaitTool,
];

export const ALL_TELEGRAM_TOOLS: BrainTool[] = [...READONLY_TELEGRAM_TOOLS, ...WRITE_TELEGRAM_TOOLS];

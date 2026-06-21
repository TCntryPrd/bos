/**
 * Slack tool definitions for BOS brain tool calling.
 *
 * Covers channel listing, message reading, sending, and workspace search.
 * Execution logic lives in executor.ts.
 *
 * Auth: SLACK_BOT_TOKEN env var (xoxb-...)
 * API base: https://slack.com/api/
 */

import type { BrainTool } from '@boss/brain';

// ── Channel tools ─────────────────────────────────────────────────────────────

export const slackListChannelsTool: BrainTool = {
  name: 'boss_slack_list_channels',
  description:
    'List the Slack channels the bot is a member of. Returns channel names, IDs, member counts, and topic for each.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of channels to return (1–200). Defaults to 50.',
      },
    },
    required: [],
  },
};

export const slackReadChannelTool: BrainTool = {
  name: 'boss_slack_read_channel',
  description:
    'Read recent messages from a Slack channel. Returns message text, author, and timestamp for each message.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Channel ID (e.g. "C1234567890") or channel name (e.g. "#general"). Channel ID is preferred.',
      },
      limit: {
        type: 'number',
        description: 'Number of recent messages to retrieve (1–100). Defaults to 20.',
      },
    },
    required: ['channel'],
  },
};

// ── Messaging tools ───────────────────────────────────────────────────────────

export const slackSendMessageTool: BrainTool = {
  name: 'boss_slack_send_message',
  description:
    'Send a message to a Slack channel or DM. Returns confirmation with the message timestamp.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Channel ID, channel name (e.g. "#general"), or user ID for a DM.',
      },
      text: {
        type: 'string',
        description: 'The message text to send. Supports Slack mrkdwn formatting.',
      },
    },
    required: ['channel', 'text'],
  },
};

// ── Search ────────────────────────────────────────────────────────────────────

export const slackSearchTool: BrainTool = {
  name: 'boss_slack_search',
  description:
    'Search messages across the Slack workspace. Returns matching messages with author, channel, timestamp, and text.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query string. Supports Slack search modifiers, e.g. "in:#general from:@alice budget".',
      },
      count: {
        type: 'number',
        description: 'Maximum number of results to return (1–100). Defaults to 20.',
      },
    },
    required: ['query'],
  },
};

// ── Export lists ──────────────────────────────────────────────────────────────

export const READONLY_SLACK_TOOLS: BrainTool[] = [
  slackListChannelsTool,
  slackReadChannelTool,
  slackSearchTool,
];

export const WRITE_SLACK_TOOLS: BrainTool[] = [
  slackSendMessageTool,
];

export const ALL_SLACK_TOOLS: BrainTool[] = [...READONLY_SLACK_TOOLS, ...WRITE_SLACK_TOOLS];

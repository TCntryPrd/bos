/**
 * Agent spawn tools — brain tool definitions for boss_spawn_agent
 * and boss_spawn_parallel.
 *
 * These tools are always available (no API key gate). They let the main brain
 * delegate independent subtasks to isolated sub-agent instances.
 */

import type { BrainTool } from '@boss/brain';

export const spawnAgentTool: BrainTool = {
  name: 'boss_spawn_agent',
  description:
    'Spawn a sub-agent to handle a specific task in parallel. Use when a task can be broken ' +
    'into independent subtasks. Each agent gets its own tool set and context. ' +
    'Returns the agent result when complete.',
  parameters: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['researcher', 'executor', 'analyst', 'writer'],
        description:
          'The agent role. researcher = gather info, executor = take actions, ' +
          'analyst = read and interpret data, writer = produce written output or create records.',
      },
      task: {
        type: 'string',
        description: 'Clear description of what the agent should do.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of tool names the agent can use. Keep it minimal — agents work better with ' +
          'focused tool sets. If omitted, role-appropriate defaults are used.',
      },
    },
    required: ['role', 'task'],
  },
};

export const spawnParallelAgentsTool: BrainTool = {
  name: 'boss_spawn_parallel',
  description:
    'Spawn multiple sub-agents to run in parallel. Use for multi-source queries or independent ' +
    'subtasks. Returns all results when all agents complete.',
  parameters: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        description: 'List of agent definitions to run in parallel.',
        items: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: ['researcher', 'executor', 'analyst', 'writer'],
            },
            task: {
              type: 'string',
              description: 'What this specific agent should do.',
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Tool whitelist for this agent. If omitted, role-appropriate defaults are used.',
            },
          },
          required: ['role', 'task'],
        },
      },
    },
    required: ['agents'],
  },
};

export const ALL_AGENT_TOOLS: BrainTool[] = [spawnAgentTool, spawnParallelAgentsTool];

/**
 * Persistent agent management tools.
 * Lets BOS create, list, update, pause, resume, and delete
 * long-running agents that execute on cron schedules.
 */

import type { BrainTool } from '@boss/brain';

export const createAgentTool: BrainTool = {
  name: 'boss_create_persistent_agent',
  description:
    'Create a persistent agent — a mini clone of yourself that runs on a cron schedule.\n' +
    'The agent gets instructions and runs them on every heartbeat. It stays alive until stopped.\n\n' +
    'Cron examples: "*/15 * * * *" (every 15 min), "0 */4 * * *" (every 4h), "0 8 * * *" (daily 8am UTC)',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name (descriptive).' },
      instructions: { type: 'string', description: 'What the agent should do on each run. Be specific.' },
      cron_expression: { type: 'string', description: 'Cron schedule. Default: every 4 hours.' },
    },
    required: ['name', 'instructions'],
  },
};

export const listAgentsTool: BrainTool = {
  name: 'boss_list_persistent_agents',
  description: 'List all persistent agents with their status, schedule, and last run info.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const updateAgentTool: BrainTool = {
  name: 'boss_update_persistent_agent',
  description: 'Update a persistent agent — change instructions, schedule, or status (active/paused/stopped).',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID.' },
      instructions: { type: 'string', description: 'New instructions (optional).' },
      cron_expression: { type: 'string', description: 'New cron schedule (optional).' },
      status: { type: 'string', description: 'Set to active, paused, or stopped.' },
    },
    required: ['agent_id'],
  },
};

export const deleteAgentTool: BrainTool = {
  name: 'boss_delete_persistent_agent',
  description: 'Permanently delete a persistent agent.',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Agent ID to delete.' },
    },
    required: ['agent_id'],
  },
};

export const employeeAgentsReportTool: BrainTool = {
  name: 'boss_employee_agents_report',
  description:
    'Get an operations + COST report on the Employee Agents (headless persistent agents like the Email and CFO agents). ' +
    "Returns each agent's status, schedule, model, last run time, run/error counts, last report summary, and cost/usage rolled up over 24h and 7d. " +
    'As the COO, use this to see what each Employee Agent is doing and what it costs, then decide whether to adjust its schedule or instructions (via boss_update_persistent_agent) — e.g. pause an erroring agent, reduce its heartbeat, or tighten its brief. Employee Agents run on Codex CLI; do not move them to Claude or other providers.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const ALL_PERSISTENT_AGENT_TOOLS: BrainTool[] = [
  createAgentTool,
  listAgentsTool,
  updateAgentTool,
  deleteAgentTool,
  employeeAgentsReportTool,
];

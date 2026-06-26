/**
 * Make.com (Integromat) tool definitions for BOS brain tool calling.
 *
 * These BrainTool descriptors let the brain list scenarios, run them,
 * inspect execution history, and get scenario details.
 * Execution logic lives in executor.ts.
 *
 * Tools are only registered when MAKE_API_KEY is present in the environment.
 *
 * API base: https://us2.make.com/api/v2/
 * Auth header: Authorization: Token <api-key>
 * Org ID: 4658230
 */

import type { BrainTool } from '@boss/brain';

// ── Make.com tools ────────────────────────────────────────────────────────────

export const makeListOrgsTool: BrainTool = {
  name: 'boss_make_list_orgs',
  description: 'List all Make.com organizations the API key has access to. Returns org ID, name, and zone.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const makeListTeamsTool: BrainTool = {
  name: 'boss_make_list_teams',
  description: 'List teams in a Make.com organization. Default org: D Caine Solutions LLC (4658230).',
  parameters: {
    type: 'object',
    properties: {
      organization_id: { type: 'number', description: 'Organization ID (default: 4658230).' },
    },
    required: [],
  },
};

export const makeListScenariosTool: BrainTool = {
  name: 'boss_make_list_scenarios',
  description:
    'List all Make.com scenarios in the organization with their active/inactive status. Returns scenario name, ID, whether it is currently active, and the team it belongs to. Use this to discover available automations before running one.',
  parameters: {
    type: 'object',
    properties: {
      active_only: {
        type: 'boolean',
        description: 'If true, only return active (enabled) scenarios. Defaults to false (return all).',
      },
    },
    required: [],
  },
};

export const makeRunScenarioTool: BrainTool = {
  name: 'boss_make_run_scenario',
  description:
    'Trigger an immediate run of a Make.com scenario by its ID. Returns confirmation and the execution ID. The scenario must be active or runnable on demand.',
  parameters: {
    type: 'object',
    properties: {
      scenario_id: {
        type: 'number',
        description: 'The Make.com scenario ID to run. Use boss_make_list_scenarios to find IDs.',
      },
    },
    required: ['scenario_id'],
  },
};

export const makeRecentExecutionsTool: BrainTool = {
  name: 'boss_make_recent_executions',
  description:
    'Get recent execution history for Make.com scenarios. Returns execution status (success/error/running), start time, duration, and which scenario ran. Useful for checking if automations completed successfully.',
  parameters: {
    type: 'object',
    properties: {
      scenario_id: {
        type: 'number',
        description: 'Optional scenario ID to filter executions to a specific scenario. Omit to return executions across all scenarios.',
      },
      limit: {
        type: 'number',
        description: 'Number of recent executions to return (1–100). Defaults to 20.',
      },
    },
    required: [],
  },
};

export const makeGetScenarioTool: BrainTool = {
  name: 'boss_make_get_scenario',
  description:
    'Get detailed information about a specific Make.com scenario by its ID. Returns the scenario name, description, active status, scheduling information, last run time, and module/app list.',
  parameters: {
    type: 'object',
    properties: {
      scenario_id: {
        type: 'number',
        description: 'The Make.com scenario ID to retrieve. Use boss_make_list_scenarios to find IDs.',
      },
    },
    required: ['scenario_id'],
  },
};

export const makeActivateScenarioTool: BrainTool = {
  name: 'boss_make_activate',
  description:
    'Activate (start) a Make.com scenario so it runs on its configured schedule. ' +
    'Use POST /api/v2/scenarios/{id}/start — NOT /activate (which returns 404).',
  parameters: {
    type: 'object',
    properties: {
      scenario_id: { type: 'number', description: 'Scenario ID to activate.' },
    },
    required: ['scenario_id'],
  },
};

export const makeDeactivateScenarioTool: BrainTool = {
  name: 'boss_make_deactivate',
  description:
    'Deactivate (stop) a Make.com scenario. It will no longer run on schedule but can still be triggered manually.',
  parameters: {
    type: 'object',
    properties: {
      scenario_id: { type: 'number', description: 'Scenario ID to deactivate.' },
    },
    required: ['scenario_id'],
  },
};

export const makeCreateScenarioTool: BrainTool = {
  name: 'boss_make_create_scenario',
  description:
    'Create a new Make.com scenario. Provide a name, team ID (default: first team), and optional blueprint JSON. ' +
    'The blueprint must be a STRINGIFIED JSON object defining the scenario flow. ' +
    'Connection params use __IMTCONN__ prefix. Datastore IDs must be integers.\n\n' +
    'After creation, use boss_make_activate to start it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Scenario name.' },
      team_id: { type: 'number', description: 'Team ID (optional — uses default team if omitted).' },
      blueprint: { type: 'string', description: 'Stringified JSON blueprint. Optional — creates empty scenario if omitted.' },
      description: { type: 'string', description: 'Scenario description.' },
    },
    required: ['name'],
  },
};

export const makeUpdateScenarioTool: BrainTool = {
  name: 'boss_make_update_scenario',
  description:
    'Update an existing Make.com scenario. Can update name, blueprint, scheduling, or description. ' +
    'Blueprint must be STRINGIFIED JSON. PATCH returns 200 but that does NOT mean it will run — always test.\n\n' +
    'IMPORTANT: isActive and islinked are READ-ONLY. Use boss_make_activate/deactivate instead.',
  parameters: {
    type: 'object',
    properties: {
      scenario_id: { type: 'number', description: 'Scenario ID to update.' },
      name: { type: 'string', description: 'New name (optional).' },
      blueprint: { type: 'string', description: 'Stringified JSON blueprint (optional).' },
      description: { type: 'string', description: 'New description (optional).' },
      scheduling: { type: 'string', description: 'Stringified JSON scheduling config (optional).' },
    },
    required: ['scenario_id'],
  },
};

// ── Grouped exports ───────────────────────────────────────────────────────────

// All Make.com tools — gated on MAKE_API_KEY presence in index.ts
export const ALL_MAKE_TOOLS: BrainTool[] = [
  makeListOrgsTool,
  makeListTeamsTool,
  makeListScenariosTool,
  makeRunScenarioTool,
  makeRecentExecutionsTool,
  makeGetScenarioTool,
  makeActivateScenarioTool,
  makeDeactivateScenarioTool,
  makeCreateScenarioTool,
  makeUpdateScenarioTool,
];

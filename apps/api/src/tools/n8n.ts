/**
 * n8n workflow tool definitions for BOS brain tool calling.
 *
 * These BrainTool descriptors let the brain list workflows, inspect a specific
 * workflow, trigger executions, and check recent execution history.
 * Execution logic lives in executor.ts.
 *
 * Tools are only registered when N8N_API_KEY is present in the environment.
 */

import type { BrainTool } from '@boss/brain';

// ── Workflow tools ────────────────────────────────────────────────────────────

export const n8nListWorkflowsTool: BrainTool = {
  name: 'boss_n8n_list_workflows',
  description:
    'List all n8n workflows with their active/inactive status. Returns workflow name, ID, and whether it is currently enabled. Use this to discover what automations are available before triggering one.',
  parameters: {
    type: 'object',
    properties: {
      active_only: {
        type: 'boolean',
        description: 'If true, only return active (enabled) workflows. Defaults to false (return all).',
      },
    },
    required: [],
  },
};

export const n8nGetWorkflowTool: BrainTool = {
  name: 'boss_n8n_get_workflow',
  description:
    'Get detailed information about a specific n8n workflow by its ID. Returns the workflow name, description, node count, trigger type, and active status.',
  parameters: {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The n8n workflow ID to retrieve. Use boss_n8n_list_workflows to find IDs.',
      },
    },
    required: ['workflow_id'],
  },
};

export const n8nRunWorkflowTool: BrainTool = {
  name: 'boss_n8n_run_workflow',
  description:
    'Trigger an n8n workflow execution via its webhook trigger. The workflow must have an active webhook trigger node configured. Returns the execution result or confirmation that the workflow was triggered.',
  parameters: {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The n8n workflow ID to trigger.',
      },
      payload: {
        type: 'object',
        description: 'Optional JSON payload to pass to the workflow webhook trigger.',
        additionalProperties: true,
      },
    },
    required: ['workflow_id'],
  },
};

export const n8nRecentExecutionsTool: BrainTool = {
  name: 'boss_n8n_recent_executions',
  description:
    'Get recent workflow execution history from n8n. Returns execution status (success/error/running), start time, duration, and which workflow ran. Useful for checking if automations ran successfully.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of recent executions to return (1–50). Defaults to 10.',
      },
      workflow_id: {
        type: 'string',
        description: 'Optional workflow ID to filter executions to a specific workflow.',
      },
      status: {
        type: 'string',
        enum: ['success', 'error', 'running', 'waiting'],
        description: 'Optional status filter. Omit to return all statuses.',
      },
    },
    required: [],
  },
};

// ── Delegation tool ──────────────────────────────────────────────────────────

export const n8nDelegateTool: BrainTool = {
  name: 'boss_n8n_delegate',
  description:
    'Delegate a multi-source data collection job to n8n for parallel processing. ' +
    'Use this when you need to query multiple bases, APIs, or sources at once instead of making sequential tool calls. ' +
    'n8n fans out the work in parallel, writes results to a file, and returns the path. ' +
    'Then use boss_drive_read_local to read the results. ' +
    'Currently supports Airtable multi-base queries. ' +
    'PREFER this over multiple sequential boss_airtable_* calls when querying 2+ bases.',
  parameters: {
    type: 'object',
    properties: {
      job_type: {
        type: 'string',
        enum: ['airtable_full_scan'],
        description: 'The type of delegation job to run.',
      },
      sources: {
        type: 'array',
        description: 'Array of source definitions. For airtable_full_scan: [{baseId, baseName}]',
        items: {
          type: 'object',
          properties: {
            baseId: { type: 'string', description: 'Airtable base ID (e.g., appXXXX)' },
            baseName: { type: 'string', description: 'Human-readable base name' },
          },
        },
      },
    },
    required: ['job_type', 'sources'],
  },
};

export const readLocalFileTool: BrainTool = {
  name: 'boss_read_local_file',
  description:
    'Read a local file from the server filesystem. Use this to read results from n8n delegation jobs ' +
    'or any file stored on the BOS server. Returns the file contents as text.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file to read (e.g., /tmp/boss-jobs/job-123.json)',
      },
    },
    required: ['path'],
  },
};

export const n8nCreateWorkflowTool: BrainTool = {
  name: 'boss_n8n_create_workflow',
  description:
    'Create a new n8n workflow. Provide a name and an array of nodes with their connections.\n\n' +
    'Node format: each node needs { "type": "n8n-nodes-base.xxx", "name": "Node Name", "parameters": {...}, "position": [x, y] }.\n' +
    'Connections format: { "NodeName": { "main": [[{ "node": "TargetNode", "type": "main", "index": 0 }]] } }\n\n' +
    'Common node types:\n' +
    '- n8n-nodes-base.webhook (trigger)\n' +
    '- n8n-nodes-base.respondToWebhook (send response)\n' +
    '- n8n-nodes-base.code (JavaScript/Python)\n' +
    '- n8n-nodes-base.httpRequest (HTTP calls)\n' +
    '- n8n-nodes-base.set (set values)\n' +
    '- n8n-nodes-base.if (conditional)\n' +
    '- n8n-nodes-base.cron (schedule trigger)\n' +
    '- n8n-nodes-base.gmail (Gmail operations)\n' +
    '- n8n-nodes-base.telegram (Telegram operations)\n\n' +
    'Webhook nodes MUST include a webhookId (any unique string).\n\n' +
    'CREDENTIALS: When nodes need credentials, include them in the node object as:\n' +
    '  "credentials": { "gmailOAuth2": { "id": "DJ2FnS1NT6Sv2YZI", "name": "DCS Gmail" } }\n' +
    'Known credential IDs (use these EXACT values):\n' +
    '  Gmail: { "gmailOAuth2": { "id": "DJ2FnS1NT6Sv2YZI", "name": "DCS Gmail" } }\n' +
    '  Telegram: { "telegramApi": { "id": "aZCwMJQTTDzrBju7", "name": "BOS - Telegram account" } }\n' +
    '  Slack: { "slackApi": { "id": "3yHwTvrqtn1AMO8K", "name": "Slack account" } }\n' +
    '  Calendar: { "googleCalendarOAuth2Api": { "id": "f05a5mhGQOJJBybo", "name": "DCS Calendar" } }\n' +
    '  Drive: { "googleDriveOAuth2Api": { "id": "gp94gRo6fRC7TPDL", "name": "DCS Drive" } }\n' +
    '  Sheets: { "googleSheetsOAuth2Api": { "id": "1KPe8rg6gmSwg1gP", "name": "DCS Sheets" } }\n' +
    'Returns the created workflow ID and URL.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Workflow name.' },
      nodes: {
        type: 'array',
        description: 'Array of node objects.',
        items: { type: 'object', additionalProperties: true },
      },
      connections: {
        type: 'object',
        description: 'Connection map between nodes.',
        additionalProperties: true,
      },
    },
    required: ['name', 'nodes'],
  },
};

export const n8nUpdateWorkflowTool: BrainTool = {
  name: 'boss_n8n_update_workflow',
  description:
    'Update an existing n8n workflow. Uses PUT (not PATCH). Must include name, nodes, and connections.\n' +
    'IMPORTANT: Do NOT include "active" in the body — it is read-only. Use activate/deactivate tools instead.',
  parameters: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string', description: 'Workflow ID to update.' },
      name: { type: 'string', description: 'Workflow name.' },
      nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      connections: { type: 'object', additionalProperties: true },
    },
    required: ['workflow_id', 'name', 'nodes'],
  },
};

export const n8nActivateWorkflowTool: BrainTool = {
  name: 'boss_n8n_activate_workflow',
  description: 'Activate (enable) an n8n workflow so it runs on its configured trigger.',
  parameters: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string', description: 'Workflow ID to activate.' },
    },
    required: ['workflow_id'],
  },
};

export const n8nDeactivateWorkflowTool: BrainTool = {
  name: 'boss_n8n_deactivate_workflow',
  description: 'Deactivate (disable) an n8n workflow.',
  parameters: {
    type: 'object',
    properties: {
      workflow_id: { type: 'string', description: 'Workflow ID to deactivate.' },
    },
    required: ['workflow_id'],
  },
};

// ── Template Search — ALWAYS search before building from scratch ─────────────

export const n8nSearchTemplatesTool: BrainTool = {
  name: 'boss_n8n_search_templates',
  description:
    'Search the n8n official template library for existing workflows. ALWAYS use this BEFORE building a workflow from scratch — modifying a template costs 50% fewer tokens than generating from nothing. Returns template IDs, names, descriptions, and view counts.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g. "gmail slack notification", "airtable sync", "webhook to sheets").',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 10).',
      },
    },
    required: ['query'],
  },
};

export const n8nGetTemplateTool: BrainTool = {
  name: 'boss_n8n_get_template',
  description:
    'Fetch a full n8n template workflow JSON by ID. Use this after boss_n8n_search_templates finds a good match. Returns the complete workflow definition that can be imported and modified.',
  parameters: {
    type: 'object',
    properties: {
      template_id: {
        type: 'number',
        description: 'Template ID from search results.',
      },
    },
    required: ['template_id'],
  },
};

// ── Grouped exports ───────────────────────────────────────────────────────────

export const ALL_N8N_TOOLS: BrainTool[] = [
  n8nListWorkflowsTool,
  n8nGetWorkflowTool,
  n8nRunWorkflowTool,
  n8nRecentExecutionsTool,
  n8nCreateWorkflowTool,
  n8nUpdateWorkflowTool,
  n8nActivateWorkflowTool,
  n8nDeactivateWorkflowTool,
  n8nDelegateTool,
  n8nSearchTemplatesTool,
  n8nGetTemplateTool,
  readLocalFileTool,
];

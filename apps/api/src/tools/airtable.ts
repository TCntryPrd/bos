/**
 * Airtable tool definitions for BOS brain tool calling.
 *
 * Covers base listing, record listing, record creation, and field search.
 * Execution logic lives in executor.ts.
 *
 * Auth: Bearer token via AIRTABLE_API_KEY environment variable.
 * Base URL: https://api.airtable.com/v0/
 */

import type { BrainTool } from '@boss/brain';

// ── List bases ────────────────────────────────────────────────────────────────

export const airtableListBasesTool: BrainTool = {
  name: 'boss_airtable_list_bases',
  description:
    'List all Airtable bases accessible with the configured API key. Returns each base name and its ID. Use the base ID with other Airtable tools.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ── List records ──────────────────────────────────────────────────────────────

export const airtableListRecordsTool: BrainTool = {
  name: 'boss_airtable_list_records',
  description:
    'List records from an Airtable table. Returns field values for each record. Paginates automatically up to the requested limit.',
  parameters: {
    type: 'object',
    properties: {
      base_id: {
        type: 'string',
        description:
          'The Airtable base ID (starts with "app"). Use boss_airtable_list_bases to find base IDs.',
      },
      table_name: {
        type: 'string',
        description: 'The table name exactly as it appears in Airtable.',
      },
      max_records: {
        type: 'number',
        description: 'Maximum number of records to return (1–100). Defaults to 20.',
      },
      view: {
        type: 'string',
        description: 'Optional view name to filter and sort by, e.g. "Grid view" or "Active projects".',
      },
    },
    required: ['base_id', 'table_name'],
  },
};

// ── Create record ─────────────────────────────────────────────────────────────

export const airtableCreateRecordTool: BrainTool = {
  name: 'boss_airtable_create_record',
  description:
    'Create a new record in an Airtable table. Returns the created record ID and its field values.',
  parameters: {
    type: 'object',
    properties: {
      base_id: {
        type: 'string',
        description: 'The Airtable base ID (starts with "app").',
      },
      table_name: {
        type: 'string',
        description: 'The table name exactly as it appears in Airtable.',
      },
      fields: {
        type: 'object',
        description:
          'Field values for the new record as key-value pairs. Keys are field names exactly as they appear in the table. Example: {"Name": "New client", "Status": "Active", "Revenue": 5000}.',
      },
    },
    required: ['base_id', 'table_name', 'fields'],
  },
};

// ── Search records ────────────────────────────────────────────────────────────

export const airtableSearchTool: BrainTool = {
  name: 'boss_airtable_search',
  description:
    'Search Airtable records by matching a specific field value. Returns records where the field contains the search value.',
  parameters: {
    type: 'object',
    properties: {
      base_id: {
        type: 'string',
        description: 'The Airtable base ID (starts with "app").',
      },
      table_name: {
        type: 'string',
        description: 'The table name exactly as it appears in Airtable.',
      },
      field_name: {
        type: 'string',
        description: 'The name of the field to search in, e.g. "Name", "Email", or "Status".',
      },
      value: {
        type: 'string',
        description: 'The value to search for in the specified field.',
      },
      max_records: {
        type: 'number',
        description: 'Maximum number of matching records to return (1–50). Defaults to 10.',
      },
    },
    required: ['base_id', 'table_name', 'field_name', 'value'],
  },
};

export const airtableCreateBaseTool: BrainTool = {
  name: 'boss_airtable_create_base',
  description:
    'Create a new Airtable base with initial tables and fields. Requires schema.bases:write scope on the API token.\n\n' +
    'tables format: [{ "name": "Table Name", "fields": [{ "name": "Field", "type": "singleLineText" }] }]\n' +
    'Field types: singleLineText, multilineText, number, singleSelect, date, checkbox, email, url\n' +
    'For singleSelect, include options: { "name": "Field", "type": "singleSelect", "options": { "choices": [{ "name": "Option1" }, { "name": "Option2" }] } }',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Base name.' },
      workspace_id: { type: 'string', description: 'Workspace ID (optional — uses first workspace if omitted).' },
      tables: {
        type: 'array',
        description: 'Array of table definitions with name and fields.',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['name'],
  },
};

export const airtableCreateTableTool: BrainTool = {
  name: 'boss_airtable_create_table',
  description:
    'Create a new table in an existing Airtable base. The first field becomes the primary field.',
  parameters: {
    type: 'object',
    properties: {
      base_id: { type: 'string', description: 'Base ID (starts with "app").' },
      name: { type: 'string', description: 'Table name.' },
      fields: {
        type: 'array',
        description: 'Array of field definitions: [{ "name": "Field", "type": "singleLineText" }]',
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['base_id', 'name', 'fields'],
  },
};

// ── Exports ───────────────────────────────────────────────────────────────────

export const READONLY_AIRTABLE_TOOLS: BrainTool[] = [
  airtableListBasesTool,
  airtableListRecordsTool,
  airtableSearchTool,
];

export const WRITE_AIRTABLE_TOOLS: BrainTool[] = [
  airtableCreateRecordTool,
  airtableCreateBaseTool,
  airtableCreateTableTool,
];

export const ALL_AIRTABLE_TOOLS: BrainTool[] = [
  ...READONLY_AIRTABLE_TOOLS,
  ...WRITE_AIRTABLE_TOOLS,
];

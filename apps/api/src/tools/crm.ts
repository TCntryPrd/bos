/**
 * CRM (GoHighLevel) tool definitions for BOS brain.
 *
 * Provides contact search, create, update, pipeline/opportunity management,
 * and conversation tools via the GHL API.
 *
 * API docs: https://highlevel.stoplight.io/docs/integrations
 */

import type { BrainTool } from '@boss/brain';

export const crmSearchContactsTool: BrainTool = {
  name: 'boss_crm_search_contacts',
  description:
    'Search CRM contacts by name, email, phone, or company. Returns matching contacts with their details. Use this when Kevin asks about a lead, client, or person.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term — name, email, phone, or company name.' },
      limit: { type: 'number', description: 'Max results (default 10).' },
    },
    required: ['query'],
  },
};

export const crmGetContactTool: BrainTool = {
  name: 'boss_crm_get_contact',
  description:
    'Get full details for a specific CRM contact by ID. Includes name, email, phone, company, tags, custom fields, and recent activity.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID.' },
    },
    required: ['contactId'],
  },
};

export const crmCreateContactTool: BrainTool = {
  name: 'boss_crm_create_contact',
  description:
    'Create a new contact in the CRM. Provide at minimum a name and either email or phone.',
  parameters: {
    type: 'object',
    properties: {
      firstName: { type: 'string', description: 'First name.' },
      lastName: { type: 'string', description: 'Last name.' },
      email: { type: 'string', description: 'Email address.' },
      phone: { type: 'string', description: 'Phone number.' },
      companyName: { type: 'string', description: 'Company name.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply.' },
      source: { type: 'string', description: 'Lead source (e.g. "BOS", "LinkedIn", "Referral").' },
    },
    required: ['firstName'],
  },
};

export const crmUpdateContactTool: BrainTool = {
  name: 'boss_crm_update_contact',
  description:
    'Update an existing CRM contact. Provide the contact ID and any fields to change.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID to update.' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      companyName: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['contactId'],
  },
};

export const crmListPipelinesTool: BrainTool = {
  name: 'boss_crm_list_pipelines',
  description:
    'List all sales pipelines and their stages in the CRM. Use to understand the deal flow.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const crmSearchOpportunitiesTool: BrainTool = {
  name: 'boss_crm_search_opportunities',
  description:
    'Search CRM opportunities/deals. Filter by pipeline, stage, or contact. Returns deal name, value, stage, and assigned contact.',
  parameters: {
    type: 'object',
    properties: {
      pipelineId: { type: 'string', description: 'Pipeline ID to filter by.' },
      stageId: { type: 'string', description: 'Stage ID to filter by.' },
      contactId: { type: 'string', description: 'Contact ID to filter by.' },
      query: { type: 'string', description: 'Search term for opportunity name.' },
      limit: { type: 'number', description: 'Max results (default 20).' },
    },
    required: [],
  },
};

export const crmCreateOpportunityTool: BrainTool = {
  name: 'boss_crm_create_opportunity',
  description:
    'Create a new opportunity/deal in a CRM pipeline. Requires pipeline ID, stage ID, contact ID, and deal name.',
  parameters: {
    type: 'object',
    properties: {
      pipelineId: { type: 'string', description: 'Pipeline ID.' },
      stageId: { type: 'string', description: 'Stage ID.' },
      contactId: { type: 'string', description: 'Contact ID to link.' },
      name: { type: 'string', description: 'Deal/opportunity name.' },
      monetaryValue: { type: 'number', description: 'Deal value in dollars.' },
      status: { type: 'string', description: 'Status: open, won, lost, abandoned.' },
    },
    required: ['pipelineId', 'stageId', 'contactId', 'name'],
  },
};

export const crmGetConversationsTool: BrainTool = {
  name: 'boss_crm_get_conversations',
  description:
    'Get recent conversations/messages for a contact. Includes SMS, email, and chat messages from the CRM.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID.' },
    },
    required: ['contactId'],
  },
};

export const crmSendMessageTool: BrainTool = {
  name: 'boss_crm_send_message',
  description:
    'Send a message to a contact via the CRM. Supports SMS and email. Kevin must approve before sending.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID.' },
      type: { type: 'string', enum: ['sms', 'email'], description: 'Message type.' },
      message: { type: 'string', description: 'Message body.' },
      subject: { type: 'string', description: 'Email subject (required for email type).' },
    },
    required: ['contactId', 'type', 'message'],
  },
};

export const ALL_CRM_TOOLS: BrainTool[] = [
  crmSearchContactsTool,
  crmGetContactTool,
  crmCreateContactTool,
  crmUpdateContactTool,
  crmListPipelinesTool,
  crmSearchOpportunitiesTool,
  crmCreateOpportunityTool,
  crmGetConversationsTool,
  crmSendMessageTool,
];

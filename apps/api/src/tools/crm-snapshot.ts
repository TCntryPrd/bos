/**
 * CRM snapshot tool — lets the Sales/CRM agent persist a structured snapshot of
 * the GoHighLevel/Katalyst CRM each run, so the dashboard can visualize the
 * business (contacts, pipeline, conversion) and the brain can reason over it.
 * Stored in boss_crm_snapshot (jsonb), newest row wins. Read by GET /api/crm/snapshot.
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

export const crmSnapshotSaveTool: BrainTool = {
  name: 'boss_crm_snapshot_save',
  description:
    'Save the latest CRM / sales snapshot for the dashboard + COO. Call once at the end of your run with the metrics you pulled from the CRM. ' +
    'Only include fields you actually have; omit unknowns. Drives the dashboard CRM tiles.',
  parameters: {
    type: 'object',
    properties: {
      total_contacts: { type: 'number', description: 'Total contacts/leads in the CRM.' },
      new_contacts_month: { type: 'number', description: 'New contacts added this month.' },
      open_opportunities: { type: 'number', description: 'Count of open opportunities.' },
      pipeline_value: { type: 'number', description: 'Total $ value of open opportunities.' },
      won_month: { type: 'number', description: 'Opportunities won this month (count).' },
      won_value_month: { type: 'number', description: 'Revenue won this month ($).' },
      conversion_rate: { type: 'number', description: 'Win rate as a percent (0-100).' },
      appointments_upcoming: { type: 'number', description: 'Upcoming appointments, if known.' },
      by_stage: {
        type: 'array',
        description: 'Per-stage breakdown of the pipeline.',
        items: {
          type: 'object',
          properties: {
            stage: { type: 'string' },
            count: { type: 'number' },
            value: { type: 'number' },
          },
        },
      },
      flags: { type: 'array', items: { type: 'string' }, description: 'Short alerts, e.g. "3 deals stalled in Proposal Sent >14d".' },
      bottom_line: { type: 'string', description: 'One-line summary the solopreneur/COO can act on.' },
    },
    required: ['bottom_line'],
  },
};

export async function executeCrmSnapshotTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'boss_crm_snapshot_save') return `Unknown CRM tool: ${name}`;
  try {
    const pool = getPool();
    const snapshot = {
      total_contacts: args.total_contacts ?? null,
      new_contacts_month: args.new_contacts_month ?? null,
      open_opportunities: args.open_opportunities ?? null,
      pipeline_value: args.pipeline_value ?? null,
      won_month: args.won_month ?? null,
      won_value_month: args.won_value_month ?? null,
      conversion_rate: args.conversion_rate ?? null,
      appointments_upcoming: args.appointments_upcoming ?? null,
      by_stage: Array.isArray(args.by_stage) ? args.by_stage : [],
      flags: Array.isArray(args.flags) ? args.flags : [],
      bottom_line: String(args.bottom_line ?? ''),
    };
    await pool.query(
      `INSERT INTO boss_crm_snapshot (tenant_id, snapshot, created_at) VALUES ('default', $1::jsonb, now())`,
      [JSON.stringify(snapshot)],
    );
    return `CRM snapshot saved. Bottom line: ${snapshot.bottom_line}`;
  } catch (err) {
    return `CRM snapshot error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const ALL_CRM_SNAPSHOT_TOOLS: BrainTool[] = [crmSnapshotSaveTool];

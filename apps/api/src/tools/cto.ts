/**
 * CTO / Chief Engineer tools — the incident-response loop's hands.
 *
 * Read: boss_incidents_list, boss_cost_rollup.
 * Act:  boss_incident_update (lifecycle + timeline), boss_playbook_save (learn),
 *       boss_agent_control (BOUNDED remediation — pause/resume/set_model/set_cron
 *       on a persistent agent, the usual fix for a runaway cost spike).
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';
import { getCostRollup, getOpenIncidents } from '../lib/cost-ledger.js';

export const incidentsListTool: BrainTool = {
  name: 'boss_incidents_list',
  description: 'List currently-open incidents (e.g. cost spikes) for the CTO to work. Returns id, kind, source, severity, status, title, detail, observed vs baseline.',
  parameters: { type: 'object', properties: {}, required: [] },
};
export const costRollupTool: BrainTool = {
  name: 'boss_cost_rollup',
  description: 'Backend tool/platform spend by source over the last N hours (LLM agent runs + Google APIs). Use to diagnose what is driving a cost spike.',
  parameters: { type: 'object', properties: { hours: { type: 'number', description: 'Lookback window in hours (default 24).' } }, required: [] },
};
export const incidentUpdateTool: BrainTool = {
  name: 'boss_incident_update',
  description: 'Update an incident as you work it: set status (triaging | mitigating | resolved | escalated) and append a timeline note. Link a playbook with playbook_id.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Incident id.' },
      status: { type: 'string', description: 'triaging | mitigating | resolved | escalated' },
      note: { type: 'string', description: 'What you found / did (appended to the incident timeline).' },
      playbook_id: { type: 'string', description: 'Optional playbook id to link.' },
    },
    required: ['id'],
  },
};
export const playbookSaveTool: BrainTool = {
  name: 'boss_playbook_save',
  description: 'Create a remediation playbook so a recurrence is handled faster next time. Matched on (kind, match_key).',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'e.g. cost_spike' },
      match_key: { type: 'string', description: 'Stable key to match recurrences, e.g. the source "llm:claude-sonnet-4-6".' },
      title: { type: 'string' },
      symptom: { type: 'string', description: 'How it shows up.' },
      diagnosis: { type: 'string', description: 'Likely cause + how to confirm.' },
      resolution: { type: 'string', description: 'Step-by-step fix.' },
      severity: { type: 'string', description: 'low | medium | high | critical' },
    },
    required: ['kind', 'title', 'resolution'],
  },
};
export const agentControlTool: BrainTool = {
  name: 'boss_agent_control',
  description: 'BOUNDED remediation: control a persistent agent to fix a cost/runtime incident. action = pause | resume | set_model | set_cron (set_* require value). This is the usual fix for a runaway agent. Always record what you did in the incident timeline; escalate (telegram) anything riskier than this.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name (or partial, case-insensitive) of the persistent agent.' },
      action: { type: 'string', description: 'pause | resume | set_model | set_cron' },
      value: { type: 'string', description: 'For set_model: model id. For set_cron: cron expression.' },
    },
    required: ['agent_name', 'action'],
  },
};

export const ALL_CTO_TOOLS: BrainTool[] = [
  incidentsListTool, costRollupTool, incidentUpdateTool, playbookSaveTool, agentControlTool,
];

export async function executeCtoTool(name: string, args: Record<string, unknown>): Promise<string> {
  const pool = getPool();
  switch (name) {
    case 'boss_incidents_list': {
      const rows = await getOpenIncidents();
      if (!rows.length) return 'No open incidents.';
      return rows.map((r) =>
        `• [${r.id}] ${r.severity} · ${r.status} — ${r.title}\n  ${r.detail ?? ''}`).join('\n');
    }
    case 'boss_cost_rollup': {
      const hours = Math.min(Math.max(Number(args.hours ?? 24) || 24, 1), 24 * 30);
      const rows = await getCostRollup(hours);
      const total = rows.reduce((a, b) => a + b.cost, 0);
      const totalTk = rows.reduce((a, b) => a + b.tokens, 0);
      return `Last ${hours}h — API spend $${total.toFixed(4)}, ${(totalTk / 1e6).toFixed(2)}M tokens total:\n` +
        rows.map((r) => {
          const sub = r.source.startsWith('llm:') && !r.source.includes('/');
          const tk = r.tokens ? ` · ${(r.tokens / 1e6).toFixed(2)}M tok` : '';
          return sub
            ? `  ${r.source}: subscription, $0${tk} · ${r.units} runs`
            : `  ${r.source}: $${r.cost.toFixed(4)}${tk} · ${r.units} units`;
        }).join('\n');
    }
    case 'boss_incident_update': {
      const id = String(args.id ?? '');
      if (!id) return 'Error: id is required';
      const status = args.status ? String(args.status) : null;
      const note = args.note ? String(args.note) : null;
      const playbookId = args.playbook_id ? String(args.playbook_id) : null;
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (note) { sets.push(`timeline = timeline || jsonb_build_array(jsonb_build_object('at', now()::text, 'event', $${i}::text))`); vals.push(note); i++; }
      if (status) { sets.push(`status = $${i}`); vals.push(status); i++; if (status === 'resolved') sets.push(`resolved_at = now()`); }
      if (playbookId) { sets.push(`playbook_id = $${i}`); vals.push(playbookId); i++; }
      if (!sets.length) return 'Nothing to update (pass status, note, or playbook_id).';
      vals.push(id);
      const { rowCount } = await pool.query(`UPDATE boss_incidents SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      return rowCount ? `Incident ${id} updated${status ? ` → ${status}` : ''}.` : `No incident ${id} found.`;
    }
    case 'boss_playbook_save': {
      const kind = String(args.kind ?? 'general');
      const matchKey = args.match_key ? String(args.match_key) : null;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO boss_playbooks (kind, match_key, title, symptom, diagnosis, resolution, severity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [kind, matchKey, String(args.title ?? ''), args.symptom ? String(args.symptom) : null,
         args.diagnosis ? String(args.diagnosis) : null, String(args.resolution ?? ''),
         args.severity ? String(args.severity) : 'medium'],
      );
      return `Playbook saved (id ${rows[0].id}) for ${kind}${matchKey ? ` / ${matchKey}` : ''}.`;
    }
    case 'boss_agent_control': {
      const nm = String(args.agent_name ?? '');
      const action = String(args.action ?? '');
      const value = args.value ? String(args.value) : null;
      if (!nm || !action) return 'Error: agent_name and action are required';
      let q = '';
      let vals: unknown[] = [];
      if (action === 'pause') { q = `UPDATE boss_persistent_agents SET status='paused', updated_at=now() WHERE name ILIKE $1 RETURNING name, status`; vals = [`%${nm}%`]; }
      else if (action === 'resume') { q = `UPDATE boss_persistent_agents SET status='active', updated_at=now() WHERE name ILIKE $1 RETURNING name, status`; vals = [`%${nm}%`]; }
      else if (action === 'set_model') { if (!value) return 'Error: value (model id) required'; q = `UPDATE boss_persistent_agents SET model=$2, updated_at=now() WHERE name ILIKE $1 RETURNING name, model`; vals = [`%${nm}%`, value]; }
      else if (action === 'set_cron') { if (!value) return 'Error: value (cron expression) required'; q = `UPDATE boss_persistent_agents SET cron_expression=$2, updated_at=now() WHERE name ILIKE $1 RETURNING name, cron_expression`; vals = [`%${nm}%`, value]; }
      else return `Error: unknown action "${action}" (use pause|resume|set_model|set_cron)`;
      const { rows } = await pool.query(q, vals);
      if (!rows.length) return `No persistent agent matched "${nm}".`;
      return `Done: ${action} → ${JSON.stringify(rows[0])}`;
    }
    default:
      return `Unknown CTO tool: ${name}`;
  }
}

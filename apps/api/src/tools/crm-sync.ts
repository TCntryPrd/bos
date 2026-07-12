/**
 * CRM sync + metrics tools.
 *
 * The CRM Collector agent calls boss_crm_sync to pull the GoHighLevel/Katalyst
 * CRM into local organized tables (boss_crm_contacts, boss_crm_opportunities) —
 * a fresh, queryable mirror. The Sales Strategist agent calls boss_crm_metrics
 * to read aggregated stats off those local tables (fast, no GHL hammering) and
 * reason over them.
 *
 * Server-side execution (the tools do the GHL calls + DB upserts directly), so
 * the agents don't have to page the API themselves.
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_LOCATION = 'NymYyL8jmYkUtvAkDH2e';

async function crmKey(): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM runtime_config WHERE key = 'crm_api_key' AND tenant_id = 'default'",
  );
  const k = rows[0]?.value;
  if (!k) throw new Error('CRM API key not configured');
  return k;
}

// GHL fetch with a hard timeout + retry on transient failures (timeout / network /
// 429 / 5xx). Client errors (400/401/403/404) fail fast — retrying won't help.
async function ghl(path: string, key: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GHL_BASE}${path}`, {
        headers: { Authorization: `Bearer ${key}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastErr = err; // timeout (AbortError) / network — retryable
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      throw lastErr instanceof Error ? lastErr : new Error(`GHL fetch failed: ${String(lastErr)}`);
    }
    if (res.ok) return res.json();
    const body = (await res.text()).slice(0, 160);
    if (res.status !== 429 && res.status < 500) throw new Error(`GHL ${res.status}: ${body}`); // fail fast
    lastErr = new Error(`GHL ${res.status}: ${body}`); // 429 / 5xx — retryable
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error('GHL request failed');
}

async function ensureTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boss_crm_contacts (
      id text PRIMARY KEY, tenant_id text DEFAULT 'default',
      name text, email text, phone text, company text,
      tags jsonb, source text, date_added timestamptz,
      raw jsonb, synced_at timestamptz DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boss_crm_opportunities (
      id text PRIMARY KEY, tenant_id text DEFAULT 'default',
      name text, pipeline_id text, stage_id text, stage_name text,
      contact_id text, monetary_value numeric, status text,
      date_added timestamptz, updated_at timestamptz,
      raw jsonb, synced_at timestamptz DEFAULT now()
    )`);
}

// ── Sync tool ─────────────────────────────────────────────────────────────────

export const crmSyncTool: BrainTool = {
  name: 'boss_crm_sync',
  description:
    'Pull the CRM (contacts + pipelines + opportunities) from GoHighLevel/Katalyst into the local organized tables. ' +
    'Returns a summary of how many were synced. Call this once per Collector run to refresh the local mirror before anyone analyzes it.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export async function executeCrmSync(): Promise<string> {
  let key: string;
  try {
    key = await crmKey();
    await ensureTables();
  } catch (err) {
    return `CRM sync error (setup): ${err instanceof Error ? err.message : String(err)}`;
  }
  const pool = getPool();
  const notes: string[] = [];
  let contactCount = 0;
  let oppCount = 0;
  let pipeN = 0;

  // ── Contacts (paginated; degrade gracefully — already-inserted rows persist) ──
  try {
    let url: string | null = `/contacts/?locationId=${GHL_LOCATION}&limit=100`;
    for (let page = 0; page < 20 && url; page++) {
      const data: any = await ghl(url, key);
      const contacts: any[] = data.contacts ?? [];
      for (const c of contacts) {
        const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
        await pool.query(
          `INSERT INTO boss_crm_contacts (id, name, email, phone, company, tags, source, date_added, raw, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone,
             company=EXCLUDED.company, tags=EXCLUDED.tags, source=EXCLUDED.source, raw=EXCLUDED.raw, synced_at=now()`,
          [c.id, name, c.email ?? null, c.phone ?? null, c.companyName ?? null,
           JSON.stringify(c.tags ?? []), c.source ?? null, c.dateAdded ?? null, JSON.stringify(c)],
        );
        contactCount++;
      }
      const meta = data.meta ?? {};
      url = meta.startAfterId && meta.startAfter
        ? `/contacts/?locationId=${GHL_LOCATION}&limit=100&startAfterId=${meta.startAfterId}&startAfter=${meta.startAfter}`
        : null;
    }
  } catch (err) {
    notes.push(`contacts sync incomplete (${err instanceof Error ? err.message : String(err)})`);
  }

  // ── Pipelines + Opportunities (independent — a GHL hiccup here never loses contacts) ──
  try {
    const pipeData: any = await ghl(`/opportunities/pipelines?locationId=${GHL_LOCATION}`, key);
    const pipelines: any[] = pipeData.pipelines ?? [];
    pipeN = pipelines.length;
    const stageName: Record<string, string> = {};
    for (const p of pipelines) for (const s of (p.stages ?? [])) stageName[s.id] = s.name;

    for (const p of pipelines) {
      let ourl: string | null = `/opportunities/search?location_id=${GHL_LOCATION}&pipeline_id=${p.id}&limit=100`;
      for (let page = 0; page < 20 && ourl; page++) {
        const data: any = await ghl(ourl, key);
        const opps: any[] = data.opportunities ?? [];
        for (const o of opps) {
          await pool.query(
            `INSERT INTO boss_crm_opportunities (id, name, pipeline_id, stage_id, stage_name, contact_id, monetary_value, status, date_added, updated_at, raw, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, stage_id=EXCLUDED.stage_id, stage_name=EXCLUDED.stage_name,
               monetary_value=EXCLUDED.monetary_value, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, raw=EXCLUDED.raw, synced_at=now()`,
            [o.id, o.name ?? null, o.pipelineId ?? p.id, o.pipelineStageId ?? null, stageName[o.pipelineStageId] ?? null,
             o.contactId ?? o.contact?.id ?? null, o.monetaryValue ?? 0, o.status ?? null,
             o.createdAt ?? o.dateAdded ?? null, o.updatedAt ?? null, JSON.stringify(o)],
          );
          oppCount++;
        }
        const meta = data.meta ?? {};
        ourl = meta.startAfterId && meta.startAfter
          ? `/opportunities/search?location_id=${GHL_LOCATION}&pipeline_id=${p.id}&limit=100&startAfterId=${meta.startAfterId}&startAfter=${meta.startAfter}`
          : null;
      }
    }
  } catch (err) {
    notes.push(`opportunities sync skipped this run (${err instanceof Error ? err.message : String(err)})`);
  }

  const base = `CRM sync: ${contactCount} contacts, ${oppCount} opportunities across ${pipeN} pipeline(s) mirrored to boss_crm_contacts / boss_crm_opportunities`;
  return notes.length ? `${base}. NOTE: ${notes.join('; ')}` : `${base}.`;
}

// ── Metrics tool (read aggregated stats off the local mirror) ──────────────────

export const crmMetricsTool: BrainTool = {
  name: 'boss_crm_metrics',
  description:
    'Get aggregated CRM metrics from the local mirror (populated by boss_crm_sync): total contacts, new this month, open opportunities + pipeline value, per-stage breakdown, won this month, and deals that look stalled. Fast, no API calls. Use this to analyze the business before saving a snapshot.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export async function executeCrmMetrics(): Promise<string> {
  try {
    const pool = getPool();
    const totalC = await pool.query<{ c: string }>(`SELECT COUNT(*)::text c FROM boss_crm_contacts`);
    const newC = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text c FROM boss_crm_contacts WHERE date_added >= date_trunc('month', now())`);
    const openO = await pool.query<{ c: string; v: string }>(
      `SELECT COUNT(*)::text c, COALESCE(SUM(monetary_value),0)::text v FROM boss_crm_opportunities WHERE status = 'open'`);
    const byStage = await pool.query<{ stage_name: string; c: string; v: string }>(
      `SELECT COALESCE(stage_name,'(unknown)') stage_name, COUNT(*)::text c, COALESCE(SUM(monetary_value),0)::text v
         FROM boss_crm_opportunities WHERE status='open' GROUP BY stage_name ORDER BY SUM(monetary_value) DESC`);
    const wonM = await pool.query<{ c: string; v: string }>(
      `SELECT COUNT(*)::text c, COALESCE(SUM(monetary_value),0)::text v FROM boss_crm_opportunities
        WHERE status='won' AND updated_at >= date_trunc('month', now())`);
    const stalled = await pool.query<{ name: string; stage_name: string; days: string; v: string }>(
      `SELECT name, COALESCE(stage_name,'?') stage_name, EXTRACT(day FROM now()-updated_at)::text days, COALESCE(monetary_value,0)::text v
         FROM boss_crm_opportunities WHERE status='open' AND updated_at < now()-interval '14 days'
        ORDER BY monetary_value DESC LIMIT 8`);

    const stageLines = byStage.rows.map((r) => `  - ${r.stage_name}: ${r.c} deals, $${Math.round(Number(r.v))}`).join('\n') || '  (no open opportunities)';
    const stalledLines = stalled.rows.map((r) => `  - ${r.name} ($${Math.round(Number(r.v))}) stalled ${Math.round(Number(r.days))}d in ${r.stage_name}`).join('\n') || '  (none)';

    return [
      `CRM metrics (from local mirror):`,
      `Total contacts: ${totalC.rows[0]?.c ?? 0} (new this month: ${newC.rows[0]?.c ?? 0})`,
      `Open opportunities: ${openO.rows[0]?.c ?? 0}, pipeline value: $${Math.round(Number(openO.rows[0]?.v ?? 0))}`,
      `Won this month: ${wonM.rows[0]?.c ?? 0} ($${Math.round(Number(wonM.rows[0]?.v ?? 0))})`,
      `Open by stage:\n${stageLines}`,
      `Stalled (>14d):\n${stalledLines}`,
    ].join('\n');
  } catch (err) {
    return `CRM metrics error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const ALL_CRM_SYNC_TOOLS: BrainTool[] = [crmSyncTool, crmMetricsTool];

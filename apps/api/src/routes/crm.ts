/**
 * CRM routes — /api/crm
 *
 * Serves the latest CRM/sales snapshot and a lightweight receptionist-facing
 * contact search surface backed by the local Katalyst/GHL mirror.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';

const KATALYST_URL = 'https://www.katalyst-crm.com';
const GHL_LOCATION = 'NymYyL8jmYkUtvAkDH2e';

interface CrmContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: unknown;
  source: string | null;
  date_added: string | null;
  synced_at: string | null;
}

interface CrmOpportunityRow {
  id: string;
  name: string | null;
  stage_name: string | null;
  monetary_value: string | null;
  status: string | null;
  updated_at: string | null;
}

function contactProfileUrl(id: string): string {
  return `${KATALYST_URL}/v2/location/${GHL_LOCATION}/contacts/detail/${encodeURIComponent(id)}`;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => String(tag ?? '').trim())
    .filter(Boolean);
}

function contactPayload(row: CrmContactRow) {
  return {
    id: row.id,
    name: row.name || 'Unnamed contact',
    email: row.email,
    phone: row.phone,
    company: row.company,
    tags: normalizeTags(row.tags),
    source: row.source,
    dateAdded: row.date_added,
    syncedAt: row.synced_at,
    profileUrl: contactProfileUrl(row.id),
    provider: 'katalyst',
  };
}

export async function crmRoutes(server: FastifyInstance): Promise<void> {
  server.get('/snapshot', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const { rows } = await pool.query<{ snapshot: Record<string, unknown>; created_at: string }>(
      `SELECT snapshot, created_at FROM boss_crm_snapshot ORDER BY created_at DESC LIMIT 1`,
    );
    if (rows.length === 0) {
      return reply.send({ snapshot: null, created_at: null });
    }
    return reply.send({ ...rows[0].snapshot, created_at: rows[0].created_at });
  });

  server.get('/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const keys = await pool.query<{ key: string }>(
      `SELECT key FROM runtime_config
        WHERE key IN ('crm_api_key', 'KATALYST_CRM_API_KEY', 'KEAP_SAK', 'crm_provider', 'crm_url')
        ORDER BY key`,
    );
    const counts = await pool.query<{ contacts: string; tagged: string; last_sync: string | null }>(
      `SELECT COUNT(*)::text contacts,
              COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(tags,'[]'::jsonb)) > 0)::text tagged,
              MAX(synced_at)::text last_sync
         FROM boss_crm_contacts`,
    );

    const configured = new Set(keys.rows.map((row) => row.key));
    return reply.send({
      provider: 'Katalyst',
      contacts: Number(counts.rows[0]?.contacts ?? 0),
      tagged: Number(counts.rows[0]?.tagged ?? 0),
      lastSync: counts.rows[0]?.last_sync ?? null,
      connections: {
        katalyst: configured.has('crm_api_key') || configured.has('KATALYST_CRM_API_KEY'),
        keap: configured.has('KEAP_SAK'),
      },
    });
  });

  server.get('/tags', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(query.limit ?? 80) || 80, 200));
    const pool = getPool();
    const { rows } = await pool.query<{ tag: string; count: string }>(
      `SELECT t.tag, COUNT(*)::text count
         FROM boss_crm_contacts,
              LATERAL jsonb_array_elements_text(COALESCE(tags,'[]'::jsonb)) AS t(tag)
        WHERE NULLIF(TRIM(t.tag), '') IS NOT NULL
        GROUP BY t.tag
        ORDER BY COUNT(*) DESC, t.tag ASC
        LIMIT $1`,
      [limit],
    );
    return reply.send({
      tags: rows.map((row) => ({ tag: row.tag, count: Number(row.count) })),
    });
  });

  server.get('/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { q?: string; tag?: string; limit?: string };
    const search = String(query.q ?? '').trim();
    const tag = String(query.tag ?? '').trim();
    const limit = Math.max(1, Math.min(Number(query.limit ?? 40) || 40, 100));
    const pool = getPool();

    const { rows } = await pool.query<CrmContactRow>(
      `SELECT id, name, email, phone, company, tags, source,
              date_added::text, synced_at::text
         FROM boss_crm_contacts
        WHERE (
              $1 = ''
              OR COALESCE(name,'') ILIKE '%' || $1 || '%'
              OR COALESCE(email,'') ILIKE '%' || $1 || '%'
              OR COALESCE(phone,'') ILIKE '%' || $1 || '%'
              OR COALESCE(company,'') ILIKE '%' || $1 || '%'
              OR COALESCE(source,'') ILIKE '%' || $1 || '%'
              OR COALESCE(tags::text,'') ILIKE '%' || $1 || '%'
            )
          AND (
              $2 = ''
              OR EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(COALESCE(tags,'[]'::jsonb)) AS t(tag)
                 WHERE lower(t.tag) = lower($2)
              )
            )
        ORDER BY date_added DESC NULLS LAST, name ASC NULLS LAST
        LIMIT $3`,
      [search, tag, limit],
    );

    return reply.send({
      mode: tag ? 'tag' : 'search',
      query: search,
      tag: tag || null,
      contacts: rows.map(contactPayload),
    });
  });

  server.get('/contact/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const pool = getPool();
    const contact = await pool.query<CrmContactRow>(
      `SELECT id, name, email, phone, company, tags, source,
              date_added::text, synced_at::text
         FROM boss_crm_contacts
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    if (contact.rows.length === 0) {
      return reply.status(404).send({ error: 'Contact not found' });
    }

    const opportunities = await pool.query<CrmOpportunityRow>(
      `SELECT id, name, stage_name, monetary_value::text, status, updated_at::text
         FROM boss_crm_opportunities
        WHERE contact_id = $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 8`,
      [id],
    );

    return reply.send({
      contact: contactPayload(contact.rows[0]),
      opportunities: opportunities.rows.map((row) => ({
        id: row.id,
        name: row.name,
        stage: row.stage_name,
        value: Number(row.monetary_value ?? 0),
        status: row.status,
        updatedAt: row.updated_at,
      })),
    });
  });

  server.post('/action-preview', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { action?: string; contactIds?: string[]; tag?: string };
    const contactIds = Array.isArray(body.contactIds) ? body.contactIds.filter(Boolean) : [];
    const action = String(body.action ?? 'review').trim() || 'review';

    return reply.send({
      accepted: false,
      preview: true,
      action,
      tag: body.tag ?? null,
      selectedCount: contactIds.length,
      message: `${action} is staged for ${contactIds.length} contact${contactIds.length === 1 ? '' : 's'}. Connect the final write action when you want it to mutate CRM records.`,
    });
  });
}

export default crmRoutes;

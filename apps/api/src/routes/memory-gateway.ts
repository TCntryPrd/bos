import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';

type IngestBody = {
  deviceId?: string;
  source?: string;
  kind?: string;
  title?: string;
  text?: string;
  createdAt?: string;
  vector?: number[];
};

type ReindexBody = { limit?: number; cursor?: string };

type LedgerRow = {
  content_hash?: string;
  weaviate_id: string;
  device_id: string;
  source: string;
  kind: string;
  title: string;
  content: string;
  created_at: Date;
};

const MAX_TEXT = 12_000;
const MAX_VECTOR = 4_096;

function weaviateFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = process.env.WEAVIATE_API_KEY?.trim();
  const request = (authHeaders: Record<string, string>) => fetch(`http://weaviate:8080${path}`, {
    ...init,
    headers: { ...authHeaders, ...init.headers },
  });
  if (!apiKey) return request({});

  // Older guarded installs accept Bearer while some native Weaviate versions
  // accept only X-API-Key. Never send both at once: the latter can reject an
  // otherwise valid request when an unsupported Bearer header is present.
  return request({ authorization: `Bearer ${apiKey}` }).then(async (response) => {
    if (response.status !== 401 && response.status !== 403) return response;
    await response.arrayBuffer().catch(() => undefined);
    return request({ 'x-api-key': apiKey });
  });
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function stableUuid(input: string): string {
  const hex = crypto.createHash('sha256').update(input).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function redact(text: string): string {
  return text
    .replace(/(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:access_token|refresh_token|api_key|password)"?\s*[:=]\s*")[^"]+/gi, '$1[REDACTED]');
}

function validVector(vector: unknown): vector is number[] {
  return Array.isArray(vector)
    && vector.length > 1
    && vector.length <= MAX_VECTOR
    && vector.every((value) => typeof value === 'number' && Number.isFinite(value));
}

async function embed(text: string): Promise<number[]> {
  const endpoint = process.env.AIOS_EMBEDDING_URL ?? 'http://embeddings:8080/embed';
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: [text] }),
  });
  if (!response.ok) throw new Error(`embedding service returned ${response.status}`);
  const body = await response.json() as unknown;
  if (!Array.isArray(body) || !Array.isArray(body[0]) || !validVector(body[0])) throw new Error('embedding service returned an invalid vector');
  return body[0];
}

function canonicalObject(row: LedgerRow, vector: number[]) {
  return {
    class: 'CodexMemory', id: row.weaviate_id,
    properties: {
      title: row.title, text: row.content, source: `${row.source}:${row.device_id}`, project: 'AIOS-Edge', kind: row.kind,
      cwd: 'gateway', session_id: row.device_id, turn_id: row.weaviate_id,
      tags: `aios,edge,${row.source},${row.device_id}`, stability: 'episodic',
      created_at: new Date(row.created_at).toISOString(), updated_at: new Date().toISOString(),
    },
    vector,
  };
}

async function putCanonicalObject(object: ReturnType<typeof canonicalObject>): Promise<boolean> {
  const written = await weaviateFetch(`/v1/objects/${object.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(object),
  });
  return written.ok;
}

function requireEdgeToken(request: FastifyRequest): string | null {
  const expected = process.env.AIOS_EDGE_INGEST_TOKEN;
  const supplied = request.headers['x-aios-edge-token'];
  const token = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!expected || expected.length < 32 || !sameToken(token, expected)) return null;
  return expected;
}

export async function memoryGatewayRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/aios/memory/health', { config: { skipAuth: true } }, async (_request, reply) => {
    const ready = await weaviateFetch('/v1/.well-known/ready').then((r) => r.ok).catch(() => false);
    return reply.code(ready ? 200 : 503).send({ ok: ready, service: 'aios-memory-gateway' });
  });

  server.post<{ Body: IngestBody }>('/api/aios/memory/ingest', { config: { skipAuth: true } }, async (request, reply) => {
    if (!requireEdgeToken(request)) return reply.code(401).send({ error: 'unauthorized-edge' });
    const body = request.body ?? {};
    const deviceId = String(body.deviceId ?? '').trim().toLowerCase();
    const source = String(body.source ?? '').trim().toLowerCase();
    const kind = String(body.kind ?? 'event').trim().toLowerCase();
    const title = String(body.title ?? '').trim().slice(0, 300);
    const original = String(body.text ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(deviceId) || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(source) || !title || !original) {
      return reply.code(400).send({ error: 'invalid-ingest-shape' });
    }
    const text = redact(original).slice(0, MAX_TEXT);
    const redacted = text !== original.slice(0, MAX_TEXT);
    const createdAt = body.createdAt ? new Date(body.createdAt) : new Date();
    if (Number.isNaN(createdAt.getTime())) return reply.code(400).send({ error: 'invalid-created-at' });
    if (body.vector !== undefined) return reply.code(400).send({ error: 'edge-supplied-vectors-not-allowed' });

    const contentHash = crypto.createHash('sha256').update(`${deviceId}\n${source}\n${kind}\n${title}\n${text}`).digest('hex');
    const existing = await getPool().query('SELECT weaviate_id FROM aios_memory_ledger WHERE content_hash = $1', [contentHash]);
    if (existing.rowCount) return reply.send({ accepted: true, deduplicated: true, id: existing.rows[0].weaviate_id });

    let vector: number[];
    try { vector = await embed(text); }
    catch (err) {
      request.log.error({ err, deviceId, source }, 'AIOS gateway embedding failed');
      return reply.code(503).send({ error: 'embedding-service-unavailable' });
    }
    const id = stableUuid(contentHash);
    const object = canonicalObject({ weaviate_id: id, device_id: deviceId, source, kind, title, content: text, created_at: createdAt }, vector);
    const written = await putCanonicalObject(object);
    if (!written) {
      request.log.error({ deviceId, source }, 'AIOS gateway Weaviate write failed');
      return reply.code(502).send({ error: 'canonical-store-unavailable' });
    }
    await getPool().query(
      `INSERT INTO aios_memory_ledger (content_hash, weaviate_id, device_id, source, kind, title, content, created_at, redacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (content_hash) DO NOTHING`,
      [contentHash, id, deviceId, source, kind, title, text, createdAt.toISOString(), redacted],
    );
    return reply.code(201).send({ accepted: true, deduplicated: false, id, redacted, vectorized: true });
  });

  server.get('/api/aios/memory/sync', { config: { skipAuth: true } }, async (request, reply) => {
    if (!requireEdgeToken(request)) return reply.code(401).send({ error: 'unauthorized-edge' });
    const since = typeof (request.query as { since?: unknown }).since === 'string' ? (request.query as { since: string }).since : '1970-01-01T00:00:00.000Z';
    const result = await getPool().query(
      `SELECT weaviate_id AS id, device_id, source, kind, title, content, created_at, accepted_at, redacted
       FROM aios_memory_ledger WHERE accepted_at > $1::timestamptz ORDER BY accepted_at ASC LIMIT 500`, [since],
    );
    return reply.send({ records: result.rows, nextSince: result.rows.length ? result.rows[result.rows.length - 1].accepted_at : since });
  });

  // Read-only semantic recall for trusted AI clients.  The vector store remains private to this gateway.
  server.get('/api/aios/memory/search', { config: { skipAuth: true } }, async (request, reply) => {
    if (!requireEdgeToken(request)) return reply.code(401).send({ error: 'unauthorized-edge' });
    const query = typeof (request.query as { q?: unknown }).q === 'string' ? (request.query as { q: string }).q.trim() : '';
    const requested = Number((request.query as { limit?: unknown }).limit ?? 8);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 20) : 8;
    const deviceId = typeof (request.query as { deviceId?: unknown }).deviceId === 'string'
      ? (request.query as { deviceId: string }).deviceId.trim().toLowerCase()
      : '';
    const source = typeof (request.query as { source?: unknown }).source === 'string'
      ? (request.query as { source: string }).source.trim().toLowerCase()
      : '';
    if (query.length < 3 || query.length > 2_000) return reply.code(400).send({ error: 'invalid-search-query' });
    if (Boolean(deviceId) !== Boolean(source)) {
      return reply.code(400).send({ error: 'incomplete-memory-scope' });
    }
    if (deviceId && (
      !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(deviceId)
      || !/^[a-z0-9][a-z0-9._-]{1,80}$/.test(source)
    )) return reply.code(400).send({ error: 'invalid-memory-scope' });
    let vector: number[];
    try { vector = await embed(query); }
    catch { return reply.code(503).send({ error: 'embedding-service-unavailable' }); }
    const where = deviceId
      ? `, where: { path: [\"source\"], operator: Equal, valueText: ${JSON.stringify(`${source}:${deviceId}`)} }`
      : '';
    const graph = await weaviateFetch('/v1/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ Get { CodexMemory(nearVector: { vector: ${JSON.stringify(vector)} }${where}, limit: ${limit}) { title text source project kind created_at updated_at tags stability _additional { id distance } } } }` }),
    });
    if (!graph.ok) return reply.code(502).send({ error: 'canonical-search-unavailable' });
    const body = await graph.json() as { data?: { Get?: { CodexMemory?: unknown[] } }; errors?: unknown };
    if (body.errors) return reply.code(502).send({ error: 'canonical-search-failed' });
    return reply.send({
      query,
      scope: deviceId ? { deviceId, source } : null,
      results: body.data?.Get?.CodexMemory ?? [],
    });
  });

  // Administrative repair route: only the gateway may create vectors, including for its own early records.
  server.post<{ Body: ReindexBody }>('/api/aios/memory/reindex', { config: { skipAuth: true } }, async (request, reply) => {
    if (!requireEdgeToken(request)) return reply.code(401).send({ error: 'unauthorized-edge' });
    const requested = Number(request.body?.limit ?? 500);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 500;
    const cursor = String(request.body?.cursor ?? '').trim().toLowerCase();
    if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) {
      return reply.code(400).send({ error: 'invalid-reindex-cursor' });
    }
    const rows = await getPool().query<LedgerRow>(
      `SELECT content_hash, weaviate_id, device_id, source, kind, title, content, created_at
       FROM aios_memory_ledger
       WHERE content_hash > $2
       ORDER BY content_hash ASC
       LIMIT $1`, [limit, cursor],
    );
    let reindexed = 0;
    const failed: string[] = [];
    for (const row of rows.rows) {
      try {
        const vector = await embed(row.content);
        if (await putCanonicalObject(canonicalObject(row, vector))) reindexed += 1;
        else failed.push(row.weaviate_id);
      } catch {
        failed.push(row.weaviate_id);
      }
    }
    const nextCursor = rows.rowCount === limit
      ? (rows.rows[rows.rows.length - 1]?.content_hash ?? null)
      : null;
    return reply.code(failed.length ? 502 : 200).send({
      requested: rows.rowCount ?? 0,
      reindexed,
      failed,
      nextCursor,
    });
  });
}

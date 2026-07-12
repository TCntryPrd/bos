/**
 * All SQL for the health module lives here. No Fastify imports —
 * this file (plus service.ts) must lift cleanly into a standalone
 * service later (spec: "extraction-ready").
 */
import type pg from 'pg';
import type { DailyMetric, DailyRow, DeviceRow, DiagnosticsEntry, RecordRow } from './types.js';

type Db = pg.Pool | pg.PoolClient;

const DEVICE_COLS =
  'id, tenant_id, user_id, name, platform, token_hash, paired_at, last_seen_at, revoked_at';

let healthSupportTablesReady: Promise<void> | null = null;

export async function ensureHealthSupportTables(db: Db): Promise<void> {
  healthSupportTablesReady ??= db.query(`
    CREATE TABLE IF NOT EXISTS health_anomalies (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT        NOT NULL,
      user_id     TEXT        NOT NULL,
      day         DATE        NOT NULL,
      metric      TEXT        NOT NULL,
      severity    TEXT        NOT NULL DEFAULT 'info'
                            CHECK (severity IN ('info', 'watch', 'warning', 'critical')),
      value       NUMERIC,
      baseline    NUMERIC,
      threshold   NUMERIC,
      direction   TEXT,
      summary     TEXT        NOT NULL,
      detail      JSONB       NOT NULL DEFAULT '{}',
      status      TEXT        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'reviewed', 'resolved', 'dismissed')),
      fingerprint TEXT        NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      UNIQUE (tenant_id, user_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_health_anomalies_tenant_day
      ON health_anomalies (tenant_id, user_id, day DESC, severity);
    CREATE INDEX IF NOT EXISTS idx_health_anomalies_status
      ON health_anomalies (tenant_id, status, detected_at DESC);

    CREATE TABLE IF NOT EXISTS health_journal_entries (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      TEXT        NOT NULL,
      user_id        TEXT        NOT NULL,
      entry_date     DATE        NOT NULL,
      occurred_at    TIMESTAMPTZ,
      title          TEXT,
      body           TEXT        NOT NULL,
      mood           TEXT,
      energy         SMALLINT    CHECK (energy IS NULL OR energy BETWEEN 1 AND 10),
      soreness       SMALLINT    CHECK (soreness IS NULL OR soreness BETWEEN 1 AND 10),
      sleep_quality  SMALLINT    CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 10),
      tags           TEXT[]      NOT NULL DEFAULT '{}',
      related_metrics JSONB      NOT NULL DEFAULT '{}',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_health_journal_entries_day
      ON health_journal_entries (tenant_id, user_id, entry_date DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS health_medical_records (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT        NOT NULL,
      user_id     TEXT        NOT NULL,
      record_date DATE        NOT NULL,
      category    TEXT        NOT NULL DEFAULT 'note',
      title       TEXT        NOT NULL,
      provider    TEXT,
      facility    TEXT,
      source      TEXT,
      archive_only BOOLEAN    NOT NULL DEFAULT false,
      notes       TEXT,
      metadata    JSONB       NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE health_medical_records ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE health_medical_records ADD COLUMN IF NOT EXISTS archive_only BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_health_medical_records_day
      ON health_medical_records (tenant_id, user_id, record_date DESC, created_at DESC);
  `).then(() => undefined).catch((err) => {
    healthSupportTablesReady = null;
    throw err;
  });
  await healthSupportTablesReady;
}

export async function insertDevice(
  db: Db,
  args: { tenantId: string; userId: string; name: string; platform: string },
): Promise<DeviceRow> {
  const { rows } = await db.query(
    `INSERT INTO health_devices (tenant_id, user_id, name, platform)
     VALUES ($1, $2, $3, $4) RETURNING ${DEVICE_COLS}`,
    [args.tenantId, args.userId, args.name, args.platform],
  );
  return rows[0];
}

export async function insertPairingCode(
  db: Db,
  args: { deviceId: string; codeHash: string; expiresAt: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO health_pairing_codes (device_id, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [args.deviceId, args.codeHash, args.expiresAt],
  );
}

/** Atomically consume an unused, unexpired code. Returns the device_id or null. */
export async function consumePairingCode(db: Db, codeHash: string): Promise<string | null> {
  const { rows } = await db.query(
    `UPDATE health_pairing_codes SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING device_id`,
    [codeHash],
  );
  return rows[0]?.device_id ?? null;
}

export async function setDeviceToken(db: Db, deviceId: string, tokenHash: string): Promise<void> {
  await db.query(
    `UPDATE health_devices SET token_hash = $2, paired_at = now() WHERE id = $1`,
    [deviceId, tokenHash],
  );
}

export async function findDeviceByTokenHash(db: Db, tokenHash: string): Promise<DeviceRow | null> {
  const { rows } = await db.query(
    `SELECT ${DEVICE_COLS} FROM health_devices
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export interface DeviceSyncState {
  record_type: string; last_record_ts: string | null;
  records_total: number | null; updated_at: string | null;
  granted: boolean | null; has_local_data: boolean | null;
}

/**
 * Per-device per-type sync state, merging health_sync_state (historical/volume
 * signal) with health_diagnostics (current permission/local-data snapshot).
 * A FULL JOIN between the two per-device sub-aggregates ensures a type that has
 * only reported diagnostics (no sync_state row yet, e.g. never actually
 * ingested) still appears — and vice versa for pre-upgrade devices that have
 * synced but never reported diagnostics.
 */
export async function listDevicesWithSync(
  db: Db, tenantId: string,
): Promise<(Omit<DeviceRow, 'token_hash'> & { sync_state: DeviceSyncState[] })[]> {
  const { rows } = await db.query(
    `SELECT d.id, d.tenant_id, d.user_id, d.name, d.platform,
            d.paired_at, d.last_seen_at, d.revoked_at,
            COALESCE(
              json_agg(json_build_object(
                'record_type', m.record_type,
                'last_record_ts', m.last_record_ts,
                'records_total', m.records_total,
                'updated_at', m.updated_at,
                'granted', m.granted,
                'has_local_data', m.has_local_data
              ) ORDER BY m.record_type) FILTER (WHERE m.record_type IS NOT NULL),
              '[]'
            ) AS sync_state
     FROM health_devices d
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(s.record_type, g.record_type) AS record_type,
         s.last_record_ts, s.records_total, s.updated_at,
         g.granted, g.has_local_data
       FROM health_sync_state s
       FULL JOIN health_diagnostics g
         ON g.device_id = s.device_id AND g.record_type = s.record_type
       WHERE COALESCE(s.device_id, g.device_id) = d.id
     ) m ON true
     WHERE d.tenant_id = $1
     GROUP BY d.id
     ORDER BY d.created_at`,
    [tenantId],
  );
  return rows;
}

/**
 * Batch upsert of a device's diagnostics manifest, one row per (device_id,
 * record_type). Current snapshot only — each call fully replaces the prior
 * granted/has_local_data/reported_at for the types included.
 */
export async function upsertDiagnostics(
  db: Db, deviceId: string, entries: DiagnosticsEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const values: string[] = [];
  const params: unknown[] = [deviceId];
  for (const e of entries) {
    const base = params.length;
    values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(e.type, e.granted, e.hasLocalData);
  }
  await db.query(
    `INSERT INTO health_diagnostics (device_id, record_type, granted, has_local_data)
     VALUES ${values.join(', ')}
     ON CONFLICT (device_id, record_type) DO UPDATE SET
       granted = EXCLUDED.granted,
       has_local_data = EXCLUDED.has_local_data,
       reported_at = now()`,
    params,
  );
  return entries.length;
}

export async function revokeDevice(db: Db, tenantId: string, deviceId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE health_devices SET revoked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [deviceId, tenantId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function touchDeviceLastSeen(db: Db, deviceId: string): Promise<void> {
  await db.query(`UPDATE health_devices SET last_seen_at = now() WHERE id = $1`, [deviceId]);
}

export interface UpsertRecordArgs {
  tenantId: string; userId: string; deviceId: string;
  recordType: string; recordUid: string;
  startTs: string; endTs: string | null; day: string;
  sourceApp: string | null; payload: Record<string, unknown>;
}

export interface UpsertRecordOutcome {
  status: 'inserted' | 'updated' | 'unchanged';
  /** The row's day before this call, when an existing row was actually updated to a different day, else null. */
  previousDay: string | null;
}

/**
 * Idempotent insert. 'unchanged' means an identical live row already existed.
 * The WHERE clause on the conflict update must cover every column the caller can
 * change (payload, timestamps, day, source_app, deleted_at) — otherwise a
 * correction that only shifts start_ts/end_ts/day (with identical payload) is
 * silently dropped and the row keeps stale attribution forever.
 */
export async function upsertRecord(
  db: Db, r: UpsertRecordArgs,
): Promise<UpsertRecordOutcome> {
  const { rows } = await db.query(
    `WITH existing AS (
       SELECT day::text AS day FROM health_records
       WHERE user_id = $2 AND record_type = $4 AND record_uid = $5
     ), upsert AS (
       INSERT INTO health_records
         (tenant_id, user_id, device_id, record_type, record_uid,
          start_ts, end_ts, day, source_app, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, record_type, record_uid) DO UPDATE SET
         start_ts = EXCLUDED.start_ts, end_ts = EXCLUDED.end_ts, day = EXCLUDED.day,
         source_app = EXCLUDED.source_app, payload = EXCLUDED.payload, deleted_at = NULL
       WHERE health_records.payload IS DISTINCT FROM EXCLUDED.payload
          OR health_records.start_ts IS DISTINCT FROM EXCLUDED.start_ts
          OR health_records.end_ts IS DISTINCT FROM EXCLUDED.end_ts
          OR health_records.day IS DISTINCT FROM EXCLUDED.day
          OR health_records.source_app IS DISTINCT FROM EXCLUDED.source_app
          OR health_records.deleted_at IS NOT NULL
       RETURNING (xmax = 0) AS inserted
     )
     SELECT upsert.inserted, existing.day AS previous_day
     FROM upsert LEFT JOIN existing ON true`,
    [r.tenantId, r.userId, r.deviceId, r.recordType, r.recordUid,
     r.startTs, r.endTs, r.day, r.sourceApp, JSON.stringify(r.payload)],
  );
  if (!rows.length) return { status: 'unchanged', previousDay: null };
  const inserted = rows[0].inserted as boolean;
  if (inserted) return { status: 'inserted', previousDay: null };
  const previousDay = rows[0].previous_day as string;
  return { status: 'updated', previousDay: previousDay !== r.day ? previousDay : null };
}

/**
 * Soft-delete one record and return its stored day (null when no live row
 * matched). The stored day — not one derived from the tombstone's wire
 * timestamps — is what the rollup recompute must target: HC change-feed
 * deletes may omit `end`, so a SleepSession tombstone would be attributed to
 * its start day while the row was rolled up under the wake day, leaving that
 * day's rollup permanently stale.
 */
export async function softDeleteRecord(
  db: Db, args: { userId: string; recordType: string; recordUid: string },
): Promise<string | null> {
  const { rows } = await db.query(
    `UPDATE health_records SET deleted_at = now()
     WHERE user_id = $1 AND record_type = $2 AND record_uid = $3 AND deleted_at IS NULL
     RETURNING day::text AS day`,
    [args.userId, args.recordType, args.recordUid],
  );
  return rows[0]?.day ?? null;
}

export async function recordsForDay(
  db: Db, tenantId: string, userId: string, day: string,
): Promise<RecordRow[]> {
  const { rows } = await db.query(
    `SELECT record_type, record_uid, start_ts, end_ts, day::text AS day, payload
     FROM health_records
     WHERE tenant_id = $1 AND user_id = $2 AND day = $3 AND deleted_at IS NULL`,
    [tenantId, userId, day],
  );
  return rows;
}

/**
 * Serialize rollup recomputation for one (user, day). Transaction-scoped
 * advisory lock, released automatically at COMMIT/ROLLBACK — must be called
 * on a client inside an open transaction. Without it, two concurrent ingests
 * touching the same day race in the unlocked read-compute-delete-insert
 * recompute under READ COMMITTED: the later DELETE+INSERT clobbers the other
 * transaction's committed rollup with a stale computation (or trips the
 * (user_id, day, metric) unique constraint). Once the lock is acquired the
 * next statement's snapshot sees everything the previous holder committed,
 * so the recompute is always based on the full set of live records.
 */
export async function lockUserDayForRollup(db: Db, userId: string, day: string): Promise<void> {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
    [userId, day],
  );
}

/** Full recompute for one (user, day): delete then insert — always consistent. */
export async function replaceDailyMetrics(
  db: Db,
  args: { tenantId: string; userId: string; day: string; metrics: DailyMetric[] },
): Promise<void> {
  await db.query(
    `DELETE FROM health_daily WHERE user_id = $1 AND day = $2`, [args.userId, args.day]);
  for (const m of args.metrics) {
    await db.query(
      `INSERT INTO health_daily (tenant_id, user_id, day, metric, value, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [args.tenantId, args.userId, args.day, m.metric, m.value, JSON.stringify(m.detail)],
    );
  }
}

export async function upsertSyncState(
  db: Db, deviceId: string, recordType: string, lastTs: string, added: number,
): Promise<void> {
  await db.query(
    `INSERT INTO health_sync_state (device_id, record_type, last_record_ts, records_total)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (device_id, record_type) DO UPDATE SET
       last_record_ts = GREATEST(health_sync_state.last_record_ts, EXCLUDED.last_record_ts),
       records_total = health_sync_state.records_total + EXCLUDED.records_total,
       updated_at = now()`,
    [deviceId, recordType, lastTs, added],
  );
}

export async function dailyForDays(
  db: Db, tenantId: string, days: string[], metrics?: string[],
): Promise<DailyRow[]> {
  const params: unknown[] = [tenantId, days];
  let metricClause = '';
  if (metrics?.length) { params.push(metrics); metricClause = 'AND metric = ANY($3)'; }
  const { rows } = await db.query(
    `SELECT day::text AS day, metric, value::float AS value, detail
     FROM health_daily
     WHERE tenant_id = $1 AND day = ANY($2::date[]) ${metricClause}
     ORDER BY day`,
    params,
  );
  return rows;
}

export async function baselineFor(
  db: Db, tenantId: string, metric: string, day: string, window: number,
): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT AVG(value)::float AS baseline FROM health_daily
     WHERE tenant_id = $1 AND metric = $2
       AND day < $3::date AND day >= $3::date - $4::int`,
    [tenantId, metric, day, window],
  );
  return rows[0]?.baseline ?? null;
}

export async function loadThresholdConfig(db: Db, tenantId: string): Promise<string | null> {
  try {
    const { rows } = await db.query(
      `SELECT value FROM runtime_config WHERE key = 'health.thresholds' AND tenant_id = $1`,
      [tenantId],
    );
    return rows[0]?.value ?? null;
  } catch {
    return null; // runtime_config may not exist in a scratch DB — defaults apply
  }
}

export async function dailyRange(
  db: Db, tenantId: string,
  args: { from: string; to: string; metrics?: string[] },
): Promise<DailyRow[]> {
  const params: unknown[] = [tenantId, args.from, args.to];
  let metricClause = '';
  if (args.metrics?.length) { params.push(args.metrics); metricClause = 'AND metric = ANY($4)'; }
  const { rows } = await db.query(
    `SELECT day::text AS day, metric, value::float AS value, detail
     FROM health_daily
     WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date ${metricClause}
     ORDER BY day, metric`,
    params,
  );
  return rows;
}

export async function dailyRangeForUser(
  db: Db, tenantId: string, userId: string,
  args: { from: string; to: string; metrics?: string[] },
): Promise<DailyRow[]> {
  const params: unknown[] = [tenantId, userId, args.from, args.to];
  let metricClause = '';
  if (args.metrics?.length) { params.push(args.metrics); metricClause = 'AND metric = ANY($5)'; }
  const { rows } = await db.query(
    `SELECT day::text AS day, metric, value::float AS value, detail
     FROM health_daily
     WHERE tenant_id = $1 AND user_id = $2 AND day BETWEEN $3::date AND $4::date ${metricClause}
     ORDER BY day, metric`,
    params,
  );
  return rows;
}

export interface HealthSubject {
  tenant_id: string;
  user_id: string;
}

export async function listHealthSubjects(db: Db): Promise<HealthSubject[]> {
  const { rows } = await db.query(
    `SELECT tenant_id, user_id
     FROM (
       SELECT tenant_id, user_id FROM health_daily
       UNION
       SELECT tenant_id, user_id FROM health_devices WHERE revoked_at IS NULL
       UNION
       SELECT tenant_id, user_id FROM health_records WHERE deleted_at IS NULL
     ) s
     WHERE tenant_id IS NOT NULL AND user_id IS NOT NULL
     ORDER BY tenant_id, user_id`,
  );
  return rows;
}

export interface HealthAnomaly {
  id: string;
  tenant_id: string;
  user_id: string;
  day: string;
  metric: string;
  severity: 'info' | 'watch' | 'warning' | 'critical';
  value: number | null;
  baseline: number | null;
  threshold: number | null;
  direction: string | null;
  summary: string;
  detail: Record<string, unknown>;
  status: 'open' | 'reviewed' | 'resolved' | 'dismissed';
  fingerprint: string;
  detected_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface UpsertHealthAnomalyArgs {
  tenantId: string;
  userId: string;
  day: string;
  metric: string;
  severity: HealthAnomaly['severity'];
  value: number | null;
  baseline: number | null;
  threshold: number | null;
  direction: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  fingerprint: string;
}

export async function upsertHealthAnomaly(db: Db, a: UpsertHealthAnomalyArgs): Promise<HealthAnomaly> {
  await ensureHealthSupportTables(db);
  const { rows } = await db.query(
    `INSERT INTO health_anomalies
       (tenant_id, user_id, day, metric, severity, value, baseline, threshold,
        direction, summary, detail, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, user_id, fingerprint) DO UPDATE SET
       severity = EXCLUDED.severity,
       value = EXCLUDED.value,
       baseline = EXCLUDED.baseline,
       threshold = EXCLUDED.threshold,
       direction = EXCLUDED.direction,
       summary = EXCLUDED.summary,
       detail = EXCLUDED.detail,
       updated_at = now(),
       status = CASE
         WHEN health_anomalies.status = 'resolved' THEN 'reviewed'
         ELSE health_anomalies.status
       END
     RETURNING id, tenant_id, user_id, day::text AS day, metric, severity,
       value::float AS value, baseline::float AS baseline, threshold::float AS threshold,
       direction, summary, detail, status, fingerprint, detected_at, updated_at, resolved_at`,
    [a.tenantId, a.userId, a.day, a.metric, a.severity, a.value, a.baseline, a.threshold,
     a.direction, a.summary, JSON.stringify(a.detail ?? {}), a.fingerprint],
  );
  return rows[0];
}

export async function listHealthAnomalies(
  db: Db, tenantId: string,
  args: { from: string; to: string; status?: string; limit: number },
): Promise<HealthAnomaly[]> {
  await ensureHealthSupportTables(db);
  const params: unknown[] = [tenantId, args.from, args.to, args.limit];
  const statusClause = args.status ? 'AND status = $5' : '';
  if (args.status) params.push(args.status);
  const { rows } = await db.query(
    `SELECT id, tenant_id, user_id, day::text AS day, metric, severity,
            value::float AS value, baseline::float AS baseline, threshold::float AS threshold,
            direction, summary, detail, status, fingerprint, detected_at, updated_at, resolved_at
     FROM health_anomalies
     WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date ${statusClause}
     ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END,
       day DESC, detected_at DESC
     LIMIT $4`,
    params,
  );
  return rows;
}

export interface HealthJournalEntry {
  id: string;
  tenant_id: string;
  user_id: string;
  entry_date: string;
  occurred_at: string | null;
  title: string | null;
  body: string;
  mood: string | null;
  energy: number | null;
  soreness: number | null;
  sleep_quality: number | null;
  tags: string[];
  related_metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listJournalEntries(
  db: Db, tenantId: string,
  args: { from: string; to: string; limit: number },
): Promise<HealthJournalEntry[]> {
  await ensureHealthSupportTables(db);
  const { rows } = await db.query(
    `SELECT id, tenant_id, user_id, entry_date::text AS entry_date, occurred_at,
            title, body, mood, energy, soreness, sleep_quality, tags, related_metrics,
            created_at, updated_at
     FROM health_journal_entries
     WHERE tenant_id = $1 AND entry_date BETWEEN $2::date AND $3::date
     ORDER BY entry_date DESC, created_at DESC
     LIMIT $4`,
    [tenantId, args.from, args.to, args.limit],
  );
  return rows;
}

export async function createJournalEntry(
  db: Db,
  args: {
    tenantId: string; userId: string; entryDate: string; occurredAt: string | null;
    title: string | null; body: string; mood: string | null;
    energy: number | null; soreness: number | null; sleepQuality: number | null;
    tags: string[]; relatedMetrics?: Record<string, unknown>;
  },
): Promise<HealthJournalEntry> {
  await ensureHealthSupportTables(db);
  const { rows } = await db.query(
    `INSERT INTO health_journal_entries
       (tenant_id, user_id, entry_date, occurred_at, title, body, mood,
        energy, soreness, sleep_quality, tags, related_metrics)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, tenant_id, user_id, entry_date::text AS entry_date, occurred_at,
       title, body, mood, energy, soreness, sleep_quality, tags, related_metrics,
       created_at, updated_at`,
    [args.tenantId, args.userId, args.entryDate, args.occurredAt, args.title, args.body, args.mood,
     args.energy, args.soreness, args.sleepQuality, args.tags, JSON.stringify(args.relatedMetrics ?? {})],
  );
  return rows[0];
}

export interface HealthMedicalRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  record_date: string;
  category: string;
  title: string;
  provider: string | null;
  facility: string | null;
  source: string | null;
  archive_only: boolean;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listMedicalRecords(
  db: Db, tenantId: string,
  args: { from: string; to: string; limit: number },
): Promise<HealthMedicalRecord[]> {
  await ensureHealthSupportTables(db);
  const { rows } = await db.query(
    `SELECT id, tenant_id, user_id, record_date::text AS record_date, category, title,
            provider, facility, source, archive_only, notes, metadata, created_at, updated_at
     FROM health_medical_records
     WHERE tenant_id = $1 AND record_date BETWEEN $2::date AND $3::date
     ORDER BY record_date DESC, created_at DESC
     LIMIT $4`,
    [tenantId, args.from, args.to, args.limit],
  );
  return rows;
}

export async function createMedicalRecord(
  db: Db,
  args: {
    tenantId: string; userId: string; recordDate: string; category: string; title: string;
    provider: string | null; facility: string | null; source: string | null; archiveOnly: boolean;
    notes: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<HealthMedicalRecord> {
  await ensureHealthSupportTables(db);
  const { rows } = await db.query(
    `INSERT INTO health_medical_records
       (tenant_id, user_id, record_date, category, title, provider, facility, source, archive_only, notes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, tenant_id, user_id, record_date::text AS record_date, category, title,
       provider, facility, source, archive_only, notes, metadata, created_at, updated_at`,
    [args.tenantId, args.userId, args.recordDate, args.category, args.title,
     args.provider, args.facility, args.source, args.archiveOnly, args.notes, JSON.stringify(args.metadata ?? {})],
  );
  return rows[0];
}

export async function recordsRange(
  db: Db, tenantId: string,
  args: { type: string; from: string; to: string; limit: number },
): Promise<RecordRow[]> {
  const { rows } = await db.query(
    `SELECT record_type, record_uid, start_ts, end_ts, day::text AS day, payload
     FROM health_records
     WHERE tenant_id = $1 AND record_type = $2
       AND day BETWEEN $3::date AND $4::date AND deleted_at IS NULL
     ORDER BY start_ts DESC LIMIT $5`,
    [tenantId, args.type, args.from, args.to, args.limit],
  );
  return rows;
}

export interface HeartRateSample {
  bpm: number;
  ts: string;
  record_start_ts: string;
  day: string;
  source_app: string | null;
}

export interface HeartRateSummary {
  current: HeartRateSample | null;
  day: string | null;
  day_low_bpm: number | null;
  day_high_bpm: number | null;
  sleeping_bpm: number | null;
  resting_awake_bpm: number | null;
  peak_bpm: number | null;
  peak_ts: string | null;
  peak_source: 'exercise' | 'daily' | null;
  peak_label: string | null;
  peak_activity_type: string | null;
  peak_activity_title: string | null;
}

export async function heartRateSummary(
  db: Db, tenantId: string,
): Promise<HeartRateSummary | null> {
  const { rows } = await db.query(
    `WITH hr_samples AS (
       SELECT
         r.day::text AS day,
         r.start_ts,
         r.source_app,
         COALESCE(NULLIF(sample->>'ts', '')::timestamptz, r.start_ts) AS sample_ts,
         (sample->>'bpm')::float AS bpm
       FROM health_records r
       CROSS JOIN LATERAL jsonb_array_elements(
         COALESCE((r.payload::jsonb)->'samples', '[]'::jsonb)
       ) sample
       WHERE r.tenant_id = $1
         AND r.record_type = 'HeartRate'
         AND r.deleted_at IS NULL
         AND sample ? 'bpm'
         AND sample->>'bpm' ~ '^[0-9]+(\\.[0-9]+)?$'
     ), latest AS (
       SELECT * FROM hr_samples ORDER BY sample_ts DESC LIMIT 1
     ), day_samples AS (
       SELECT s.* FROM hr_samples s
       JOIN latest l ON s.day = l.day
     ), latest_sleep AS (
       SELECT r.start_ts, r.end_ts
       FROM health_records r, latest l
       WHERE r.tenant_id = $1
         AND r.record_type = 'SleepSession'
         AND r.deleted_at IS NULL
         AND r.start_ts IS NOT NULL
         AND r.end_ts IS NOT NULL
         AND r.end_ts <= l.sample_ts + interval '6 hours'
       ORDER BY r.end_ts DESC
       LIMIT 1
     ), sleep_samples AS (
       SELECT s.bpm
       FROM hr_samples s
       JOIN latest_sleep sl ON s.sample_ts BETWEEN sl.start_ts AND sl.end_ts
     ), awake_samples AS (
       SELECT ds.bpm
       FROM day_samples ds
       WHERE NOT EXISTS (
         SELECT 1 FROM latest_sleep sl
         WHERE ds.sample_ts BETWEEN sl.start_ts AND sl.end_ts
       )
     ), awake_ranked AS (
       SELECT bpm, ntile(5) OVER (ORDER BY bpm ASC) AS bucket
       FROM awake_samples
     ), peak_sample AS (
       SELECT ds.*
       FROM day_samples ds
       ORDER BY ds.bpm DESC, ds.sample_ts DESC
       LIMIT 1
     ), peak_activity AS (
       SELECT
         NULLIF(e.payload::jsonb->>'exercise_type', '') AS exercise_type,
         NULLIF(e.payload::jsonb->>'title', '') AS title,
         COALESCE(
           NULLIF(e.payload::jsonb->>'title', ''),
           initcap(replace(replace(NULLIF(e.payload::jsonb->>'exercise_type', ''), '_', ' '), '-', ' '))
         ) AS label
       FROM peak_sample p
       JOIN health_records e
         ON e.tenant_id = $1
        AND e.record_type = 'ExerciseSession'
        AND e.deleted_at IS NULL
        AND e.start_ts IS NOT NULL
        AND e.end_ts IS NOT NULL
        AND p.sample_ts BETWEEN e.start_ts AND e.end_ts
       ORDER BY e.start_ts DESC
       LIMIT 1
     ), aggregates AS (
       SELECT
         (SELECT MIN(bpm)::float FROM day_samples) AS day_low_bpm,
         (SELECT MAX(bpm)::float FROM day_samples) AS day_high_bpm,
         (SELECT AVG(bpm)::float FROM sleep_samples) AS sleeping_bpm,
         (SELECT AVG(bpm)::float FROM awake_ranked WHERE bucket = 1) AS resting_awake_bpm
     )
     SELECT
       json_build_object(
         'bpm', l.bpm,
         'ts', l.sample_ts,
         'record_start_ts', l.start_ts,
         'day', l.day,
         'source_app', l.source_app
       ) AS current,
       l.day,
       a.day_low_bpm,
       a.day_high_bpm,
       a.sleeping_bpm,
       a.resting_awake_bpm,
       p.bpm AS peak_bpm,
       p.sample_ts AS peak_ts,
       CASE
         WHEN pa.label IS NOT NULL THEN 'exercise'
         WHEN p.bpm IS NOT NULL THEN 'daily'
         ELSE NULL
       END AS peak_source,
       pa.label AS peak_label,
       pa.exercise_type AS peak_activity_type,
       pa.title AS peak_activity_title
     FROM latest l
     CROSS JOIN aggregates a
     LEFT JOIN peak_sample p ON true
     LEFT JOIN peak_activity pa ON true`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export async function lastSyncAt(db: Db, tenantId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT MAX(last_seen_at) AS last FROM health_devices
     WHERE tenant_id = $1 AND revoked_at IS NULL`,
    [tenantId],
  );
  return rows[0]?.last ?? null;
}

export async function countPairedDevices(db: Db, tenantId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM health_devices
     WHERE tenant_id = $1 AND revoked_at IS NULL AND paired_at IS NOT NULL`,
    [tenantId],
  );
  return rows[0].n;
}

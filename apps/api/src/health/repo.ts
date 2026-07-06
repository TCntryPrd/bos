/**
 * All SQL for the health module lives here. No Fastify imports —
 * this file (plus service.ts) must lift cleanly into a standalone
 * service later (spec: "extraction-ready").
 */
import type pg from 'pg';
import type { DailyMetric, DailyRow, DeviceRow, RecordRow } from './types.js';

type Db = pg.Pool | pg.PoolClient;

const DEVICE_COLS =
  'id, tenant_id, user_id, name, platform, token_hash, paired_at, last_seen_at, revoked_at';

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
  records_total: number; updated_at: string;
}

export async function listDevicesWithSync(
  db: Db, tenantId: string,
): Promise<(Omit<DeviceRow, 'token_hash'> & { sync_state: DeviceSyncState[] })[]> {
  const { rows } = await db.query(
    `SELECT d.id, d.tenant_id, d.user_id, d.name, d.platform,
            d.paired_at, d.last_seen_at, d.revoked_at,
            COALESCE(
              json_agg(json_build_object(
                'record_type', s.record_type,
                'last_record_ts', s.last_record_ts,
                'records_total', s.records_total,
                'updated_at', s.updated_at
              ) ORDER BY s.record_type) FILTER (WHERE s.device_id IS NOT NULL),
              '[]'
            ) AS sync_state
     FROM health_devices d
     LEFT JOIN health_sync_state s ON s.device_id = d.id
     WHERE d.tenant_id = $1
     GROUP BY d.id
     ORDER BY d.created_at`,
    [tenantId],
  );
  return rows;
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

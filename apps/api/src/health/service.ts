import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type {
  DeviceRow, DiagnosticsBody, DiagnosticsEntry, DiagnosticsResult, IngestBody, IngestResult,
  WireRecord,
} from './types.js';
import { DIAGNOSTICS_BATCH_LIMIT, INGEST_BATCH_LIMIT, RECORD_TYPES } from './types.js';
import { localDayFor } from './day.js';
import { computeDailyMetrics } from './rollup.js';
import { publishHealthEvent } from './events.js';
import { evaluateRule, parseRules } from './thresholds.js';
import { buildBrief } from './brief.js';
import { scanHealthAnomaliesForSubject } from './monitor.js';
import {
  baselineFor, consumePairingCode, countPairedDevices, dailyForDays, dailyRange,
  findDeviceByTokenHash, heartRateSummary, insertDevice, insertPairingCode, lastSyncAt, loadThresholdConfig,
  lockUserDayForRollup, recordsForDay, recordsRange, replaceDailyMetrics, setDeviceToken,
  softDeleteRecord, touchDeviceLastSeen, upsertDiagnostics, upsertRecord, upsertSyncState,
} from './repo.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export async function mintDevice(
  pool: pg.Pool,
  args: { tenantId: string; userId: string; name: string; platform: string },
): Promise<{ device_id: string; pairing_code: string; expires_at: string }> {
  const device = await insertDevice(pool, args);
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await insertPairingCode(pool, { deviceId: device.id, codeHash: sha256(code), expiresAt });
  return { device_id: device.id, pairing_code: code, expires_at: expiresAt.toISOString() };
}

export async function pairDevice(
  pool: pg.Pool,
  code: string,
): Promise<{ device_id: string; device_token: string } | null> {
  const normalized = code.trim().toUpperCase();
  const deviceId = await consumePairingCode(pool, sha256(normalized));
  if (!deviceId) return null;
  const token = `vhd_${randomBytes(32).toString('hex')}`;
  await setDeviceToken(pool, deviceId, sha256(token));
  return { device_id: deviceId, device_token: token };
}

export async function authenticateDevice(
  pool: pg.Pool,
  bearerToken: string,
): Promise<DeviceRow | null> {
  if (!bearerToken.startsWith('vhd_')) return null;
  return findDeviceByTokenHash(pool, sha256(bearerToken));
}

const TYPE_SET = new Set<string>(RECORD_TYPES);

function validateRecord(rec: Partial<WireRecord>): string | null {
  if (!rec || typeof rec !== 'object') return 'record must be an object';
  if (!rec.uid || typeof rec.uid !== 'string') return 'uid is required';
  if (!rec.type || !TYPE_SET.has(rec.type)) return `unknown type '${String(rec.type)}'`;
  if (!rec.start || Number.isNaN(Date.parse(rec.start))) return 'start must be an ISO timestamp';
  if (rec.end && Number.isNaN(Date.parse(rec.end))) return 'end must be an ISO timestamp';
  if (!rec.deleted && (rec.payload === null || typeof rec.payload !== 'object')) {
    return 'payload must be an object';
  }
  return null;
}

/** Body-shape errors → thrown as { statusCode: 400 }; per-record errors → result.errors. */
export async function ingest(
  pool: pg.Pool,
  device: DeviceRow,
  rawBody: unknown,
): Promise<IngestResult> {
  const body = rawBody as IngestBody;
  if (!body || body.schema !== 1) throw Object.assign(new Error('schema must be 1'), { statusCode: 400 });
  if (body.device_id !== device.id) {
    throw Object.assign(new Error('device_id does not match token'), { statusCode: 400 });
  }
  if (!Array.isArray(body.records) || body.records.length > INGEST_BATCH_LIMIT) {
    throw Object.assign(new Error(`records must be an array of at most ${INGEST_BATCH_LIMIT}`), { statusCode: 400 });
  }

  const result: IngestResult = { accepted: 0, duplicates: 0, deleted: 0, errors: [] };
  const affectedDays = new Set<string>();
  const perType = new Map<string, { lastTs: string; added: number }>();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const rec of body.records) {
      const problem = validateRecord(rec);
      if (problem) {
        result.errors.push({ uid: typeof rec?.uid === 'string' ? rec.uid : '?', reason: problem });
        continue;
      }
      if (rec.deleted) {
        // Recompute the STORED row's day, not one derived from the tombstone's
        // timestamps: a delete may omit `end` (the HC change feed reports
        // deletions by UID), so e.g. a SleepSession tombstone would attribute
        // to its start day while the row was rolled up under the wake day —
        // leaving that day's rollup permanently stale.
        const deletedDay = await softDeleteRecord(client, {
          userId: device.user_id, recordType: rec.type, recordUid: rec.uid,
        });
        if (deletedDay) {
          result.deleted += 1;
          affectedDays.add(deletedDay);
        }
        continue;
      }
      const day = localDayFor(rec.type, rec.start, rec.end);
      const { status, previousDay } = await upsertRecord(client, {
        tenantId: device.tenant_id, userId: device.user_id, deviceId: device.id,
        recordType: rec.type, recordUid: rec.uid,
        startTs: rec.start, endTs: rec.end ?? null, day,
        sourceApp: rec.source_app ?? null, payload: rec.payload,
      });
      if (status === 'unchanged') { result.duplicates++; continue; }
      result.accepted++;
      affectedDays.add(day);
      // A corrected start/end can move a record to a different day: the old
      // day's rollup must also be recomputed or it keeps a phantom contribution.
      if (previousDay) affectedDays.add(previousDay);
      const agg = perType.get(rec.type) ?? { lastTs: rec.start, added: 0 };
      if (rec.start > agg.lastTs) agg.lastTs = rec.start;
      agg.added += status === 'inserted' ? 1 : 0;
      perType.set(rec.type, agg);
    }

    const metricsChanged = new Set<string>();
    // Advisory lock serializes the read-compute-replace recompute per
    // (user, day) against concurrent ingests (e.g. a device retrying a
    // timed-out batch while the original is still processing) — otherwise one
    // transaction's contribution is silently lost under READ COMMITTED.
    // Sorted iteration keeps lock acquisition order deterministic so batches
    // spanning multiple days cannot deadlock each other.
    for (const day of [...affectedDays].sort()) {
      await lockUserDayForRollup(client, device.user_id, day);
      const rows = await recordsForDay(client, device.tenant_id, device.user_id, day);
      const metrics = computeDailyMetrics(rows);
      metrics.forEach((m) => metricsChanged.add(m.metric));
      await replaceDailyMetrics(client, {
        tenantId: device.tenant_id, userId: device.user_id, day, metrics,
      });
    }
    for (const [type, agg] of perType) {
      await upsertSyncState(client, device.id, type, agg.lastTs, agg.added);
    }
    await touchDeviceLastSeen(client, device.id);
    await client.query('COMMIT');

    // Post-commit, fire-and-forget: events + thresholds.
    if (affectedDays.size > 0) {
      const days = [...affectedDays].sort();
      await publishHealthEvent('health.synced', device.tenant_id, {
        user_id: device.user_id, device_id: device.id,
        days, metrics_changed: [...metricsChanged],
        records_accepted: result.accepted, records_deleted: result.deleted,
      });
      const rules = parseRules(await loadThresholdConfig(pool, device.tenant_id));
      const daily = await dailyForDays(pool, device.tenant_id, days);
      for (const rule of rules) {
        for (const row of daily.filter((r) => r.metric === rule.metric)) {
          const baseline = 'window' in rule
            ? await baselineFor(pool, device.tenant_id, rule.metric, row.day, rule.window)
            : null;
          const breach = evaluateRule(rule, row.value, baseline);
          if (breach) {
            await publishHealthEvent('health.threshold', device.tenant_id, {
              user_id: device.user_id, date: row.day, ...breach,
            });
          }
        }
      }
      void scanHealthAnomaliesForSubject(pool, {
        tenant_id: device.tenant_id,
        user_id: device.user_id,
      }, { targetDays: days }).catch((err) => {
        console.warn(`[health-monitor] post-sync scan failed: ${String(err)}`);
      });
    }
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Body-shape errors → thrown as { statusCode: 400 }; per-entry errors are
 * skipped silently (bad entries never crash the request — spec: "skip/report-
 * error per bad entry, never crash the request"). Unknown record types and
 * malformed booleans are dropped rather than surfaced as request errors,
 * mirroring how a permissive bridge client should never be able to fail an
 * entire diagnostics batch over one unrecognized type.
 *
 * Two guarantees the DB layer depends on:
 *  - Batch size is capped (DIAGNOSTICS_BATCH_LIMIT, mirroring ingest's
 *    INGEST_BATCH_LIMIT) and rejected with 400 rather than silently accepted
 *    — a legitimate manifest never exceeds RECORD_TYPES.length entries.
 *  - Entries are de-duplicated by `type` (last one wins) before reaching
 *    upsertDiagnostics: that function builds a single multi-row
 *    `INSERT ... ON CONFLICT (device_id, record_type) DO UPDATE`, and Postgres
 *    raises 21000 if the same conflict target is hit twice in one statement.
 *    Without de-duplication here, a client bug that emits the same type twice
 *    (e.g. a naive permission-map serializer or a retried/appended partial
 *    batch) would 500 the whole request instead of being handled per-entry.
 */
export async function diagnostics(
  pool: pg.Pool,
  device: DeviceRow,
  rawBody: unknown,
): Promise<DiagnosticsResult> {
  const body = rawBody as DiagnosticsBody;
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('body must be an object'), { statusCode: 400 });
  }
  if (body.device_id !== device.id) {
    throw Object.assign(new Error('device_id does not match token'), { statusCode: 400 });
  }
  if (!Array.isArray(body.entries) || body.entries.length > DIAGNOSTICS_BATCH_LIMIT) {
    throw Object.assign(
      new Error(`entries must be an array of at most ${DIAGNOSTICS_BATCH_LIMIT}`),
      { statusCode: 400 },
    );
  }

  const valid = body.entries.filter((e) => (
    e && typeof e === 'object'
    && typeof e.type === 'string' && TYPE_SET.has(e.type)
    && typeof e.granted === 'boolean'
    && typeof e.hasLocalData === 'boolean'
  ));

  // De-dupe by type, keeping the last entry for a given type — consistent
  // with the "current snapshot" semantics documented on upsertDiagnostics.
  const byType = new Map<string, DiagnosticsEntry>();
  for (const e of valid) byType.set(e.type, e);
  const deduped = [...byType.values()];

  const accepted = await upsertDiagnostics(pool, device.id, deduped);
  return { ok: true, accepted };
}

/** Today in the health timezone. VASARI_HEALTH_TODAY_OVERRIDE exists for deterministic tests. */
export function healthToday(): string {
  const override = process.env.VASARI_HEALTH_TODAY_OVERRIDE;
  if (override) return override;
  const tz = process.env.VASARI_HEALTH_TZ ?? 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function lastNDays(n: number, endDay: string): string[] {
  const end = new Date(`${endDay}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

const SPARK_METRICS = ['steps', 'sleep_minutes', 'resting_hr', 'active_kcal'] as const;

export async function overview(pool: pg.Pool, tenantId: string) {
  const today = healthToday();
  const days = lastNDays(7, today);
  const [paired, last, rows, heartRate] = await Promise.all([
    countPairedDevices(pool, tenantId),
    lastSyncAt(pool, tenantId),
    dailyRange(pool, tenantId, { from: days[0], to: today }),
    heartRateSummary(pool, tenantId),
  ]);

  const todayMetrics: Record<string, number> = {};
  let sleepDetail: Record<string, unknown> | null = null;
  for (const row of rows) {
    if (row.day !== today) continue;
    todayMetrics[row.metric] = row.value;
    if (row.metric === 'sleep_minutes') sleepDetail = row.detail as Record<string, unknown>;
  }

  const spark: Record<string, number[]> = {};
  for (const metric of SPARK_METRICS) {
    spark[metric] = days.map(
      (d) => rows.find((r) => r.day === d && r.metric === metric)?.value ?? 0);
  }

  return {
    paired: paired > 0,
    last_sync_at: last,
    today: todayMetrics,
    spark,
    heart_rate: heartRate,
    sleep_detail: sleepDetail,
  };
}

export async function summary(pool: pg.Pool, tenantId: string, date: string) {
  const rows = await dailyRange(pool, tenantId, { from: date, to: date });
  const metrics: Record<string, { value: number; detail: unknown }> = {};
  for (const r of rows) metrics[r.metric] = { value: r.value, detail: r.detail };
  const workouts =
    ((metrics.exercise_minutes?.detail as { sessions?: unknown[] })?.sessions) ?? [];
  return {
    date,
    metrics,
    workouts,
    sleep: (metrics.sleep_minutes?.detail as Record<string, unknown>) ?? null,
  };
}

export async function briefText(pool: pg.Pool, tenantId: string, windowDays: number) {
  const today = healthToday();
  const days = lastNDays(windowDays, today);
  const rows = await dailyRange(pool, tenantId, { from: days[0], to: today });
  return { brief: buildBrief(rows, today), window_days: windowDays };
}

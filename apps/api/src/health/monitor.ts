import type pg from 'pg';
import { getPool } from '../db.js';
import { publishHealthEvent } from './events.js';
import {
  dailyRangeForUser, ensureHealthSupportTables, listHealthSubjects, upsertHealthAnomaly,
} from './repo.js';
import type { DailyRow } from './types.js';
import type { HealthAnomaly, HealthSubject } from './repo.js';

type Severity = HealthAnomaly['severity'];

const BASELINE_DAYS = 30;
const DEFAULT_SCAN_DAYS = 7;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const WATCH_METRICS = [
  'sleep_minutes', 'hr_avg', 'hr_max', 'hrv_rmssd', 'spo2_avg',
  'steps', 'active_kcal', 'exercise_minutes',
];

let monitorTimer: NodeJS.Timeout | null = null;

function healthToday(): string {
  const override = process.env.VASARI_HEALTH_TODAY_OVERRIDE;
  if (override) return override;
  const tz = process.env.VASARI_HEALTH_TZ ?? 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateNDaysAgo(n: number, fromDay = healthToday()): string {
  const d = new Date(`${fromDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

function byDay(rows: DailyRow[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let day = out.get(r.day);
    if (!day) {
      day = new Map<string, number>();
      out.set(r.day, day);
    }
    day.set(r.metric, r.value);
  }
  return out;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function baseline(rows: DailyRow[], metric: string, day: string): number | null {
  const start = dateNDaysAgo(BASELINE_DAYS, day);
  return mean(rows
    .filter((r) => r.metric === metric && r.day < day && r.day >= start)
    .map((r) => r.value));
}

function anomalyFingerprint(day: string, metric: string, summary: string): string {
  return `${day}:${metric}:${summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

async function saveFinding(
  pool: pg.Pool,
  subject: HealthSubject,
  finding: {
    day: string; metric: string; severity: Severity; value: number | null;
    baseline: number | null; threshold: number | null; direction: string | null;
    summary: string; detail?: Record<string, unknown>;
  },
): Promise<HealthAnomaly> {
  const row = await upsertHealthAnomaly(pool, {
    tenantId: subject.tenant_id,
    userId: subject.user_id,
    day: finding.day,
    metric: finding.metric,
    severity: finding.severity,
    value: round1(finding.value),
    baseline: round1(finding.baseline),
    threshold: round1(finding.threshold),
    direction: finding.direction,
    summary: finding.summary,
    detail: finding.detail,
    fingerprint: anomalyFingerprint(finding.day, finding.metric, finding.summary),
  });
  if (Math.abs(Date.parse(row.updated_at) - Date.parse(row.detected_at)) < 1000) {
    await publishHealthEvent('health.anomaly', subject.tenant_id, {
      user_id: subject.user_id,
      day: row.day,
      metric: row.metric,
      severity: row.severity,
      value: row.value,
      baseline: row.baseline,
      threshold: row.threshold,
      direction: row.direction,
      summary: row.summary,
    });
  }
  return row;
}

export async function scanHealthAnomaliesForSubject(
  pool: pg.Pool,
  subject: HealthSubject,
  args: { days?: number; targetDays?: string[] } = {},
): Promise<HealthAnomaly[]> {
  await ensureHealthSupportTables(pool);
  const today = healthToday();
  const days = Math.min(Math.max(args.days ?? DEFAULT_SCAN_DAYS, 1), 90);
  const from = dateNDaysAgo(BASELINE_DAYS + days, today);
  const rows = await dailyRangeForUser(pool, subject.tenant_id, subject.user_id, {
    from, to: today, metrics: WATCH_METRICS,
  });
  const grouped = byDay(rows);
  const targetDays = (args.targetDays?.length
    ? [...new Set(args.targetDays)].sort()
    : [...grouped.keys()].filter((d) => d >= dateNDaysAgo(days - 1, today)).sort());

  const findings: HealthAnomaly[] = [];
  for (const day of targetDays) {
    const metrics = grouped.get(day);
    if (!metrics) continue;

    const sleep = metrics.get('sleep_minutes') ?? null;
    const sleepBase = baseline(rows, 'sleep_minutes', day);
    if (sleep !== null && sleep < 360) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'sleep_minutes', severity: sleep < 240 ? 'critical' : 'warning',
        value: sleep, baseline: sleepBase, threshold: 360, direction: 'below',
        summary: 'Sleep below recovery target',
        detail: { target_minutes: 360, baseline_window_days: BASELINE_DAYS },
      }));
    } else if (sleep !== null && sleepBase !== null && sleepBase >= 360 && sleep < sleepBase - 90) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'sleep_minutes', severity: 'watch',
        value: sleep, baseline: sleepBase, threshold: sleepBase - 90, direction: 'below',
        summary: 'Sleep dropped below personal baseline',
        detail: { baseline_window_days: BASELINE_DAYS },
      }));
    }

    const hrv = metrics.get('hrv_rmssd') ?? null;
    const hrvBase = baseline(rows, 'hrv_rmssd', day);
    if (hrv !== null && hrvBase !== null && hrvBase >= 20 && hrv < hrvBase * 0.75) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'hrv_rmssd', severity: 'watch',
        value: hrv, baseline: hrvBase, threshold: hrvBase * 0.75, direction: 'below',
        summary: 'HRV below personal baseline',
        detail: { baseline_window_days: BASELINE_DAYS },
      }));
    }

    const spo2 = metrics.get('spo2_avg') ?? null;
    if (spo2 !== null && spo2 < 95) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'spo2_avg', severity: spo2 < 92 ? 'critical' : 'warning',
        value: spo2, baseline: baseline(rows, 'spo2_avg', day), threshold: 95, direction: 'below',
        summary: 'Oxygen saturation below normal range',
        detail: { fixed_threshold: true },
      }));
    }

    const hrAvg = metrics.get('hr_avg') ?? null;
    const hrAvgBase = baseline(rows, 'hr_avg', day);
    if (hrAvg !== null && hrAvgBase !== null && hrAvg > 85 && hrAvg > hrAvgBase + 10) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'hr_avg', severity: 'watch',
        value: hrAvg, baseline: hrAvgBase, threshold: hrAvgBase + 10, direction: 'above',
        summary: 'Average heart rate above personal baseline',
        detail: { baseline_window_days: BASELINE_DAYS },
      }));
    }

    const hrMax = metrics.get('hr_max') ?? null;
    const exercise = metrics.get('exercise_minutes') ?? 0;
    if (hrMax !== null && exercise <= 0 && hrMax >= 130) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'hr_max', severity: hrMax >= 160 ? 'warning' : 'watch',
        value: hrMax, baseline: baseline(rows, 'hr_max', day), threshold: 130, direction: 'above',
        summary: 'High heart-rate peak without recorded exercise',
        detail: { exercise_minutes: exercise },
      }));
    }

    const steps = metrics.get('steps') ?? null;
    const stepsBase = baseline(rows, 'steps', day);
    if (steps !== null && stepsBase !== null && stepsBase >= 2000 && steps < stepsBase * 0.4) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'steps', severity: 'watch',
        value: steps, baseline: stepsBase, threshold: stepsBase * 0.4, direction: 'below',
        summary: 'Movement sharply below personal baseline',
        detail: { baseline_window_days: BASELINE_DAYS },
      }));
    }

    const active = metrics.get('active_kcal') ?? null;
    const activeBase = baseline(rows, 'active_kcal', day);
    if (active !== null && activeBase !== null && activeBase >= 200 && active < activeBase * 0.4) {
      findings.push(await saveFinding(pool, subject, {
        day, metric: 'active_kcal', severity: 'watch',
        value: active, baseline: activeBase, threshold: activeBase * 0.4, direction: 'below',
        summary: 'Active energy sharply below personal baseline',
        detail: { baseline_window_days: BASELINE_DAYS },
      }));
    }
  }
  return findings;
}

export async function scanHealthAnomalies(
  pool: pg.Pool = getPool(),
  args: { days?: number } = {},
): Promise<HealthAnomaly[]> {
  await ensureHealthSupportTables(pool);
  const subjects = await listHealthSubjects(pool);
  const all: HealthAnomaly[] = [];
  for (const subject of subjects) {
    try {
      all.push(...await scanHealthAnomaliesForSubject(pool, subject, args));
    } catch (err) {
      console.warn(`[health-monitor] scan failed for ${subject.tenant_id}/${subject.user_id}: ${String(err)}`);
    }
  }
  return all;
}

export function startHealthMonitor(): void {
  if (monitorTimer) return;
  if (process.env.HEALTH_MONITOR_ENABLED === 'false') {
    console.log('[health-monitor] disabled by HEALTH_MONITOR_ENABLED=false');
    return;
  }
  const interval = Math.max(Number(process.env.HEALTH_MONITOR_INTERVAL_MS ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS, 60_000);
  const run = () => {
    void scanHealthAnomalies(getPool(), { days: DEFAULT_SCAN_DAYS })
      .then((rows) => console.log(`[health-monitor] scan complete (${rows.length} finding updates)`))
      .catch((err) => console.warn(`[health-monitor] scan failed: ${String(err)}`));
  };
  monitorTimer = setInterval(run, interval);
  monitorTimer.unref?.();
  setTimeout(run, 10_000).unref?.();
  console.log(`[health-monitor] started (${Math.round(interval / 60000)} min interval)`);
}

export function stopHealthMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

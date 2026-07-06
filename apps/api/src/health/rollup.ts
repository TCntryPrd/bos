import type { DailyMetric, RecordRow } from './types.js';

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const minutesBetween = (a: string, b: string): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);

function sum(records: RecordRow[], type: string, key: string): number | null {
  let total = 0; let seen = false;
  for (const r of records) {
    if (r.record_type !== type) continue;
    const v = num(r.payload[key]);
    if (v !== null) { total += v; seen = true; }
  }
  return seen ? total : null;
}

/**
 * Latest record (by start_ts) of a point-in-time type.
 * start_ts values carry the device's own zone offset (e.g. 2026-07-01T23:30:00-04:00),
 * so they must be compared chronologically (by real instant), not as raw strings —
 * string comparison sorts by lexical offset digits, not elapsed time, and can pick the
 * chronologically older reading when offsets differ (DST changes, traveling devices).
 */
function latest(records: RecordRow[], type: string): RecordRow | null {
  let best: RecordRow | null = null;
  let bestMs = -Infinity;
  for (const r of records) {
    if (r.record_type !== type) continue;
    const ms = new Date(r.start_ts).getTime();
    if (!best || ms > bestMs) { best = r; bestMs = ms; }
  }
  return best;
}

function avg(records: RecordRow[], type: string, key: string): number | null {
  const vals: number[] = [];
  for (const r of records) {
    if (r.record_type !== type) continue;
    const v = num(r.payload[key]);
    if (v !== null) vals.push(v);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

interface SleepStage { stage: string; start: string; end: string }

export function computeDailyMetrics(records: RecordRow[]): DailyMetric[] {
  const out: DailyMetric[] = [];
  const push = (metric: string, value: number | null, detail: Record<string, unknown> = {}) => {
    if (value !== null) out.push({ metric, value, detail });
  };

  push('steps', sum(records, 'Steps', 'count'));
  push('distance_m', sum(records, 'Distance', 'meters'));
  push('floors', sum(records, 'FloorsClimbed', 'floors'));
  push('active_kcal', sum(records, 'ActiveCaloriesBurned', 'kcal'));
  push('total_kcal', sum(records, 'TotalCaloriesBurned', 'kcal'));
  push('hydration_ml', sum(records, 'Hydration', 'ml'));
  push('nutrition_kcal', sum(records, 'Nutrition', 'kcal'));

  const sessions = records.filter((r) => r.record_type === 'ExerciseSession' && r.end_ts);
  if (sessions.length) {
    const detail = sessions.map((s) => ({
      exercise_type: (s.payload.exercise_type as string) ?? 'unknown',
      title: (s.payload.title as string) ?? null,
      start: s.start_ts,
      minutes: minutesBetween(s.start_ts, s.end_ts as string),
      kcal: num(s.payload.kcal),
      avg_hr: num(s.payload.avg_hr),
      max_hr: num(s.payload.max_hr),
    }));
    push('exercise_minutes', detail.reduce((a, s) => a + s.minutes, 0), { sessions: detail });
  }

  // Longest sleep session of the day wins (naps are in detail.sessions count).
  const sleeps = records.filter((r) => r.record_type === 'SleepSession' && r.end_ts);
  if (sleeps.length) {
    const scored = sleeps.map((s) => {
      const stages = (Array.isArray(s.payload.stages) ? s.payload.stages : []) as SleepStage[];
      const byStage: Record<string, number> = { awake: 0, light: 0, deep: 0, rem: 0 };
      for (const st of stages) {
        if (st.stage in byStage) byStage[st.stage] += minutesBetween(st.start, st.end);
      }
      const asleep = byStage.light + byStage.deep + byStage.rem ||
        minutesBetween(s.start_ts, s.end_ts as string);
      return { s, byStage, asleep };
    });
    scored.sort((a, b) => b.asleep - a.asleep);
    const main = scored[0];
    push('sleep_minutes', main.asleep, {
      start: main.s.start_ts, end: main.s.end_ts,
      stages: main.byStage, sessions: sleeps.length,
    });
  }

  const hrSamples: number[] = [];
  for (const r of records) {
    if (r.record_type !== 'HeartRate') continue;
    const samples = Array.isArray(r.payload.samples) ? r.payload.samples : [];
    for (const s of samples as { bpm?: unknown }[]) {
      const v = num(s.bpm);
      if (v !== null) hrSamples.push(v);
    }
  }
  if (hrSamples.length) {
    push('hr_min', Math.min(...hrSamples));
    push('hr_max', Math.max(...hrSamples));
    push('hr_avg', Math.round(hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length));
  }

  push('resting_hr', num(latest(records, 'RestingHeartRate')?.payload.bpm ?? null));
  push('hrv_rmssd', avg(records, 'HeartRateVariabilityRmssd', 'ms'));
  push('spo2_avg', avg(records, 'OxygenSaturation', 'pct'));
  push('respiratory_rate_avg', avg(records, 'RespiratoryRate', 'rpm'));

  const bp = latest(records, 'BloodPressure');
  push('bp_systolic', num(bp?.payload.systolic ?? null));
  push('bp_diastolic', num(bp?.payload.diastolic ?? null));
  push('body_temp_c', num(latest(records, 'BodyTemperature')?.payload.celsius ?? null));
  push('weight_kg', num(latest(records, 'Weight')?.payload.kg ?? null));
  push('body_fat_pct', num(latest(records, 'BodyFat')?.payload.pct ?? null));
  push('lean_mass_kg', num(latest(records, 'LeanBodyMass')?.payload.kg ?? null));
  push('bmr_kcal', num(latest(records, 'BasalMetabolicRate')?.payload.kcal_per_day ?? null));

  return out;
}

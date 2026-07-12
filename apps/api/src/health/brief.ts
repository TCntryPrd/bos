import type { DailyRow } from './types.js';

const hm = (mins: number): string => `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Adds (or subtracts) whole calendar days to a `YYYY-MM-DD` string, in UTC to avoid DST drift. */
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function pick(rows: DailyRow[], day: string, metric: string): DailyRow | undefined {
  return rows.find((r) => r.day === day && r.metric === metric);
}

function series(rows: DailyRow[], metric: string): DailyRow[] {
  return rows.filter((r) => r.metric === metric).sort((a, b) => a.day.localeCompare(b.day));
}

/** Template-based digest of the trailing window ending at `today`. No LLM in this path. */
export function buildBrief(rows: DailyRow[], today: string): string {
  if (!rows.length) {
    return 'No health data yet. Pair a device on the Health page to start syncing.';
  }
  const parts: string[] = [];

  const sleep = pick(rows, today, 'sleep_minutes');
  if (sleep) {
    const stages = (sleep.detail as { stages?: Record<string, number> }).stages;
    const deep = stages?.deep;
    parts.push(
      `Last night: ${hm(sleep.value)} of sleep${deep != null ? ` (${hm(deep)} deep)` : ''}.`,
    );
  }

  const sleepByDay = new Map(series(rows, 'sleep_minutes').map((r) => [r.day, r.value]));
  let streakLen = 0;
  let cursor = today;
  for (;;) {
    const value = sleepByDay.get(cursor);
    if (value === undefined || value >= 360) break;
    streakLen += 1;
    cursor = addDays(cursor, -1);
  }
  if (streakLen >= 3) parts.push(`Sleep has been under 6h for ${streakLen} nights running.`);

  const steps = pick(rows, today, 'steps');
  if (steps) {
    const all = series(rows, 'steps').filter((r) => r.day !== today);
    const avgSteps = all.length ? all.reduce((a, r) => a + r.value, 0) / all.length : null;
    parts.push(
      `Today: ${fmtInt(steps.value)} steps${avgSteps != null ? ` (recent average ${fmtInt(avgSteps)})` : ''}.`,
    );
  }

  const rhr = pick(rows, today, 'resting_hr');
  if (rhr) parts.push(`Current resting heart rate ${Math.round(rhr.value)} bpm.`);

  const workouts = series(rows, 'exercise_minutes');
  if (workouts.length) {
    const count = workouts.reduce(
      (a, r) => a + (((r.detail as { sessions?: unknown[] }).sessions?.length) ?? 1), 0);
    const mins = workouts.reduce((a, r) => a + r.value, 0);
    parts.push(`${count} workout${count === 1 ? '' : 's'} in the window totaling ${hm(mins)}.`);
  }

  const weights = series(rows, 'weight_kg');
  if (weights.length >= 2) {
    const delta = weights[weights.length - 1].value - weights[0].value;
    if (Math.abs(delta) >= 0.2) {
      parts.push(`Weight ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} kg over the window.`);
    }
  }

  return parts.length ? parts.join(' ') : 'Health data is syncing but nothing notable in this window.';
}

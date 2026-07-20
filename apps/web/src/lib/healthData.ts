/**
 * Health data client + pure shaping utilities for the Health tile and page.
 * Self-contained on purpose (spec: extraction-ready): talks to /api/health/*
 * with the standard boss_token bearer, dispatches boss-auth-expired on 401.
 * Pure functions below the API section are unit-tested in node (no DOM).
 */

export type RangeKey = 'today' | '7d' | '30d' | '90d';

export interface DailyRow {
  day: string;
  metric: string;
  value: number;
  detail: Record<string, unknown>;
}

export interface SleepDetail {
  start: string;
  end: string;
  stages: { awake: number; light: number; deep: number; rem: number };
  sessions: number;
}

export interface WorkoutSession {
  exercise_type: string;
  title: string | null;
  start: string;
  minutes: number;
  kcal: number | null;
  avg_hr: number | null;
  max_hr: number | null;
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

export interface HealthOverview {
  paired: boolean;
  last_sync_at: string | null;
  today: Record<string, number>;
  spark: { steps: number[]; sleep_minutes: number[]; resting_hr: number[]; active_kcal: number[] };
  heart_rate: HeartRateSummary | null;
  sleep_detail: SleepDetail | null;
}

export interface DeviceSyncState {
  record_type: string;
  last_record_ts: string | null;
  records_total: number | null;
  updated_at: string | null;
  /**
   * Diagnostics snapshot from the bridge's Health Connect probe (spec:
   * 2026-07-06-health-diagnostics-design). Both null when the device has
   * never reported diagnostics for this type (pre-upgrade bridge, or a type
   * that has only synced records and no diagnostics row yet).
   */
  granted: boolean | null;
  has_local_data: boolean | null;
}

export interface HealthDevice {
  id: string;
  name: string;
  platform: 'android' | 'ios';
  paired_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  sync_state: DeviceSyncState[];
}

export interface HealthAnomaly {
  id: string;
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
  detected_at: string;
  updated_at: string;
}

export interface HealthJournalEntry {
  id: string;
  entry_date: string;
  occurred_at: string | null;
  title: string | null;
  body: string;
  mood: string | null;
  energy: number | null;
  soreness: number | null;
  sleep_quality: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface HealthMedicalRecord {
  id: string;
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

export const HEALTH_COLORS = {
  activity: '#20B26B',
  sleepDeep: '#534AB7',
  sleepLight: '#AFA9EC',
  sleepRem: '#D4537E',
  sleepAwake: '#F9B000',
  heart: '#FF4D8D',
  body: '#0EA5E9',
} as const;

async function hfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('boss_token') ?? '';
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`/api/health${path}`, { ...init, headers });
  if (res.status === 401) {
    try { window.dispatchEvent(new Event('boss-auth-expired')); } catch { /* noop */ }
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const healthDataApi = {
  overview: () => hfetch<HealthOverview>('/overview'),
  daily: (from: string, to: string, metrics?: string[]) =>
    hfetch<{ days: DailyRow[] }>(
      `/daily?from=${from}&to=${to}${metrics?.length ? `&metrics=${metrics.join(',')}` : ''}`),
  records: (type: string, from: string, to: string, limit = 100) =>
    hfetch<{ records: { record_type: string; start_ts: string; end_ts: string | null;
      day: string; payload: Record<string, unknown> }[] }>(
      `/records?type=${type}&from=${from}&to=${to}&limit=${limit}`),
  devices: () => hfetch<{ devices: HealthDevice[] }>('/devices'),
  mintDevice: (name: string, platform: 'android' | 'ios') =>
    hfetch<{ device_id: string; pairing_code: string; expires_at: string }>(
      '/devices', { method: 'POST', body: JSON.stringify({ name, platform }) }),
  revokeDevice: (id: string) =>
    hfetch<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE' }),
  anomalies: (from: string, to: string, status = 'open', limit = 100) =>
    hfetch<{ anomalies: HealthAnomaly[] }>(
      `/anomalies?from=${from}&to=${to}&status=${status}&limit=${limit}`),
  scanAnomalies: (days = 7) =>
    hfetch<{ anomalies: HealthAnomaly[]; scanned_days: number }>(
      '/anomalies/scan', { method: 'POST', body: JSON.stringify({ days }) }),
  journal: (from: string, to: string, limit = 100) =>
    hfetch<{ entries: HealthJournalEntry[] }>(`/journal?from=${from}&to=${to}&limit=${limit}`),
  createJournal: (body: Partial<HealthJournalEntry> & { body: string; entry_date?: string }) =>
    hfetch<{ entry: HealthJournalEntry }>('/journal', { method: 'POST', body: JSON.stringify(body) }),
  medicalRecords: (from: string, to: string, limit = 100) =>
    hfetch<{ records: HealthMedicalRecord[] }>(`/medical-records?from=${from}&to=${to}&limit=${limit}`),
  createMedicalRecord: (body: Partial<HealthMedicalRecord> & { title: string; record_date?: string }) =>
    hfetch<{ record: HealthMedicalRecord }>('/medical-records', { method: 'POST', body: JSON.stringify(body) }),
};

export function fmtHm(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function kgToLb(kg: number): number {
  return kg * 2.2046226218;
}

export function cmToFeetIn(cm: number): { feet: number; inches: number } {
  const totalInches = Math.round(cm / 2.54);
  return { feet: Math.floor(totalInches / 12), inches: totalInches % 12 };
}

export function cToF(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

export function fmtLb(kg: number): string {
  return kgToLb(kg).toFixed(1);
}

export function fmtFeetIn(cm: number): string {
  const { feet, inches } = cmToFeetIn(cm);
  return `${feet}'${inches}"`;
}

export function fmtF(celsius: number): string {
  return `${Math.round(cToF(celsius))}`;
}

export function rangeToDays(range: RangeKey): number {
  return { today: 1, '7d': 7, '30d': 30, '90d': 90 }[range];
}

/** YYYY-MM-DD for n days before `from` (local time). */
export function dateNDaysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function latestByMetric(rows: DailyRow[]): Map<string, DailyRow> {
  const out = new Map<string, DailyRow>();
  for (const r of rows) {
    const cur = out.get(r.metric);
    if (!cur || r.day > cur.day) out.set(r.metric, r);
  }
  return out;
}

export function seriesFor(rows: DailyRow[], metric: string): DailyRow[] {
  return rows.filter((r) => r.metric === metric).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Percent change: mean of rows in the current window (day >= windowStart) vs
 * mean of rows in the previous window (prevStart <= day < windowStart).
 * Windows are bounded by date, not row count, so missing/unsynced days and
 * sparse metrics (e.g. weight_kg) never leak previous-window rows into the
 * current mean. Dates are YYYY-MM-DD strings (lexicographic order = date order).
 */
export function deltaVsPrev(
  rows: DailyRow[], metric: string, windowStart: string, prevStart: string,
): number | null {
  const s = seriesFor(rows, metric);
  const cur = s.filter((r) => r.day >= windowStart);
  const prev = s.filter((r) => r.day >= prevStart && r.day < windowStart);
  if (!cur.length || !prev.length) return null;
  const mean = (xs: DailyRow[]) => xs.reduce((a, r) => a + r.value, 0) / xs.length;
  const prevMean = mean(prev);
  if (prevMean === 0) return null;
  return Math.round(((mean(cur) - prevMean) / prevMean) * 100);
}

/** SVG polyline points for a mini sparkline. Empty input → ''. Flat data → midline. */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values
    .map((v, i) => `${Math.round(i * step * 10) / 10},${Math.round((h - 2 - ((v - min) / span) * (h - 4)) * 10) / 10}`)
    .join(' ');
}

export function sleepStagePcts(detail: SleepDetail): { deep: number; light: number; rem: number; awake: number } {
  const { deep, light, rem, awake } = detail.stages;
  const total = deep + light + rem + awake || 1;
  return {
    deep: (deep / total) * 100,
    light: (light / total) * 100,
    rem: (rem / total) * 100,
    awake: (awake / total) * 100,
  };
}

export function workoutsFrom(rows: DailyRow[]): WorkoutSession[] {
  const out: WorkoutSession[] = [];
  for (const r of rows) {
    if (r.metric !== 'exercise_minutes') continue;
    const sessions = (r.detail as { sessions?: WorkoutSession[] }).sessions ?? [];
    out.push(...sessions);
  }
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

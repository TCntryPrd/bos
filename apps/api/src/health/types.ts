/**
 * Wire contract between bridge apps (Android now, iOS later) and /api/health/ingest.
 * Payload shapes per record type (the bridge's normalizer and the seed script both follow this):
 *   Steps {count}  Distance {meters}  FloorsClimbed {floors}
 *   ActiveCaloriesBurned {kcal}  TotalCaloriesBurned {kcal}
 *   ExerciseSession {exercise_type, title?, kcal?, avg_hr?, max_hr?}
 *   HeartRate {samples: [{ts, bpm}]}  RestingHeartRate {bpm}
 *   HeartRateVariabilityRmssd {ms}
 *   SleepSession {stages: [{stage: 'awake'|'light'|'deep'|'rem', start, end}]}
 *   OxygenSaturation {pct}  RespiratoryRate {rpm}
 *   BloodPressure {systolic, diastolic}  BodyTemperature {celsius}
 *   Weight {kg}  BodyFat {pct}  LeanBodyMass {kg}  BasalMetabolicRate {kcal_per_day}
 *   Hydration {ml}  Nutrition {kcal, protein_g?, carbs_g?, fat_g?}
 * Timestamps are ISO-8601 WITH the device's zone offset (e.g. 2026-07-01T23:30:00-04:00).
 */

export const RECORD_TYPES = [
  'Steps', 'Distance', 'FloorsClimbed', 'ActiveCaloriesBurned', 'TotalCaloriesBurned',
  'ExerciseSession', 'HeartRate', 'RestingHeartRate', 'HeartRateVariabilityRmssd',
  'SleepSession', 'OxygenSaturation', 'RespiratoryRate', 'BloodPressure',
  'BodyTemperature', 'Weight', 'BodyFat', 'LeanBodyMass', 'BasalMetabolicRate',
  'Hydration', 'Nutrition',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export interface WireRecord {
  uid: string;
  type: RecordType;
  start: string;
  end?: string;
  source_app?: string;
  deleted?: boolean;
  payload: Record<string, unknown>;
}

export interface IngestBody {
  schema: 1;
  device_id: string;
  records: WireRecord[];
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  deleted: number;
  errors: { uid: string; reason: string }[];
}

export interface DeviceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  platform: 'android' | 'ios';
  token_hash: string | null;
  paired_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface RecordRow {
  record_type: RecordType;
  record_uid: string;
  start_ts: string;
  end_ts: string | null;
  day: string;
  payload: Record<string, unknown>;
}

export interface DailyMetric {
  metric: string;
  value: number;
  detail: Record<string, unknown>;
}

export interface DailyRow extends DailyMetric {
  day: string;
}

export const INGEST_BATCH_LIMIT = 1000;

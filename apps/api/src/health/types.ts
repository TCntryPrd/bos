/**
 * Wire contract between bridge apps (Android now, iOS later) and /api/health/ingest.
 * Payload shapes per record type (the bridge's normalizer and the seed script both follow this):
 *   Steps {count}  StepsCadence {samples}  Distance {meters}
 *   FloorsClimbed {floors}  ElevationGained {meters}
 *   ActiveCaloriesBurned {kcal}  TotalCaloriesBurned {kcal}
 *   ActivityIntensity {activity_intensity_type, activity_intensity_type_code}
 *   ExerciseSession {exercise_type, title?, notes?, segments?, laps?, route?}
 *   CyclingPedalingCadence {samples}  Power {samples}  Speed {samples}
 *   Vo2Max {ml_per_min_per_kg}  WheelchairPushes {count}
 *   PlannedExerciseSession {exercise_type, blocks}
 *   HeartRate {samples: [{ts, bpm}]}  RestingHeartRate {bpm}
 *   HeartRateVariabilityRmssd {ms}
 *   SleepSession {stages: [{stage: 'awake'|'light'|'deep'|'rem', start, end}]}
 *   OxygenSaturation {pct}  RespiratoryRate {rpm}
 *   BloodPressure {systolic, diastolic}  BloodGlucose {mg_per_dl, mmol_per_l}
 *   BodyTemperature {celsius}  BasalBodyTemperature {celsius}
 *   SkinTemperature {baseline_celsius?, deltas}
 *   Weight {kg}  Height {meters}  BodyFat {pct}  BodyWaterMass {kg}
 *   BoneMass {kg}  LeanBodyMass {kg}  BasalMetabolicRate {kcal_per_day}
 *   Hydration {ml}  Nutrition {kcal, protein_g?, carbs_g?, fat_g?}
 *   CervicalMucus, IntermenstrualBleeding, MenstruationFlow,
 *   MenstruationPeriod, OvulationTest, SexualActivity, MindfulnessSession
 *   MedicalResource {medical_resource_type, data_source_id, fhir_version, fhir_json|fhir_raw}
 * Timestamps are ISO-8601 WITH the device's zone offset (e.g. 2026-07-01T23:30:00-04:00).
 */

export const RECORD_TYPES = [
  'Steps', 'StepsCadence', 'Distance', 'FloorsClimbed', 'ElevationGained',
  'ActiveCaloriesBurned', 'TotalCaloriesBurned', 'ActivityIntensity', 'ExerciseSession',
  'CyclingPedalingCadence', 'Power', 'Speed', 'Vo2Max', 'WheelchairPushes',
  'PlannedExerciseSession', 'HeartRate', 'RestingHeartRate', 'HeartRateVariabilityRmssd',
  'SleepSession', 'OxygenSaturation', 'RespiratoryRate', 'BloodPressure', 'BloodGlucose',
  'BodyTemperature', 'BasalBodyTemperature', 'SkinTemperature', 'Weight', 'Height',
  'BodyFat', 'BodyWaterMass', 'BoneMass', 'LeanBodyMass', 'BasalMetabolicRate',
  'Hydration', 'Nutrition', 'CervicalMucus', 'IntermenstrualBleeding',
  'MenstruationFlow', 'MenstruationPeriod', 'OvulationTest', 'SexualActivity',
  'MindfulnessSession', 'MedicalResource',
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
export const DIAGNOSTICS_BATCH_LIMIT = 1000;

/** POST /api/health/diagnostics wire contract (spec 2026-07-06-health-diagnostics-design). */
export interface DiagnosticsEntry {
  type: string;
  granted: boolean;
  hasLocalData: boolean;
}

export interface DiagnosticsBody {
  device_id: string;
  entries: DiagnosticsEntry[];
}

export interface DiagnosticsResult {
  ok: true;
  accepted: number;
}

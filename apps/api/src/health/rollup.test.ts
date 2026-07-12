import { describe, it, expect } from 'vitest';
import { computeDailyMetrics } from './rollup.js';
import type { RecordRow } from './types.js';

function rec(partial: Partial<RecordRow> & { record_type: RecordRow['record_type'] }): RecordRow {
  return {
    record_uid: Math.random().toString(36).slice(2),
    start_ts: '2026-07-01T08:00:00-04:00',
    end_ts: null,
    day: '2026-07-01',
    payload: {},
    ...partial,
  };
}

function metric(list: ReturnType<typeof computeDailyMetrics>, name: string) {
  return list.find((m) => m.metric === name);
}

describe('computeDailyMetrics', () => {
  it('sums steps across records', () => {
    const out = computeDailyMetrics([
      rec({ record_type: 'Steps', payload: { count: 4000 } }),
      rec({ record_type: 'Steps', payload: { count: 7432 } }),
    ]);
    expect(metric(out, 'steps')?.value).toBe(11432);
  });

  it('computes sleep minutes excluding awake, with stage breakdown in detail', () => {
    const out = computeDailyMetrics([
      rec({
        record_type: 'SleepSession',
        start_ts: '2026-06-30T23:38:00-04:00',
        end_ts: '2026-07-01T06:32:00-04:00',
        payload: {
          stages: [
            { stage: 'awake', start: '2026-06-30T23:38:00-04:00', end: '2026-06-30T23:50:00-04:00' },
            { stage: 'light', start: '2026-06-30T23:50:00-04:00', end: '2026-07-01T02:00:00-04:00' },
            { stage: 'deep',  start: '2026-07-01T02:00:00-04:00', end: '2026-07-01T03:10:00-04:00' },
            { stage: 'rem',   start: '2026-07-01T03:10:00-04:00', end: '2026-07-01T04:00:00-04:00' },
            { stage: 'light', start: '2026-07-01T04:00:00-04:00', end: '2026-07-01T06:32:00-04:00' },
          ],
        },
      }),
    ]);
    const sleep = metric(out, 'sleep_minutes');
    expect(sleep?.value).toBe(402); // 414 total minus 12 awake
    expect((sleep?.detail as { stages: Record<string, number> }).stages).toEqual({
      awake: 12, light: 282, deep: 70, rem: 50,
    });
  });

  it('computes hr min/avg/max from samples and resting hr as last value', () => {
    const out = computeDailyMetrics([
      rec({ record_type: 'HeartRate', payload: { samples: [
        { ts: '2026-07-01T08:00:00-04:00', bpm: 60 },
        { ts: '2026-07-01T09:00:00-04:00', bpm: 140 },
        { ts: '2026-07-01T10:00:00-04:00', bpm: 70 },
      ] } }),
      rec({ record_type: 'RestingHeartRate', start_ts: '2026-07-01T06:00:00-04:00', payload: { bpm: 59 } }),
      rec({ record_type: 'RestingHeartRate', start_ts: '2026-07-01T20:00:00-04:00', payload: { bpm: 58 } }),
    ]);
    expect(metric(out, 'hr_min')?.value).toBe(60);
    expect(metric(out, 'hr_max')?.value).toBe(140);
    expect(metric(out, 'hr_avg')?.value).toBe(90);
    expect(metric(out, 'resting_hr')?.value).toBe(58);
  });

  it('collects exercise minutes with session detail', () => {
    const out = computeDailyMetrics([
      rec({
        record_type: 'ExerciseSession',
        start_ts: '2026-07-01T07:00:00-04:00',
        end_ts: '2026-07-01T07:32:00-04:00',
        payload: { exercise_type: 'running', kcal: 312, avg_hr: 142 },
      }),
    ]);
    const ex = metric(out, 'exercise_minutes');
    expect(ex?.value).toBe(32);
    expect((ex?.detail as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('uses the latest value for point-in-time body metrics', () => {
    const out = computeDailyMetrics([
      rec({ record_type: 'Weight', start_ts: '2026-07-01T06:00:00-04:00', payload: { kg: 84.1 } }),
      rec({ record_type: 'Weight', start_ts: '2026-07-01T21:00:00-04:00', payload: { kg: 83.6 } }),
    ]);
    expect(metric(out, 'weight_kg')?.value).toBe(83.6);
  });

  it('picks the chronologically latest value across differing zone offsets, not the lexically largest string', () => {
    // '2026-07-02T01:00:00+09:00' sorts AFTER '2026-07-01T23:30:00-04:00' as a raw string,
    // but it is actually 2026-07-01T16:00:00Z — 11.5 hours EARLIER than 2026-07-02T03:30:00Z.
    const out = computeDailyMetrics([
      rec({ record_type: 'Weight', start_ts: '2026-07-02T01:00:00+09:00', payload: { kg: 999 } }),
      rec({ record_type: 'Weight', start_ts: '2026-07-01T23:30:00-04:00', payload: { kg: 83.6 } }),
    ]);
    expect(metric(out, 'weight_kg')?.value).toBe(83.6);
  });

  it('omits metrics with no data', () => {
    const out = computeDailyMetrics([rec({ record_type: 'Steps', payload: { count: 100 } })]);
    expect(metric(out, 'sleep_minutes')).toBeUndefined();
  });
});

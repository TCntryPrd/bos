import { describe, it, expect } from 'vitest';
import { buildBrief } from './brief.js';
import type { DailyRow } from './types.js';

const d = (day: string, metric: string, value: number, detail: Record<string, unknown> = {}): DailyRow =>
  ({ day, metric, value, detail });

describe('buildBrief', () => {
  it('reports sleep, steps, and workouts when present', () => {
    const rows = [
      d('2026-07-01', 'sleep_minutes', 402, { stages: { deep: 70, light: 282, rem: 50, awake: 12 } }),
      d('2026-07-01', 'steps', 11432),
      d('2026-06-30', 'steps', 8000),
      d('2026-07-01', 'resting_hr', 58),
      d('2026-06-30', 'resting_hr', 60),
      d('2026-07-01', 'exercise_minutes', 32, { sessions: [{ exercise_type: 'running', minutes: 32 }] }),
    ];
    const text = buildBrief(rows, '2026-07-01');
    expect(text).toContain('6h 42m');       // 402 minutes
    expect(text).toContain('11,432 steps');
    expect(text).toContain('resting heart rate 58');
    expect(text).toContain('1 workout');
  });

  it('handles missing data without placeholders', () => {
    const text = buildBrief([], '2026-07-01');
    expect(text).toContain('No health data');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  it('flags a low-sleep streak', () => {
    const rows = [
      d('2026-06-29', 'sleep_minutes', 340),
      d('2026-06-30', 'sleep_minutes', 350),
      d('2026-07-01', 'sleep_minutes', 330),
    ];
    expect(buildBrief(rows, '2026-07-01')).toContain('under 6h for 3 nights');
  });
});

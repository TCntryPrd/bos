import { describe, it, expect } from 'vitest';
import { localDayFor } from './day.js';

describe('localDayFor', () => {
  it('uses the local date embedded in an offset timestamp', () => {
    expect(localDayFor('Steps', '2026-07-01T23:30:00-04:00')).toBe('2026-07-01');
  });

  it('attributes SleepSession to the wake day (end date)', () => {
    expect(
      localDayFor('SleepSession', '2026-06-30T23:38:00-04:00', '2026-07-01T06:32:00-04:00'),
    ).toBe('2026-07-01');
  });

  it('attributes non-sleep types to the start date even when end crosses midnight', () => {
    expect(
      localDayFor('ExerciseSession', '2026-06-30T23:40:00-04:00', '2026-07-01T00:20:00-04:00'),
    ).toBe('2026-06-30');
  });

  it('falls back to VASARI_HEALTH_TZ for Z timestamps', () => {
    process.env.VASARI_HEALTH_TZ = 'America/New_York';
    expect(localDayFor('Steps', '2026-07-02T03:30:00Z')).toBe('2026-07-01');
  });
});

/**
 * Unit tests for pipeline-route helpers that don't require a live database.
 * DB-backed integration lives in pipeline.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { mapStatusForLog } from './pipeline.js';

describe('mapStatusForLog', () => {
  // Regression: v1.3.0 crashed the final /advance with a 23514 CK violation
  // because task.status === 'done' was written straight into boss_stage_log,
  // whose CK only allows ('active','completed','skipped','failed','blocked').
  it("maps terminal task status 'done' to stage-log 'completed'", () => {
    expect(mapStatusForLog('done')).toBe('completed');
  });

  it("maps 'pending' to 'active' (stage_log has no 'pending' state)", () => {
    expect(mapStatusForLog('pending')).toBe('active');
  });

  it.each(['active', 'blocked', 'failed'] as const)(
    "passes '%s' through unchanged",
    (status) => {
      expect(mapStatusForLog(status)).toBe(status);
    },
  );
});

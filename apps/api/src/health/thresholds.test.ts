import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES, evaluateRule, parseRules } from './thresholds.js';

describe('thresholds', () => {
  it('flags sleep below the fixed threshold', () => {
    const rule = { metric: 'sleep_minutes', op: 'lt' as const, value: 360 };
    expect(evaluateRule(rule, 300, null)).toEqual({
      metric: 'sleep_minutes', value: 300, threshold: 360, direction: 'below',
    });
    expect(evaluateRule(rule, 420, null)).toBeNull();
  });

  it('flags resting hr above baseline+delta and ignores missing baseline', () => {
    const rule = { metric: 'resting_hr', op: 'gt_baseline' as const, delta: 10, window: 30 };
    expect(evaluateRule(rule, 72, 58)).toEqual({
      metric: 'resting_hr', value: 72, threshold: 68, direction: 'above',
    });
    expect(evaluateRule(rule, 65, 58)).toBeNull();
    expect(evaluateRule(rule, 72, null)).toBeNull();
  });

  it('parses rules from runtime_config JSON and falls back to defaults', () => {
    expect(parseRules(null)).toEqual(DEFAULT_RULES);
    expect(parseRules('not json')).toEqual(DEFAULT_RULES);
    expect(parseRules('[{"metric":"steps","op":"lt","value":2000}]')).toEqual([
      { metric: 'steps', op: 'lt', value: 2000 },
    ]);
  });
});

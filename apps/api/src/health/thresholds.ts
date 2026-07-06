export type ThresholdRule =
  | { metric: string; op: 'lt' | 'gt'; value: number }
  | { metric: string; op: 'lt_baseline' | 'gt_baseline'; delta: number; window: number };

export interface Breach {
  metric: string;
  value: number;
  threshold: number;
  direction: 'above' | 'below';
}

/** Overridable via runtime_config key 'health.thresholds' (JSON array, per tenant). */
export const DEFAULT_RULES: ThresholdRule[] = [
  { metric: 'sleep_minutes', op: 'lt', value: 360 },
  { metric: 'resting_hr', op: 'gt_baseline', delta: 10, window: 30 },
];

export function parseRules(raw: string | null): ThresholdRule[] {
  if (!raw) return DEFAULT_RULES;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_RULES;
    return parsed as ThresholdRule[];
  } catch {
    return DEFAULT_RULES;
  }
}

function isFixedRule(
  rule: ThresholdRule,
): rule is { metric: string; op: 'lt' | 'gt'; value: number } {
  return rule.op === 'lt' || rule.op === 'gt';
}

export function evaluateRule(
  rule: ThresholdRule,
  value: number,
  baseline: number | null,
): Breach | null {
  if (isFixedRule(rule)) {
    const breached = rule.op === 'lt' ? value < rule.value : value > rule.value;
    if (!breached) return null;
    return { metric: rule.metric, value, threshold: rule.value,
      direction: rule.op === 'lt' ? 'below' : 'above' };
  }
  if (baseline === null) return null;
  const threshold = rule.op === 'gt_baseline' ? baseline + rule.delta : baseline - rule.delta;
  const breached = rule.op === 'gt_baseline' ? value > threshold : value < threshold;
  if (!breached) return null;
  return { metric: rule.metric, value, threshold,
    direction: rule.op === 'gt_baseline' ? 'above' : 'below' };
}

/**
 * Work Order constants. AIOS v2.1 section 9 #6.
 *
 * Buckets are submission intents from Kevin's UI form. They map to a
 * gate_at timestamp in America/Chicago (his local time). Heartbeat
 * polling respects gate_at: a rascal can only claim a WO once now()
 * crosses gate_at.
 *
 * - today     → eligible immediately
 * - tomorrow  → tomorrow 00:00 America/Chicago
 * - this_week → eligible immediately, lower implied priority than 'today'
 * - next_week → next Monday 00:00 America/Chicago
 *
 * Gate math lives in Postgres so daylight-saving transitions and Chicago
 * boundaries are handled by the database, not by ad-hoc JS Date math.
 */

export const WO_BUCKETS = ['today', 'tomorrow', 'this_week', 'next_week'] as const;
export type WoBucket = (typeof WO_BUCKETS)[number];

export const WO_BUCKET_LABELS: Record<WoBucket, string> = {
  today:     'Today',
  tomorrow:  'Tomorrow',
  this_week: 'This Week',
  next_week: 'Next Week',
};

export function isWoBucket(value: unknown): value is WoBucket {
  return typeof value === 'string' && (WO_BUCKETS as readonly string[]).includes(value);
}

/**
 * SQL fragment that computes gate_at from a `bucket` text parameter.
 * Use as: `gate_at = ${WO_GATE_AT_SQL('$1')}`.
 */
export function woGateAtSql(bucketParam: string): string {
  return `(
    CASE ${bucketParam}
      WHEN 'today'     THEN now()
      WHEN 'this_week' THEN now()
      WHEN 'tomorrow'  THEN
        (date_trunc('day',  (now() AT TIME ZONE 'America/Chicago')) + INTERVAL '1 day')
          AT TIME ZONE 'America/Chicago'
      WHEN 'next_week' THEN
        (date_trunc('week', (now() AT TIME ZONE 'America/Chicago')) + INTERVAL '7 days')
          AT TIME ZONE 'America/Chicago'
    END
  )`;
}

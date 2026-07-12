import type { RecordType } from './types.js';

const OFFSET_RE = /[+-]\d{2}:\d{2}$/;

/** YYYY-MM-DD the record belongs to. SleepSession → wake day (end); everything else → start day. */
export function localDayFor(type: RecordType, start: string, end?: string): string {
  const anchor = type === 'SleepSession' && end ? end : start;
  if (OFFSET_RE.test(anchor)) return anchor.slice(0, 10);
  const tz = process.env.VASARI_HEALTH_TZ ?? 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(anchor));
}

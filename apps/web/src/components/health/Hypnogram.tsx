import { useEffect, useState } from 'react';
import { healthDataApi, dateNDaysAgo, fmtHm, sleepStagePcts, HEALTH_COLORS } from '../../lib/healthData';
import type { SleepDetail } from '../../lib/healthData';

interface Stage { stage: 'awake' | 'light' | 'deep' | 'rem'; start: string; end: string }

const STAGE_COLOR: Record<Stage['stage'], string> = {
  deep: HEALTH_COLORS.sleepDeep, light: HEALTH_COLORS.sleepLight,
  rem: HEALTH_COLORS.sleepRem, awake: HEALTH_COLORS.sleepAwake,
};

export function Hypnogram() {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [session, setSession] = useState<{ start: string; end: string } | null>(null);

  useEffect(() => {
    let alive = true;
    healthDataApi.records('SleepSession', dateNDaysAgo(2), dateNDaysAgo(0), 3)
      .then(({ records }) => {
        if (!alive || !records.length) return;
        const latest = records[0]; // endpoint orders start_ts DESC
        const s = (latest.payload as { stages?: Stage[] }).stages ?? [];
        setStages(s);
        setSession({ start: latest.start_ts, end: latest.end_ts ?? latest.start_ts });
      })
      .catch(() => { /* section simply doesn't render */ });
    return () => { alive = false; };
  }, []);

  if (!stages?.length || !session) return null;

  const t0 = Date.parse(session.start);
  const t1 = Date.parse(session.end);
  const span = Math.max(1, t1 - t0);
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const totals: SleepDetail = { start: session.start, end: session.end, sessions: 1,
    stages: { awake: 0, light: 0, deep: 0, rem: 0 } };
  for (const s of stages) {
    totals.stages[s.stage] += Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000);
  }
  const pcts = sleepStagePcts(totals);
  const asleepMin = totals.stages.light + totals.stages.deep + totals.stages.rem;

  return (
    <div className="card p-3.5 mb-4">
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-xs font-medium text-text-secondary">
          Last night — {fmt(session.start)} to {fmt(session.end)}
        </div>
        <div className="text-xs text-text-muted">{fmtHm(asleepMin)} asleep</div>
      </div>
      <div className="flex h-6 rounded-md overflow-hidden">
        {stages.map((s, i) => (
          <span key={i} title={`${s.stage} ${fmt(s.start)}–${fmt(s.end)}`}
            style={{
              width: `${((Date.parse(s.end) - Date.parse(s.start)) / span) * 100}%`,
              background: STAGE_COLOR[s.stage],
            }} />
        ))}
      </div>
      <div className="flex gap-3 mt-2 flex-wrap">
        {(['deep', 'light', 'rem', 'awake'] as const).map((k) => (
          <span key={k} className="text-[10.5px] text-text-muted flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: STAGE_COLOR[k] }} />
            {k} {Math.round(pcts[k])}%
          </span>
        ))}
      </div>
    </div>
  );
}

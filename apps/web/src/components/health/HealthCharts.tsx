import React from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import { seriesFor, fmtHm, fmtInt, HEALTH_COLORS } from '../../lib/healthData';
import type { DailyRow, RangeKey } from '../../lib/healthData';

const AXIS = { fontSize: 10, fill: '#74849A' };
const dayLabel = (day: string) => day.slice(5); // MM-DD

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-3.5">
      <div className="text-xs font-medium text-text-secondary mb-2">{title}</div>
      <div style={{ width: '100%', height: 180 }}>{children}</div>
    </div>
  );
}

export function HealthCharts({ rows, range }: { rows: DailyRow[]; range: RangeKey }) {
  const steps = seriesFor(rows, 'steps').map((r) => ({ day: dayLabel(r.day), steps: r.value }));
  const stepsAvg = steps.length
    ? Math.round(steps.reduce((a, r) => a + r.steps, 0) / steps.length) : 0;

  const sleep = seriesFor(rows, 'sleep_minutes').map((r) => {
    const st = (r.detail as { stages?: Record<string, number> }).stages ?? {};
    return { day: dayLabel(r.day), deep: st.deep ?? 0, light: st.light ?? 0,
      rem: st.rem ?? 0, awake: st.awake ?? 0 };
  });

  const heartDays = new Map<string, { day: string; min?: number; max?: number; resting?: number }>();
  for (const r of rows) {
    if (!['hr_min', 'hr_max', 'resting_hr'].includes(r.metric)) continue;
    const e = heartDays.get(r.day) ?? { day: dayLabel(r.day) };
    if (r.metric === 'hr_min') e.min = r.value;
    if (r.metric === 'hr_max') e.max = r.value;
    if (r.metric === 'resting_hr') e.resting = r.value;
    heartDays.set(r.day, e);
  }
  const heart = [...heartDays.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);

  const bodyDays = new Map<string, { day: string; weight?: number; fat?: number }>();
  for (const r of rows) {
    if (!['weight_kg', 'body_fat_pct'].includes(r.metric)) continue;
    const e = bodyDays.get(r.day) ?? { day: dayLabel(r.day) };
    if (r.metric === 'weight_kg') e.weight = r.value;
    if (r.metric === 'body_fat_pct') e.fat = r.value;
    bodyDays.set(r.day, e);
  }
  const body = [...bodyDays.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);

  const empty = (data: unknown[]) => data.length === 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
      <ChartCard title={`Steps — ${range}`}>
        {empty(steps) ? <Empty /> : (
          <ResponsiveContainer>
            <BarChart data={steps}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={40} tickFormatter={(v: number) => fmtInt(v)} />
              <Tooltip formatter={(v: number) => fmtInt(v)} />
              <ReferenceLine y={stepsAvg} stroke="#74849A" strokeDasharray="4 3" />
              <Bar dataKey="steps" fill={HEALTH_COLORS.activity} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Sleep stages">
        {empty(sleep) ? <Empty /> : (
          <ResponsiveContainer>
            <BarChart data={sleep}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={40} tickFormatter={(v: number) => fmtHm(v)} />
              <Tooltip formatter={(v: number) => fmtHm(v)} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="deep" stackId="s" fill={HEALTH_COLORS.sleepDeep} name="Deep" />
              <Bar dataKey="light" stackId="s" fill={HEALTH_COLORS.sleepLight} name="Light" />
              <Bar dataKey="rem" stackId="s" fill={HEALTH_COLORS.sleepRem} name="REM" />
              <Bar dataKey="awake" stackId="s" fill={HEALTH_COLORS.sleepAwake} name="Awake"
                radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Heart rate — daily range and resting">
        {empty(heart) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={heart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={32} domain={['dataMin - 5', 'dataMax + 5']} />
              <Tooltip />
              <Line dataKey="max" stroke={HEALTH_COLORS.heart} dot={false} strokeWidth={1}
                strokeOpacity={0.5} name="Max" />
              <Line dataKey="resting" stroke={HEALTH_COLORS.heart} dot={false} strokeWidth={2}
                name="Resting" />
              <Line dataKey="min" stroke={HEALTH_COLORS.heart} dot={false} strokeWidth={1}
                strokeOpacity={0.5} name="Min" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Weight and body fat">
        {empty(body) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={body}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis yAxisId="w" tick={AXIS} width={36} domain={['dataMin - 1', 'dataMax + 1']} />
              <YAxis yAxisId="f" orientation="right" tick={AXIS} width={30}
                domain={['dataMin - 1', 'dataMax + 1']} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line yAxisId="w" dataKey="weight" stroke={HEALTH_COLORS.body} dot={false}
                strokeWidth={2} name="Weight (kg)" connectNulls />
              <Line yAxisId="f" dataKey="fat" stroke="#74849A" strokeDasharray="5 3" dot={false}
                name="Body fat (%)" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

function Empty() {
  return (
    <div className="h-full flex items-center justify-center text-xs text-text-muted">
      No data in this range
    </div>
  );
}

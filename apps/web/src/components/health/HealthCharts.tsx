import React from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import { seriesFor, fmtHm, fmtInt, kgToLb, cToF, HEALTH_COLORS } from '../../lib/healthData';
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

type ChartRow = { day: string };

function getDayRow<T extends ChartRow>(map: Map<string, T>, day: string): T {
  const existing = map.get(day);
  if (existing) return existing;
  const next = { day: dayLabel(day) } as T;
  map.set(day, next);
  return next;
}

function sortedRows<T extends ChartRow>(map: Map<string, T>): T[] {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
}

export function HealthCharts({ rows, range }: { rows: DailyRow[]; range: RangeKey }) {
  const steps = seriesFor(rows, 'steps').map((r) => ({ day: dayLabel(r.day), steps: r.value }));
  const stepsAvg = steps.length
    ? Math.round(steps.reduce((a, r) => a + r.steps, 0) / steps.length) : 0;

  const movementDays = new Map<string, { day: string; steps?: number; distance?: number; exercise?: number }>();
  for (const r of rows) {
    if (!['steps', 'distance_m', 'exercise_minutes'].includes(r.metric)) continue;
    const e = getDayRow(movementDays, r.day);
    if (r.metric === 'steps') e.steps = r.value;
    if (r.metric === 'distance_m') e.distance = Number((r.value / 1609.344).toFixed(2));
    if (r.metric === 'exercise_minutes') e.exercise = r.value;
  }
  const movement = sortedRows(movementDays);

  const sleep = seriesFor(rows, 'sleep_minutes').map((r) => {
    const st = (r.detail as { stages?: Record<string, number> }).stages ?? {};
    return { day: dayLabel(r.day), deep: st.deep ?? 0, light: st.light ?? 0,
      rem: st.rem ?? 0, awake: st.awake ?? 0 };
  });

  const heartDays = new Map<string, { day: string; min?: number; max?: number }>();
  for (const r of rows) {
    if (!['hr_min', 'hr_max'].includes(r.metric)) continue;
    const e = getDayRow(heartDays, r.day);
    if (r.metric === 'hr_min') e.min = r.value;
    if (r.metric === 'hr_max') e.max = r.value;
  }
  const heart = sortedRows(heartDays);

  const recoveryDays = new Map<string, { day: string; hrv?: number; spo2?: number; low?: number }>();
  for (const r of rows) {
    if (!['hrv_rmssd', 'spo2_avg', 'hr_min'].includes(r.metric)) continue;
    const e = getDayRow(recoveryDays, r.day);
    if (r.metric === 'hrv_rmssd') e.hrv = r.value;
    if (r.metric === 'spo2_avg') e.spo2 = r.value;
    if (r.metric === 'hr_min') e.low = r.value;
  }
  const recovery = sortedRows(recoveryDays);

  const energyDays = new Map<string, { day: string; active?: number; total?: number; bmr?: number }>();
  for (const r of rows) {
    if (!['active_kcal', 'total_kcal', 'bmr_kcal'].includes(r.metric)) continue;
    const e = getDayRow(energyDays, r.day);
    if (r.metric === 'active_kcal') e.active = r.value;
    if (r.metric === 'total_kcal') e.total = r.value;
    if (r.metric === 'bmr_kcal') e.bmr = r.value;
  }
  const energy = sortedRows(energyDays);

  const bodyDays = new Map<string, { day: string; weight?: number; fat?: number }>();
  for (const r of rows) {
    if (!['weight_kg', 'body_fat_pct'].includes(r.metric)) continue;
    const e = getDayRow(bodyDays, r.day);
    if (r.metric === 'weight_kg') e.weight = Number(kgToLb(r.value).toFixed(1));
    if (r.metric === 'body_fat_pct') e.fat = r.value;
  }
  const body = sortedRows(bodyDays);

  const compositionDays = new Map<string, { day: string; lean?: number; water?: number; bone?: number }>();
  for (const r of rows) {
    if (!['lean_mass_kg', 'body_water_kg', 'bone_mass_kg'].includes(r.metric)) continue;
    const e = getDayRow(compositionDays, r.day);
    if (r.metric === 'lean_mass_kg') e.lean = Number(kgToLb(r.value).toFixed(1));
    if (r.metric === 'body_water_kg') e.water = Number(kgToLb(r.value).toFixed(1));
    if (r.metric === 'bone_mass_kg') e.bone = Number(kgToLb(r.value).toFixed(1));
  }
  const composition = sortedRows(compositionDays);

  const vitalsDays = new Map<string, { day: string; systolic?: number; diastolic?: number; glucose?: number }>();
  for (const r of rows) {
    if (!['bp_systolic', 'bp_diastolic', 'blood_glucose_mgdl'].includes(r.metric)) continue;
    const e = getDayRow(vitalsDays, r.day);
    if (r.metric === 'bp_systolic') e.systolic = r.value;
    if (r.metric === 'bp_diastolic') e.diastolic = r.value;
    if (r.metric === 'blood_glucose_mgdl') e.glucose = r.value;
  }
  const vitals = sortedRows(vitalsDays);

  const temperatureDays = new Map<string, { day: string; body?: number; basal?: number; skin?: number }>();
  for (const r of rows) {
    if (!['body_temp_c', 'basal_body_temp_c', 'skin_temp_c'].includes(r.metric)) continue;
    const e = getDayRow(temperatureDays, r.day);
    if (r.metric === 'body_temp_c') e.body = Number(cToF(r.value).toFixed(1));
    if (r.metric === 'basal_body_temp_c') e.basal = Number(cToF(r.value).toFixed(1));
    if (r.metric === 'skin_temp_c') e.skin = Number(cToF(r.value).toFixed(1));
  }
  const temperature = sortedRows(temperatureDays);

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

      <ChartCard title="Movement load">
        {empty(movement) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={movement}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis yAxisId="steps" tick={AXIS} width={40} tickFormatter={(v: number) => fmtInt(v)} />
              <YAxis yAxisId="other" orientation="right" tick={AXIS} width={36} />
              <Tooltip formatter={(v: number, name: string) => {
                if (name === 'Steps') return [fmtInt(v), name];
                if (name === 'Distance') return [`${v.toFixed(2)} mi`, name];
                return [`${Math.round(v)} min`, name];
              }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar yAxisId="steps" dataKey="steps" fill={HEALTH_COLORS.activity} name="Steps"
                radius={[3, 3, 0, 0]} />
              <Line yAxisId="other" dataKey="distance" stroke={HEALTH_COLORS.body} dot={false}
                strokeWidth={2} name="Distance" connectNulls />
              <Line yAxisId="other" dataKey="exercise" stroke="#22C55E" dot={false}
                strokeDasharray="4 3" name="Exercise" connectNulls />
            </ComposedChart>
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

      <ChartCard title="Heart rate — daily low/high">
        {empty(heart) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={heart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={32} domain={['dataMin - 5', 'dataMax + 5']} />
              <Tooltip />
              <Line dataKey="max" stroke={HEALTH_COLORS.heart} dot={false} strokeWidth={1}
                strokeOpacity={0.7} name="High" />
              <Line dataKey="min" stroke={HEALTH_COLORS.heart} dot={false} strokeWidth={1}
                strokeOpacity={0.7} name="Low" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Recovery markers">
        {empty(recovery) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={recovery}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis yAxisId="pulse" tick={AXIS} width={32} domain={['dataMin - 5', 'dataMax + 5']} />
              <YAxis yAxisId="pct" orientation="right" tick={AXIS} width={34}
                domain={['dataMin - 1', 'dataMax + 1']} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line yAxisId="pulse" dataKey="low" stroke={HEALTH_COLORS.heart} dot={false}
                strokeWidth={2} name="Daily low bpm" connectNulls />
              <Line yAxisId="pulse" dataKey="hrv" stroke="#14B8A6" dot={false}
                strokeWidth={2} name="HRV ms" connectNulls />
              <Line yAxisId="pct" dataKey="spo2" stroke="#0EA5E9" dot={false}
                strokeWidth={2} name="SpO2 %" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Energy">
        {empty(energy) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={energy}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={42} tickFormatter={(v: number) => fmtInt(v)} />
              <Tooltip formatter={(v: number, name: string) => [`${fmtInt(v)} kcal`, name]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="active" fill="#F59E0B" name="Active" radius={[3, 3, 0, 0]} />
              <Line dataKey="total" stroke="#E11D48" dot={false} strokeWidth={2}
                name="Total" connectNulls />
              <Line dataKey="bmr" stroke="#74849A" dot={false} strokeDasharray="5 3"
                name="BMR" connectNulls />
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
              <YAxis yAxisId="w" tick={AXIS} width={40} domain={['dataMin - 2', 'dataMax + 2']}
                tickFormatter={(v: number) => `${Math.round(v)}`} />
              <YAxis yAxisId="f" orientation="right" tick={AXIS} width={30}
                domain={['dataMin - 1', 'dataMax + 1']} />
              <Tooltip formatter={(v: number, name: string) => (
                name === 'Weight (lbs)' ? [`${v.toFixed(1)} lbs`, name] : [v, name]
              )} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line yAxisId="w" dataKey="weight" stroke={HEALTH_COLORS.body} dot={false}
                strokeWidth={2} name="Weight (lbs)" connectNulls />
              <Line yAxisId="f" dataKey="fat" stroke="#74849A" strokeDasharray="5 3" dot={false}
                name="Body fat (%)" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Body composition">
        {empty(composition) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={composition}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={40} domain={['dataMin - 2', 'dataMax + 2']}
                tickFormatter={(v: number) => `${Math.round(v)}`} />
              <Tooltip formatter={(v: number, name: string) => [`${v.toFixed(1)} lbs`, name]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line dataKey="lean" stroke="#0EA5E9" dot={false} strokeWidth={2}
                name="Lean mass" connectNulls />
              <Line dataKey="water" stroke="#14B8A6" dot={false} strokeWidth={2}
                name="Body water" connectNulls />
              <Line dataKey="bone" stroke="#74849A" dot={false} strokeDasharray="5 3"
                name="Bone mass" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Clinical vitals">
        {empty(vitals) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={vitals}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis yAxisId="bp" tick={AXIS} width={36} />
              <YAxis yAxisId="glucose" orientation="right" tick={AXIS} width={38} />
              <Tooltip formatter={(v: number, name: string) => {
                if (name === 'Glucose') return [`${Math.round(v)} mg/dL`, name];
                return [`${Math.round(v)} mmHg`, name];
              }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line yAxisId="bp" dataKey="systolic" stroke="#E11D48" dot={false}
                strokeWidth={2} name="Systolic" connectNulls />
              <Line yAxisId="bp" dataKey="diastolic" stroke="#2563EB" dot={false}
                strokeWidth={2} name="Diastolic" connectNulls />
              <Line yAxisId="glucose" dataKey="glucose" stroke="#F59E0B" dot={false}
                strokeDasharray="5 3" name="Glucose" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Temperature">
        {empty(temperature) ? <Empty /> : (
          <ResponsiveContainer>
            <ComposedChart data={temperature}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E6EDF5" />
              <XAxis dataKey="day" tick={AXIS} interval="preserveStartEnd" />
              <YAxis tick={AXIS} width={36} domain={['dataMin - 1', 'dataMax + 1']} />
              <Tooltip formatter={(v: number, name: string) => [`${v.toFixed(1)} F`, name]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line dataKey="body" stroke="#E11D48" dot={false} strokeWidth={2}
                name="Body" connectNulls />
              <Line dataKey="basal" stroke="#F59E0B" dot={false} strokeWidth={2}
                name="Basal" connectNulls />
              <Line dataKey="skin" stroke="#14B8A6" dot={false} strokeDasharray="5 3"
                name="Skin" connectNulls />
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

import {
  Bike, Dumbbell, Flame, Footprints, Gauge, Waves, Activity as ActivityIcon,
} from 'lucide-react';
import { workoutsFrom, fmtInt } from '../../lib/healthData';
import type { DailyRow } from '../../lib/healthData';

function iconFor(type: string) {
  const t = type.toLowerCase();
  if (t.includes('run')) return Footprints;
  if (t.includes('walk') || t.includes('hik')) return Footprints;
  if (t.includes('strength') || t.includes('weight')) return Dumbbell;
  if (t.includes('cycl') || t.includes('bike')) return Bike;
  if (t.includes('swim')) return Waves;
  return ActivityIcon;
}

const label = (t: string) => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

interface MovementDay {
  day: string;
  steps?: number;
  distanceM?: number;
  activeKcal?: number;
  totalKcal?: number;
  exerciseMinutes?: number;
  hrMin?: number;
  hrMax?: number;
}

function movementFrom(rows: DailyRow[]): MovementDay[] {
  const byDay = new Map<string, MovementDay>();
  for (const r of rows) {
    if (!['steps', 'distance_m', 'active_kcal', 'total_kcal', 'exercise_minutes', 'hr_min', 'hr_max'].includes(r.metric)) {
      continue;
    }
    const day = byDay.get(r.day) ?? { day: r.day };
    if (r.metric === 'steps') day.steps = r.value;
    if (r.metric === 'distance_m') day.distanceM = r.value;
    if (r.metric === 'active_kcal') day.activeKcal = r.value;
    if (r.metric === 'total_kcal') day.totalKcal = r.value;
    if (r.metric === 'exercise_minutes') day.exerciseMinutes = r.value;
    if (r.metric === 'hr_min') day.hrMin = r.value;
    if (r.metric === 'hr_max') day.hrMax = r.value;
    byDay.set(r.day, day);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 12);
}

function fmtDistance(meters?: number): string {
  if (meters == null) return '-';
  return `${(meters / 1609.344).toFixed(2)} mi`;
}

export function WorkoutList({ rows }: { rows: DailyRow[] }) {
  const workouts = workoutsFrom(rows).slice(0, 12);
  const movement = movementFrom(rows);

  return (
    <div className="card p-3.5 mb-4">
      {workouts.length > 0 && (
        <>
          <div className="text-xs font-medium text-text-secondary mb-2">Recent workouts</div>
          <div className="divide-y divide-border">
            {workouts.map((w, i) => {
              const Icon = iconFor(w.exercise_type);
              return (
                <div key={`${w.start}-${i}`} className="flex items-center gap-3 py-2">
                  <Icon size={16} className="text-success shrink-0" />
                  <div className="text-sm text-text-primary flex-1 truncate">
                    {w.title ?? label(w.exercise_type)}
                  </div>
                  <div className="text-xs text-text-muted">
                    {new Date(w.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                  <div className="text-xs text-text-secondary w-14 text-right">{w.minutes} min</div>
                  <div className="text-xs text-text-secondary w-16 text-right">
                    {w.kcal != null ? `${fmtInt(w.kcal)} kcal` : '-'}
                  </div>
                  <div className="text-xs text-text-secondary w-20 text-right">
                    {w.avg_hr != null ? `avg ${Math.round(w.avg_hr)} bpm` : '-'}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className={workouts.length ? 'mt-4' : ''}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-text-secondary">Daily movement</div>
          {!workouts.length && (
            <div className="text-[10px] font-medium text-amber-600">No recent workout sessions</div>
          )}
        </div>
        {movement.length ? (
          <div className="divide-y divide-border">
            {movement.map((m) => (
              <div key={m.day} className="grid grid-cols-[18px_1fr_auto] items-center gap-2 py-2">
                <Footprints size={16} className="text-success" />
                <div className="min-w-0">
                  <div className="text-sm text-text-primary">
                    {new Date(`${m.day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                    <span><Footprints size={12} className="mr-1 inline" />{m.steps != null ? fmtInt(m.steps) : '-'} steps</span>
                    <span><Gauge size={12} className="mr-1 inline" />{fmtDistance(m.distanceM)}</span>
                    <span><Flame size={12} className="mr-1 inline" />{m.activeKcal != null
                      ? `${fmtInt(m.activeKcal)} active`
                      : m.totalKcal != null ? `${fmtInt(m.totalKcal)} total` : '-'}</span>
                  </div>
                </div>
                <div className="text-right text-xs text-text-secondary">
                  {m.exerciseMinutes != null ? `${Math.round(m.exerciseMinutes)} min` : (
                    m.hrMin != null && m.hrMax != null ? `${Math.round(m.hrMin)}-${Math.round(m.hrMax)} bpm` : '-'
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-text-muted">No movement data in this range</div>
        )}
      </div>
    </div>
  );
}

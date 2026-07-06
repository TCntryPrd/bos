import { Bike, Dumbbell, Footprints, Waves, Activity as ActivityIcon } from 'lucide-react';
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

export function WorkoutList({ rows }: { rows: DailyRow[] }) {
  const workouts = workoutsFrom(rows).slice(0, 12);
  if (!workouts.length) return null;
  return (
    <div className="card p-3.5 mb-4">
      <div className="text-xs font-medium text-text-secondary mb-2">Recent workouts</div>
      <div className="divide-y divide-border">
        {workouts.map((w, i) => {
          const Icon = iconFor(w.exercise_type);
          return (
            <div key={i} className="flex items-center gap-3 py-2">
              <Icon size={16} className="text-success shrink-0" />
              <div className="text-sm text-text-primary flex-1 truncate">
                {w.title ?? label(w.exercise_type)}
              </div>
              <div className="text-xs text-text-muted">
                {new Date(w.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
              <div className="text-xs text-text-secondary w-14 text-right">{w.minutes} min</div>
              <div className="text-xs text-text-secondary w-16 text-right">
                {w.kcal != null ? `${fmtInt(w.kcal)} kcal` : '—'}
              </div>
              <div className="text-xs text-text-secondary w-20 text-right">
                {w.avg_hr != null ? `avg ${Math.round(w.avg_hr)} bpm` : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

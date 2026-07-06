import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, RefreshCw, Smartphone } from 'lucide-react';
import {
  healthDataApi, latestByMetric, deltaVsPrev, fmtHm, fmtInt,
  rangeToDays, dateNDaysAgo, HEALTH_COLORS,
} from '../lib/healthData';
import type { DailyRow, RangeKey, HealthOverview } from '../lib/healthData';
import { HealthCharts } from '../components/health/HealthCharts';
import { Hypnogram } from '../components/health/Hypnogram';
import { WorkoutList } from '../components/health/WorkoutList';
import { DevicesModal } from '../components/health/DevicesModal';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7d' },
  { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
];

interface HeroDef { metric: string; label: string; fmt: (v: number) => string; unit?: string }
const HEROES: HeroDef[] = [
  { metric: 'steps', label: 'Steps', fmt: fmtInt },
  { metric: 'sleep_minutes', label: 'Sleep', fmt: fmtHm },
  { metric: 'resting_hr', label: 'Resting HR', fmt: (v) => `${Math.round(v)}`, unit: 'bpm' },
  { metric: 'hrv_rmssd', label: 'HRV', fmt: (v) => `${Math.round(v)}`, unit: 'ms' },
  { metric: 'spo2_avg', label: 'SpO2', fmt: (v) => `${v.toFixed(1)}`, unit: '%' },
  { metric: 'active_kcal', label: 'Active energy', fmt: fmtInt, unit: 'kcal' },
  { metric: 'exercise_minutes', label: 'Exercise', fmt: (v) => `${Math.round(v)}`, unit: 'min' },
  { metric: 'weight_kg', label: 'Weight', fmt: (v) => v.toFixed(1), unit: 'kg' },
];

export default function Health() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const requestIdRef = useRef(0);

  const days = rangeToDays(range);
  const to = dateNDaysAgo(0);
  const from = dateNDaysAgo(days * 2 - 1); // double window for deltas

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const [daily, ov] = await Promise.all([
        healthDataApi.daily(from, to),
        healthDataApi.overview(),
      ]);
      if (requestId !== requestIdRef.current) return; // superseded by a newer request
      setRows(daily.days);
      setOverview(ov);
      setError(null);
    } catch (e) {
      if (requestId !== requestIdRef.current) return; // superseded by a newer request
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const windowStart = dateNDaysAgo(days - 1);
  const windowRows = useMemo(() => rows.filter((r) => r.day >= windowStart), [rows, windowStart]);
  const latest = useMemo(() => latestByMetric(windowRows), [windowRows]);
  const stale = !!overview?.last_sync_at &&
    Date.now() - Date.parse(overview.last_sync_at) > 24 * 60 * 60 * 1000;

  return (
    <div className="p-5 max-w-[1200px] mx-auto">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Heart size={20} style={{ color: HEALTH_COLORS.activity }} />
        <h1 className="text-lg font-semibold text-text-primary">Health</h1>
        <div className="ml-auto flex items-center gap-1.5">
          {RANGES.map((r) => (
            <button key={r.key}
              className={r.key === range ? 'btn-primary !px-3 !py-1 text-xs' : 'btn-ghost !px-3 !py-1 text-xs'}
              onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
          <button className="btn-ghost !px-2 !py-1" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw size={14} />
          </button>
          <button className="btn-secondary !px-3 !py-1 text-xs" onClick={() => setDevicesOpen(true)}>
            <Smartphone size={13} /> Devices
          </button>
        </div>
      </div>

      {stale && (
        <div className="badge-warning badge mb-3">
          Phone hasn't synced since {new Date(overview!.last_sync_at!).toLocaleString()}
        </div>
      )}
      {error && <div className="badge-danger badge mb-3">{error}</div>}

      {!loading && overview && !overview.paired && (
        <div className="card p-8 text-center">
          <p className="text-text-secondary mb-4">
            No device paired yet. Pair your phone to start syncing Health Connect data.
          </p>
          <button className="btn-primary" onClick={() => setDevicesOpen(true)}>Pair a device</button>
        </div>
      )}

      {(loading || overview?.paired) && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {HEROES.map((h) => {
              const row = latest.get(h.metric);
              const delta = deltaVsPrev(rows, h.metric, windowStart, from);
              return (
                <div key={h.metric} className="card p-3.5">
                  <div className="text-xs text-text-muted">{h.label}</div>
                  <div className="text-2xl font-semibold text-text-primary mt-1">
                    {loading && !row ? '…' : row ? h.fmt(row.value) : '—'}
                    {h.unit && row && (
                      <span className="text-xs text-text-muted ml-1">{h.unit}</span>
                    )}
                  </div>
                  {delta !== null && (
                    <div className="text-[11px] mt-0.5"
                      style={{ color: delta >= 0 ? HEALTH_COLORS.activity : HEALTH_COLORS.heart }}>
                      {delta >= 0 ? '+' : ''}{delta}% vs previous {days}d
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <HealthCharts rows={windowRows} range={range} />
          <Hypnogram />
          <WorkoutList rows={windowRows} />
        </>
      )}

      <DevicesModal open={devicesOpen} onClose={() => { setDevicesOpen(false); void load(); }} />
    </div>
  );
}

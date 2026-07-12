import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  FileText,
  Flame,
  Footprints,
  Gauge,
  Heart,
  Moon,
  Orbit,
  RefreshCw,
  RotateCcw,
  Scale,
  Smartphone,
  Zap,
} from 'lucide-react';
import {
  healthDataApi, latestByMetric, deltaVsPrev, fmtHm, fmtInt,
  rangeToDays, dateNDaysAgo, seriesFor, sparkPoints, HEALTH_COLORS, fmtLb,
} from '../lib/healthData';
import type {
  DailyRow, DeviceSyncState, HealthAnomaly, HealthDevice, HealthOverview, HeartRateSummary, RangeKey,
} from '../lib/healthData';
import { HealthCharts } from '../components/health/HealthCharts';
import { Hypnogram } from '../components/health/Hypnogram';
import { WorkoutList } from '../components/health/WorkoutList';
import { DevicesModal } from '../components/health/DevicesModal';

// Lazy so three.js stays out of this page's chunk (same split as /health/holo).
const HoloEmbed = lazy(() => import('../components/health/holo/HoloEmbed'));

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7d' },
  { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
];

const GRID_MARKS = Array.from({ length: 11 }, (_, i) => i * 10);
const HEALTH_LAYOUT_KEY = 'vasari-health-placement-v1';
const DESKTOP_LOCK_QUERY = '(min-width: 1367px)';
const TABLET_LOCK_QUERY = '(min-width: 700px) and (max-width: 1366px)';

type LayoutItemId =
  | 'steps'
  | 'sleep'
  | 'heart'
  | 'hrv'
  | 'spo2'
  | 'energy'
  | 'exercise'
  | 'weight'
  | 'trends'
  | 'sleepReport'
  | 'workouts'
  | 'hologram';

interface LayoutPosition {
  x: number;
  y: number;
}

const DEFAULT_HEALTH_LAYOUT: Record<LayoutItemId, LayoutPosition> = {
  steps: { x: 3.5, y: 25 },
  sleep: { x: 4.5, y: 44 },
  heart: { x: 35, y: 22 },
  hrv: { x: 57, y: 22 },
  spo2: { x: 80, y: 28 },
  energy: { x: 79, y: 49 },
  exercise: { x: 29, y: 61 },
  weight: { x: 62, y: 60 },
  trends: { x: 56, y: 66 },
  sleepReport: { x: 3, y: 84 },
  workouts: { x: 32, y: 84 },
  hologram: { x: 6, y: 14 },
};

interface HeroDef {
  metric: string;
  fallbackMetric?: string;
  fallbackLabel?: string;
  recordType?: string;
  label: string;
  fmt: (v: number) => string;
  unit?: string;
  pin: LayoutItemId;
  accent: string;
  icon: typeof Activity;
  signal?: keyof HealthOverview['spark'];
  signalMetric?: string;
}
const HEROES: HeroDef[] = [
  {
    metric: 'steps', label: 'Steps', fmt: fmtInt, pin: 'steps',
    accent: HEALTH_COLORS.activity, icon: Footprints, signal: 'steps', recordType: 'Steps',
  },
  {
    metric: 'sleep_minutes', label: 'Sleep', fmt: fmtHm, pin: 'sleep',
    accent: HEALTH_COLORS.sleepDeep, icon: Moon, signal: 'sleep_minutes', recordType: 'SleepSession',
  },
  {
    metric: 'heart_rate_recent',
    label: 'Current HR', fmt: (v) => `${Math.round(v)}`, unit: 'bpm', pin: 'heart',
    accent: HEALTH_COLORS.heart, icon: Heart, signalMetric: 'hr_min', recordType: 'HeartRate',
  },
  {
    metric: 'hrv_rmssd', label: 'HRV', fmt: (v) => `${Math.round(v)}`, unit: 'ms',
    pin: 'hrv', accent: '#14B8A6', icon: Activity, recordType: 'HeartRateVariabilityRmssd',
  },
  {
    metric: 'spo2_avg', label: 'SpO2', fmt: (v) => `${v.toFixed(1)}`, unit: '%',
    pin: 'spo2', accent: '#0EA5E9', icon: Gauge, recordType: 'OxygenSaturation',
  },
  {
    metric: 'active_kcal', fallbackMetric: 'total_kcal', fallbackLabel: 'total energy',
    label: 'Active energy', fmt: fmtInt, unit: 'kcal', pin: 'energy',
    accent: '#F59E0B', icon: Flame, signal: 'active_kcal', recordType: 'ActiveCaloriesBurned',
  },
  {
    metric: 'exercise_minutes', label: 'Exercise', fmt: (v) => `${Math.round(v)}`,
    unit: 'min', pin: 'exercise', accent: '#22C55E', icon: Zap, recordType: 'ExerciseSession',
  },
  {
    metric: 'weight_kg', label: 'Weight', fmt: fmtLb, unit: 'lbs',
    pin: 'weight', accent: HEALTH_COLORS.body, icon: Scale, recordType: 'Weight',
  },
];

function loadSavedLayout(): Record<LayoutItemId, LayoutPosition> {
  if (typeof window === 'undefined') return DEFAULT_HEALTH_LAYOUT;
  try {
    const saved = window.localStorage.getItem(HEALTH_LAYOUT_KEY);
    if (!saved) return DEFAULT_HEALTH_LAYOUT;
    const parsed = JSON.parse(saved) as Partial<Record<LayoutItemId, LayoutPosition>>;
    return (Object.keys(DEFAULT_HEALTH_LAYOUT) as LayoutItemId[]).reduce((acc, id) => {
      const position = parsed[id];
      acc[id] = typeof position?.x === 'number' && typeof position?.y === 'number'
        ? { x: position.x, y: position.y }
        : DEFAULT_HEALTH_LAYOUT[id];
      return acc;
    }, {} as Record<LayoutItemId, LayoutPosition>);
  } catch {
    return DEFAULT_HEALTH_LAYOUT;
  }
}

function saveLayout(layout: Record<LayoutItemId, LayoutPosition>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HEALTH_LAYOUT_KEY, JSON.stringify(layout));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function useLayoutLock(queryText: string) {
  const [locked, setLocked] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(queryText).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia(queryText);
    const update = () => setLocked(query.matches);
    update();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, [queryText]);

  return locked;
}

export default function Health() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [devices, setDevices] = useState<HealthDevice[]>([]);
  const [anomalies, setAnomalies] = useState<HealthAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [layout, setLayout] = useState<Record<LayoutItemId, LayoutPosition>>(() => loadSavedLayout());
  const desktopLocked = useLayoutLock(DESKTOP_LOCK_QUERY);
  const tabletLocked = useLayoutLock(TABLET_LOCK_QUERY);
  const requestIdRef = useRef(0);

  const days = rangeToDays(range);
  const to = dateNDaysAgo(0);
  const from = dateNDaysAgo(days * 2 - 1); // double window for deltas

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const [daily, ov, deviceResult] = await Promise.all([
        healthDataApi.daily(from, to),
        healthDataApi.overview(),
        healthDataApi.devices().catch(() => ({ devices: [] as HealthDevice[] })),
      ]);
      if (requestId !== requestIdRef.current) return; // superseded by a newer request
      setRows(daily.days);
      setOverview(ov);
      setDevices(deviceResult.devices);
      healthDataApi.anomalies(dateNDaysAgo(30), to, 'open', 20)
        .then((result) => setAnomalies(result.anomalies))
        .catch(() => setAnomalies([]));
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
  const activeDevice = useMemo(() => latestActiveDevice(devices), [devices]);
  const syncStateByType = useMemo(() => {
    const out = new Map<string, DeviceSyncState>();
    for (const s of activeDevice?.sync_state ?? []) out.set(s.record_type, s);
    return out;
  }, [activeDevice]);
  const stale = !!overview?.last_sync_at &&
    Date.now() - Date.parse(overview.last_sync_at) > 24 * 60 * 60 * 1000;
  const paired = !!overview?.paired;
  const patientState = loading ? 'Reading sensors' : paired ? 'Device paired' : 'Awaiting device';
  const moveLayoutItem = useCallback((id: LayoutItemId, position: LayoutPosition) => {
    setLayout((current) => {
      const next = { ...current, [id]: position };
      saveLayout(next);
      return next;
    });
  }, []);
  const resetLayout = useCallback(() => {
    const next = { ...DEFAULT_HEALTH_LAYOUT };
    saveLayout(next);
    setLayout(next);
  }, []);
  const layoutLocked = desktopLocked || tabletLocked;
  const activeLayout = layout;
  const healthFrameLeft = activeLayout.sleepReport?.x ?? DEFAULT_HEALTH_LAYOUT.sleepReport.x;

  return (
    <div className={`aios-page health-suite-page min-h-full overflow-hidden p-3 lg:p-4 ${desktopLocked ? 'health-desktop-locked' : ''} ${tabletLocked ? 'health-tablet-locked' : ''}`}>
      <div
        className="health-suite-stage mx-auto"
        style={{ '--health-frame-left': `${healthFrameLeft}%` } as CSSProperties}
      >
        <div className="health-placement-grid" aria-hidden="true">
          {GRID_MARKS.map((mark) => (
            <span key={`x-${mark}`} className="health-grid-mark health-grid-mark-x" style={{ left: `${mark}%` }}>
              {mark}
            </span>
          ))}
          {GRID_MARKS.map((mark) => (
            <span key={`y-${mark}`} className="health-grid-mark health-grid-mark-y" style={{ top: `${mark}%` }}>
              {mark}
            </span>
          ))}
        </div>

        <div className="health-layout-dock">
          <span className="health-status-chip">
            <span className={paired ? 'bg-emerald-400' : loading ? 'bg-cyan-400' : 'bg-amber-400'} />
            {patientState}
          </span>
          <button className="health-icon-button" onClick={() => void load()} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          {!layoutLocked && (
            <button className="health-icon-button" onClick={resetLayout} aria-label="Reset layout">
              <RotateCcw size={15} />
            </button>
          )}
          <button className="health-device-button" onClick={() => setDevicesOpen(true)}>
            <Smartphone size={14} /> Devices
          </button>
          <Link className="health-device-button" to="/health/journal">
            <BookOpen size={14} /> Journal
          </Link>
          <Link className="health-device-button" to="/health/records">
            <FileText size={14} /> Records
          </Link>
          <Link className="health-device-button" to="/health/holo">
            <Orbit size={14} /> Hologram
          </Link>
        </div>

        {(stale || error) && (
          <div className="health-alert-stack">
            {stale && (
              <div className="health-alert is-warning">
                Phone has not synced since {new Date(overview!.last_sync_at!).toLocaleString()}
              </div>
            )}
            {error && <div className="health-alert is-danger">{error}</div>}
          </div>
        )}

        {!loading && overview && !overview.paired ? (
          <div className="health-pair-card">
            <div className="health-orb mx-auto mb-3">
              <Smartphone size={20} />
            </div>
            <div className="vs-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Device Intake</div>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">Pair your phone</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Pair a device to bring Health Connect data into this exam report.
            </p>
            <button className="health-device-button mt-4" onClick={() => setDevicesOpen(true)}>
              <Smartphone size={14} /> Pair a device
            </button>
          </div>
        ) : (
          <>
            <DraggableHealthItem
              id="hologram"
              layout={activeLayout}
              onMove={moveLayoutItem}
              locked={true}
            >
              <Suspense fallback={null}>
                <HoloEmbed
                  resizable={false}
                  style={{ width: 'clamp(420px, 31.5vw, 595px)', height: 'clamp(630px, 86vh, 1085px)' }}
                />
              </Suspense>
            </DraggableHealthItem>

            <div className="health-vital-field">
              {HEROES.map((h) => {
                const heartRow = h.metric === 'heart_rate_recent'
                  ? latestHeartRateRow(overview?.heart_rate)
                  : undefined;
                const primaryRow = heartRow ?? latest.get(h.metric);
                const fallbackRow = !primaryRow && h.fallbackMetric ? latest.get(h.fallbackMetric) : undefined;
                const row = primaryRow ?? fallbackRow;
                const displayMetric = primaryRow ? h.metric : (fallbackRow && h.fallbackMetric) || h.metric;
                const delta = row ? deltaVsPrev(rows, displayMetric, windowStart, from) : null;
                const values = sparkValues(windowRows, h.signalMetric ?? displayMetric)
                  || (h.signal ? (overview?.spark[h.signal] ?? []) : []);
                const syncState = h.recordType ? syncStateByType.get(h.recordType) : undefined;
                const heartStatus = h.metric === 'heart_rate_recent'
                  ? latestHeartRateStatus(overview?.heart_rate, loading)
                  : null;
                return (
                  <DraggableHealthItem
                    key={h.metric}
                    id={h.pin}
                    layout={activeLayout}
                    onMove={moveLayoutItem}
                    locked={layoutLocked}
                    className="health-vital-drag"
                  >
                    <VitalPin
                      def={h}
                      row={row}
                      delta={delta}
                      days={days}
                      loading={loading}
                      points={sparkPoints(values, 92, 24)}
                      status={
                        h.metric === 'heart_rate_recent'
                          ? row ? null : heartStatus?.primary ?? null
                          : h.metric === 'weight_kg' && row && !fallbackRow
                            ? null
                            : statusForHero(h, row, !!fallbackRow, syncState, loading)
                      }
                      inlineStatus={h.metric === 'heart_rate_recent' && row ? heartStatus?.primary ?? null : null}
                      secondaryStatus={h.metric === 'heart_rate_recent' && row ? heartStatus?.secondary ?? null : null}
                      fallbackActive={!!fallbackRow}
                    />
                  </DraggableHealthItem>
                );
              })}
            </div>

            <DraggableHealthItem
              id="trends"
              layout={activeLayout}
              onMove={moveLayoutItem}
              locked={layoutLocked}
              className="health-report-drag health-report-drag-trends"
            >
              <aside className="health-report-panel health-report-trends">
                <div className="health-panel-title">
                  <span>Diagnostic Trends</span>
                  <div className="flex items-center gap-2">
                    {anomalies.length > 0 && (
                      <span className="vs-mono text-[10px] text-amber-600">{anomalies.length} open</span>
                    )}
                    <div className="health-range-shell" aria-label="Health range">
                      {RANGES.map((r) => (
                        <button
                          key={r.key}
                          className={r.key === range ? 'is-active' : ''}
                          onClick={() => setRange(r.key)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <HealthCharts rows={windowRows} range={range} />
              </aside>
            </DraggableHealthItem>

            <DraggableHealthItem
              id="sleepReport"
              layout={activeLayout}
              onMove={moveLayoutItem}
              locked={false}
              className="health-report-drag health-report-drag-sleep"
            >
              <aside className="health-report-panel health-report-sleep">
                <div className="health-panel-title">
                  <span>Recovery Trace</span>
                  <span className="vs-mono">Sleep</span>
                </div>
                <Hypnogram />
              </aside>
            </DraggableHealthItem>

            <DraggableHealthItem
              id="workouts"
              layout={activeLayout}
              onMove={moveLayoutItem}
              locked={layoutLocked}
              className="health-report-drag health-report-drag-workouts"
            >
              <aside className="health-report-panel health-report-workouts">
                <div className="health-panel-title">
                  <span>Movement Log</span>
                  <span className="vs-mono">Recent</span>
                </div>
                <WorkoutList rows={windowRows} />
              </aside>
            </DraggableHealthItem>
          </>
        )}

        <div className="health-floor-glow" aria-hidden="true" />
      </div>

      <DevicesModal open={devicesOpen} onClose={() => { setDevicesOpen(false); void load(); }} />
    </div>
  );
}

function DraggableHealthItem({
  id,
  layout,
  onMove,
  locked = false,
  className,
  children,
}: {
  id: LayoutItemId;
  layout: Record<LayoutItemId, LayoutPosition>;
  onMove: (id: LayoutItemId, position: LayoutPosition) => void;
  locked?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPosition: LayoutPosition;
    stageRect: DOMRect;
    itemRect: DOMRect;
  } | null>(null);
  const position = layout[id] ?? DEFAULT_HEALTH_LAYOUT[id];

  const stopDrag = useCallback((event?: PointerEvent<HTMLDivElement>) => {
    const item = itemRef.current;
    if (event && item?.hasPointerCapture(event.pointerId)) {
      item.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (locked) return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button,a,input,textarea,select,[role="button"]')) return;

    const item = itemRef.current;
    const stage = item?.closest('.health-suite-stage') as HTMLElement | null;
    if (!item || !stage) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: position,
      stageRect: stage.getBoundingClientRect(),
      itemRect: item.getBoundingClientRect(),
    };
    item.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }, [locked, position]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = ((event.clientX - drag.startX) / drag.stageRect.width) * 100;
    const deltaY = ((event.clientY - drag.startY) / drag.stageRect.height) * 100;
    const maxX = Math.max(0, 100 - (drag.itemRect.width / drag.stageRect.width) * 100);
    const maxY = Math.max(0, 100 - (drag.itemRect.height / drag.stageRect.height) * 100);
    onMove(id, {
      x: Math.round(clamp(drag.startPosition.x + deltaX, 0, maxX) * 10) / 10,
      y: Math.round(clamp(drag.startPosition.y + deltaY, 0, maxY) * 10) / 10,
    });
  }, [id, onMove]);

  const style = {
    '--layout-x': `${position.x}%`,
    '--layout-y': `${position.y}%`,
  } as CSSProperties;

  return (
    <div
      ref={itemRef}
      className={`health-draggable-item ${dragging ? 'is-dragging' : ''} ${locked ? 'is-locked' : ''} ${className ?? ''}`}
      data-layout-id={id}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    >
      {children}
    </div>
  );
}

function latestActiveDevice(devices: HealthDevice[]): HealthDevice | null {
  const active = devices.filter((d) => !d.revoked_at);
  active.sort((a, b) => {
    const aTime = Date.parse(a.last_seen_at ?? a.paired_at ?? '') || 0;
    const bTime = Date.parse(b.last_seen_at ?? b.paired_at ?? '') || 0;
    return bTime - aTime;
  });
  return active[0] ?? null;
}

function sparkValues(rows: DailyRow[], metric: string): number[] {
  return seriesFor(rows, metric).map((r) => r.value);
}

function latestHeartRateRow(heartRate?: HeartRateSummary | null): DailyRow | undefined {
  if (!heartRate?.current) return undefined;
  const { current } = heartRate;
  return {
    day: current.day,
    metric: 'heart_rate_recent',
    value: current.bpm,
    detail: {
      ts: current.ts,
      source_app: current.source_app,
    },
  };
}

function latestHeartRateStatus(
  heartRate: HeartRateSummary | null | undefined,
  loading: boolean,
): { primary: string | null; secondary: string | null } | null {
  if (loading) return null;
  if (!heartRate?.current) return { primary: 'No recent heart data', secondary: null };
  const primary = `Last ${new Date(heartRate.current.ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
  const secondaryParts = [
    heartRate.sleeping_bpm != null ? `Sleep ${Math.round(heartRate.sleeping_bpm)}` : null,
    heartRate.resting_awake_bpm != null ? `Rest ${Math.round(heartRate.resting_awake_bpm)}` : null,
    heartRate.peak_bpm != null ? formatPeakHeartRate(heartRate) : null,
  ].filter(Boolean);
  return { primary, secondary: secondaryParts.join(' · ') || null };
}

function formatPeakHeartRate(heartRate: HeartRateSummary): string {
  const bpm = Math.round(heartRate.peak_bpm ?? 0);
  const label = heartRate.peak_label?.trim();
  return label ? `${label} ${bpm}` : `Peak ${bpm}`;
}

function statusForHero(
  def: HeroDef,
  row: DailyRow | undefined,
  fallbackActive: boolean,
  syncState: DeviceSyncState | undefined,
  loading: boolean,
): string | null {
  if (loading) return null;
  if (fallbackActive) return `Using ${def.fallbackLabel ?? 'related data'}`;
  if (row) return row.day;
  if (syncState?.granted === false) return 'Permission off';
  if (syncState?.has_local_data === false) return 'No phone data';
  if (syncState?.has_local_data === true) return 'No recent record';
  return 'No recent data';
}

function VitalPin({
  def,
  row,
  delta,
  days,
  loading,
  points,
  status,
  inlineStatus,
  secondaryStatus,
  fallbackActive,
}: {
  def: HeroDef;
  row?: DailyRow;
  delta: number | null;
  days: number;
  loading: boolean;
  points: string;
  status: string | null;
  inlineStatus?: string | null;
  secondaryStatus?: string | null;
  fallbackActive: boolean;
}) {
  const Icon = def.icon;
  const value = loading && !row ? '...' : row ? def.fmt(row.value) : '-';
  return (
    <article
      className={`health-vital-pin health-pin-${def.pin}`}
      style={{ '--accent': def.accent } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="vs-mono text-[10px] uppercase tracking-[0.18em]">{def.label}</div>
          <div className="mt-1 flex min-w-0 items-baseline gap-1">
            <span className="text-2xl font-semibold leading-none">{value}</span>
            {(def.unit && row) && (
              <span className="min-w-0 truncate text-[11px] font-medium text-slate-500">
                {def.unit}{inlineStatus ? ` · ${inlineStatus}` : ''}
              </span>
            )}
          </div>
          {status && (
            <div className={`mt-1 truncate text-[10px] font-medium ${fallbackActive ? 'text-amber-600' : 'text-slate-500'}`}>
              {status}
            </div>
          )}
          {secondaryStatus && (
            <div className="mt-0.5 truncate text-[10px] font-medium text-slate-500">
              {secondaryStatus}
            </div>
          )}
        </div>
        <div className="health-vital-icon">
          <Icon size={16} />
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        {points ? (
          <svg viewBox="0 0 92 24" className="h-7 w-24" aria-hidden="true">
            <polyline
              points={points}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <span className="health-micro-line" />
        )}
        {delta !== null && (
          <div className={delta >= 0 ? 'health-delta is-up' : 'health-delta is-down'}>
            {delta >= 0 ? '+' : ''}{delta}% / {days}d
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Health Hologram — right-side focus panel.
 *
 * Opens when an anchor is clicked: shows the region's current metric values plus
 * a 7-day mini-trend per metric. Closes on Escape or click-out (see
 * docs/superpowers/specs/2026-07-05-health-hologram-design.md — "clicking an
 * anchor opens a focus panel with current values and a 7-day mini-trend").
 *
 * Renders a simple inline sparkline (sparkPoints from lib/healthData.ts) rather
 * than importing components/health/HealthCharts.tsx, which is not structured as
 * a reusable mini-trend piece (it renders full recharts chart cards keyed off a
 * whole rows/range pair) and must not be modified for this task.
 */
import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { sparkPoints } from '../../../lib/healthData';
import type { AnchorConfig, FocusMetricTrend } from '../../../lib/holo';
import { formatFocusValue, softenColor } from '../../../lib/holo';

export interface FocusPanelProps {
  anchor: AnchorConfig;
  trends: FocusMetricTrend[];
  onClose: () => void;
}

export function FocusPanel({ anchor, trends, onClose }: FocusPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Softened to match the pale hologram palette everywhere else (dots/chips
  // use softenColor too, per lib/holo.ts::softenColor) — the panel only opens
  // for a clicked (active) anchor, so no dormant-gray case applies here.
  const color = useMemo(() => softenColor(anchor.color), [anchor.color]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handlePointerDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="holo-focus-panel"
      role="dialog"
      aria-label={`${anchor.label} detail`}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(340px, 88vw)',
        background: 'rgba(11, 18, 32, 0.92)',
        borderLeft: `1px solid ${color}`,
        color: '#E6FBF6',
        padding: '18px 16px',
        overflowY: 'auto',
        boxShadow: `-12px 0 32px rgba(0,0,0,0.35)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div
            className="vs-mono"
            style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.7 }}
          >
            Anchor
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: '2px 0 0', color }}>
            {anchor.label}
          </h2>
        </div>
        <button
          onClick={onClose}
          aria-label="Close panel"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9AA7BD',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          <X size={16} />
        </button>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {trends.map((trend) => (
          <FocusMetricRow key={trend.metric} trend={trend} color={color} />
        ))}
      </div>
    </div>
  );
}

function FocusMetricRow({ trend, color }: { trend: FocusMetricTrend; color: string }) {
  const hasData = trend.values.length > 0;
  const points = sparkPoints(trend.values, 120, 32);

  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: '10px 12px',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: '#9AA7BD' }}>{trend.label}</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {trend.latest !== null ? formatFocusValue(trend.metric, trend.latest) : '—'}
          {trend.unit && trend.latest !== null ? (
            <span style={{ fontSize: 11, fontWeight: 400, color: '#9AA7BD', marginLeft: 3 }}>
              {trend.unit}
            </span>
          ) : null}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        {hasData ? (
          <svg viewBox="0 0 120 32" width="100%" height={32} aria-hidden="true">
            <polyline
              points={points}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <div style={{ fontSize: 11, color: '#5A6B85' }}>No data in the last 7 days</div>
        )}
      </div>
    </div>
  );
}

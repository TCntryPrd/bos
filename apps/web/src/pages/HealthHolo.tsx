/**
 * Health Hologram page — Task 3 (final).
 *
 * Fetches trailing-30d data via the existing healthDataApi client, maps it to
 * per-anchor state with buildAnchorStates, and renders the Scene full-viewport
 * on a dark page with a compact header (back link, title, live date). Clicking
 * an anchor opens the FocusPanel with that region's metric values + a 7-day
 * mini-trend; it closes on Escape or click-out (handled inside FocusPanel).
 * Loading + unpaired/empty states follow Health.tsx's conventions (status chip
 * copy, pair-device card).
 *
 * See docs/superpowers/specs/2026-07-05-health-hologram-design.md.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Smartphone } from 'lucide-react';
import { healthDataApi, dateNDaysAgo } from '../lib/healthData';
import type { DailyRow, HealthOverview } from '../lib/healthData';
import { ANCHORS, buildAnchorStates, buildFocusTrend } from '../lib/holo';
import type { AnchorId } from '../lib/holo';
import { Scene } from '../components/health/holo/Scene';
import { FocusPanel } from '../components/health/holo/FocusPanel';
import { PageLoader } from '../components/LoadingSpinner';

const TRAILING_DAYS = 30;

export default function HealthHolo() {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<AnchorId | null>(null);

  const today = dateNDaysAgo(0);
  const from = dateNDaysAgo(TRAILING_DAYS - 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [daily, ov] = await Promise.all([
          healthDataApi.daily(from, today),
          healthDataApi.overview(),
        ]);
        if (cancelled) return;
        setRows(daily.days);
        setOverview(ov);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [from, today]);

  const anchorStates = useMemo(
    () => buildAnchorStates(overview, rows, today),
    [overview, rows, today],
  );

  const focusAnchor = focusId ? ANCHORS.find((a) => a.id === focusId) ?? null : null;
  const focusTrends = useMemo(
    () => (focusAnchor ? buildFocusTrend(focusAnchor, rows, today) : []),
    [focusAnchor, rows, today],
  );

  const handleAnchorClick = useCallback((id: AnchorId) => setFocusId(id), []);
  const closeFocus = useCallback(() => setFocusId(null), []);

  const paired = !!overview?.paired;
  const liveDateLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  return (
    /*
     * Definite-height page: the app shell (Layout.tsx) renders a h-screen flex
     * column with a h-10 (2.5rem) TopBar above a flex-1 overflow-y-auto <main>,
     * so the visible region below the shell header is exactly 100dvh - 2.5rem.
     * Giving the page root that explicit height (instead of min-height + flex,
     * which lets the flex-1 scene region collapse to content height) guarantees
     * the canvas region below our header fills the rest of the viewport.
     */
    <div
      className="aios-page min-h-full"
      style={{
        background: '#0B1220',
        height: 'calc(100dvh - 2.5rem)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          color: '#E6FBF6',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Link
            to="/health"
            className="inline-flex items-center gap-1.5 text-[12px]"
            style={{ color: '#9AA7BD' }}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to health
          </Link>
          <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0, letterSpacing: '0.02em' }}>
            Health Hologram
          </h1>
        </div>
        <span className="vs-mono" style={{ fontSize: 11, color: '#5A6B85' }}>{liveDateLabel}</span>
      </header>

      {error && (
        <div
          style={{
            margin: '10px 16px 0',
            padding: '8px 12px',
            borderRadius: 8,
            fontSize: 12,
            color: '#FCA5A5',
            background: 'rgba(220, 38, 38, 0.12)',
            border: '1px solid rgba(220, 38, 38, 0.35)',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {loading && !overview ? (
          <PageLoader />
        ) : overview && !paired ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                textAlign: 'center',
                color: '#E6FBF6',
                padding: 24,
                maxWidth: 320,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  margin: '0 auto 12px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(191, 234, 255, 0.12)',
                  color: '#BFEAFF',
                }}
              >
                <Smartphone size={20} />
              </div>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Pair your phone</h2>
              <p style={{ fontSize: 13, color: '#9AA7BD', marginTop: 8, lineHeight: 1.5 }}>
                Pair a device on the Health page to light up the hologram with live data.
              </p>
              <Link
                to="/health"
                className="health-device-button"
                style={{ marginTop: 14, display: 'inline-flex' }}
              >
                <Smartphone size={14} /> Go to Health
              </Link>
            </div>
          </div>
        ) : (
          <Scene anchorStates={anchorStates} onAnchorClick={handleAnchorClick} />
        )}

        {focusAnchor && (
          <FocusPanel anchor={focusAnchor} trends={focusTrends} onClose={closeFocus} />
        )}
      </div>
    </div>
  );
}

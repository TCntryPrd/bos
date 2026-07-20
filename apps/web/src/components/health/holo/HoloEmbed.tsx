/**
 * Health Hologram — chrome-less embeddable variant (Task: Health page scene).
 *
 * Renders the Scene transparent (alpha canvas, no background, no header) so it
 * can sit directly over the Health page's medical-suite scene art, replacing
 * the painted hologram tube. Sizes to whatever container it is given (the root
 * div is position:relative and the Scene fills it inset:0); the tighter
 * fitMargin makes the figure fill ~90% of the container height, and
 * align='top' top-aligns it (head ~5% from the canvas top, spare space below
 * the feet — owner pass: no dead room above the hologram). Slow
 * auto-rotate and reduced-motion handling come from Scene; label chips default
 * to 'dots' (hover-reveals a single chip + leader line) to keep the placement
 * clean — no chip renders until a dot is hovered. Clicking an anchor dot
 * navigates to the full /health/holo page.
 *
 * Resizing: a bottom-right corner grip (button, nwse-resize cursor) lets the
 * user drag the embed to any size within lib/holo.ts's clamp (min 240x360,
 * max ~90vw/92vh computed at drag time). The grip captures its pointer and
 * stops pointerdown propagation so the Health page's DraggableHealthItem
 * wrapper never starts a move-drag (same conflict class as the dot-click fix;
 * the wrapper also ignores pointerdowns on buttons). The chosen size persists
 * to localStorage ('bos-holo-embed-size') and, on mount, overrides the style
 * prop's width/height — so the style prop is only the pre-resize default.
 * Arrow keys nudge the focused grip by 16px per press.
 *
 * Data: self-fetches the trailing 30 days via the existing healthDataApi client
 * (same pattern as pages/HealthHolo.tsx) unless `overview`/`rows` props are
 * provided, in which case no fetch happens. Fetch errors degrade silently to an
 * all-dormant figure — an embed has no chrome for error banners.
 *
 * See docs/superpowers/specs/2026-07-05-health-hologram-design.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { healthDataApi, dateNDaysAgo } from '../../../lib/healthData';
import type { DailyRow, HealthOverview } from '../../../lib/healthData';
import {
  buildAnchorStates,
  clampEmbedSize,
  embedMaxSize,
  loadEmbedSize,
  saveEmbedSize,
} from '../../../lib/holo';
import type { EmbedSize } from '../../../lib/holo';
import { Scene } from './Scene';
import type { LabelMode } from './Scene';

const TRAILING_DAYS = 30;
const NO_ROWS: DailyRow[] = [];

export interface HoloEmbedProps {
  /**
   * Optional externally supplied data. When either prop is present the embed
   * skips its own fetch entirely; `rows` should cover the trailing ~30 days
   * for correct anchor dormancy (see lib/holo.ts).
   */
  overview?: HealthOverview | null;
  rows?: DailyRow[];
  /** Label detail — embeds default to hover-reveal 'dots'. */
  labels?: LabelMode;
  className?: string;
  /** Shows the corner resize grip. Health page passes false when layout is locked. */
  resizable?: boolean;
  /** The embed sizes to its container: pass width/height here or via className. */
  style?: CSSProperties;
}

export default function HoloEmbed({
  overview: overviewProp,
  rows: rowsProp,
  labels = 'dots',
  className,
  resizable = true,
  style,
}: HoloEmbedProps) {
  const navigate = useNavigate();
  const external = overviewProp !== undefined || rowsProp !== undefined;
  const [fetched, setFetched] = useState<{
    overview: HealthOverview | null;
    rows: DailyRow[];
  } | null>(null);

  const today = dateNDaysAgo(0);
  const from = dateNDaysAgo(TRAILING_DAYS - 1);

  useEffect(() => {
    if (external) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [daily, ov] = await Promise.all([
          healthDataApi.daily(from, today),
          healthDataApi.overview(),
        ]);
        if (cancelled) return;
        setFetched({ overview: ov, rows: daily.days });
      } catch {
        // No chrome to surface errors in — fall back to the dormant figure.
        if (!cancelled) setFetched({ overview: null, rows: NO_ROWS });
      }
    })();
    return () => { cancelled = true; };
  }, [external, from, today]);

  const overview = external ? overviewProp ?? null : fetched?.overview ?? null;
  const rows = external ? rowsProp ?? NO_ROWS : fetched?.rows ?? NO_ROWS;

  const anchorStates = useMemo(
    () => buildAnchorStates(overview, rows, today),
    [overview, rows, today],
  );

  const openHolo = useCallback(() => navigate('/health/holo'), [navigate]);

  // Corner-drag resize (see file header). `size` is null until the user has
  // ever resized — the style prop's width/height stay in effect as the default.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<EmbedSize | null>(() => {
    if (typeof window === 'undefined') return null;
    const saved = loadEmbedSize(window.localStorage);
    return saved ? clampEmbedSize(saved, embedMaxSize(window.innerWidth, window.innerHeight)) : null;
  });
  // Mirrors `size` synchronously during a drag so pointerup persists the final
  // value without depending on a state flush.
  const liveSizeRef = useRef<EmbedSize | null>(size);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onGripPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    // Never let this reach the parent DraggableHealthItem (Health.tsx): its
    // wrapper-level pointer capture would move the embed instead of resizing.
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startW: rect.width,
      startH: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onGripPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampEmbedSize(
      {
        w: drag.startW + (event.clientX - drag.startX),
        h: drag.startH + (event.clientY - drag.startY),
      },
      embedMaxSize(window.innerWidth, window.innerHeight),
    );
    liveSizeRef.current = next;
    setSize(next);
  }, []);

  const endGripDrag = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (liveSizeRef.current) saveEmbedSize(window.localStorage, liveSizeRef.current);
  }, []);

  const onGripKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    const STEP = 16;
    let dw = 0;
    let dh = 0;
    if (event.key === 'ArrowRight') dw = STEP;
    else if (event.key === 'ArrowLeft') dw = -STEP;
    else if (event.key === 'ArrowDown') dh = STEP;
    else if (event.key === 'ArrowUp') dh = -STEP;
    else return;
    event.preventDefault();
    event.stopPropagation();
    const rect = rootRef.current?.getBoundingClientRect();
    const base = liveSizeRef.current ?? (rect ? { w: rect.width, h: rect.height } : null);
    if (!base) return;
    const next = clampEmbedSize(
      { w: base.w + dw, h: base.h + dh },
      embedMaxSize(window.innerWidth, window.innerHeight),
    );
    liveSizeRef.current = next;
    setSize(next);
    saveEmbedSize(window.localStorage, next);
  }, []);

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        ...style,
        ...(size ? { width: size.w, height: size.h } : null),
      }}
    >
      <Scene
        anchorStates={anchorStates}
        onAnchorClick={openHolo}
        labels={labels}
        transparent
        orbit={false}
        fitMargin={1.05}
        align="top"
      />
      {resizable && (
        <button
          type="button"
          aria-label="Resize hologram — drag the corner, or press arrow keys to nudge"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={endGripDrag}
          onPointerCancel={endGripDrag}
          onKeyDown={onGripKeyDown}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            padding: 2,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'flex-end',
            background: 'transparent',
            border: 'none',
            cursor: 'nwse-resize',
            touchAction: 'none',
            color: 'rgba(191, 234, 255, 0.55)',
          }}
        >
          {/* Subtle diagonal-lines resize affordance. */}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ display: 'block' }}>
            <path
              d="M11 1 1 11 M11 5 5 11 M11 9 9 11"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

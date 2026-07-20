/**
 * Health Hologram — pure anchor config + anchor-state mapping (no React, no three.js).
 * Maps existing healthData.ts overview/daily rows onto body-region anchors for the
 * 3D hologram view (see docs/superpowers/specs/2026-07-05-health-hologram-design.md).
 *
 * Dormant = no data for any of the anchor's metrics in the trailing 30 days.
 * Unit-tested in node; no DOM/WebGL involved.
 */

import { fmtHm, fmtInt, HEALTH_COLORS } from './healthData';
import type { DailyRow, HealthOverview } from './healthData';

export type AnchorId = 'head' | 'heart' | 'lungs' | 'arm' | 'core' | 'belly' | 'legs';

export interface AnchorConfig {
  id: AnchorId;
  label: string;
  /** Position on the normalized human mesh (feet y=0, head top ≈1.97). */
  position: readonly [number, number, number];
  color: string;
  /** health_daily metric names this anchor represents. */
  metrics: readonly string[];
  /** Shown when dormant, hinting how to wake this anchor. */
  dormantHint: string;
}

/*
 * Anchor positions sit on the real human mesh (public/holo/figure.glb — the
 * CC0 Quaternius UBC body re-posed ARMS-DOWN and re-baked; see
 * components/health/holo/HoloFigure.tsx), normalized to feet y=0 / head top
 * ≈1.97: model space × (1.97 / bbox height 1.8196 = 1.082664), y offset
 * -min.y (0.0095). Every position derives from surface probes of the baked
 * mesh (nearest vertex ≤0.7 mm): head crown (0, 1.810, -0.003); left-chest
 * front (±0.031, 1.334, 0.125); chest front above the heart
 * (0.033, 1.382, 0.120); upper-arm outer surface AT THE SIDE
 * (±0.262, 1.321, -0.073); navel (0.023, 1.107, 0.107); upper-abdomen front
 * (0.051, 1.189, 0.103); mid-thigh outer surface (0.194, 0.757, -0.052).
 * Handedness (verified against the mesh: nose, toes, and elbow bend all
 * point +z): the figure faces +z, so anatomical left = +x — but the anchors
 * keep this file's existing viewer-left = -x sign convention (scene camera
 * sits at +z), so the heart/BP-arm probes are x-mirrored onto the symmetric
 * mesh (mirror surface distance verified ≤0.4 mm). Keep each anchor's x-sign
 * and the y ordering deliberate: assignLabelSlots derives chip columns/rows
 * from them (left/right columns stay balanced within one chip).
 */
export const ANCHORS: readonly AnchorConfig[] = [
  {
    id: 'head',
    label: 'Sleep',
    position: [0, 1.97, -0.003],
    color: HEALTH_COLORS.sleepDeep,
    metrics: ['sleep_minutes'],
    dormantHint: 'Wear your device overnight to log a sleep session.',
  },
  {
    id: 'heart',
    label: 'Heart',
    position: [-0.034, 1.455, 0.135],
    color: HEALTH_COLORS.heart,
    metrics: ['hr_avg', 'resting_hr', 'hrv_rmssd'],
    dormantHint: 'Pair a heart-rate capable device to see live BPM here.',
  },
  {
    id: 'lungs',
    label: 'Respiratory',
    position: [0.036, 1.506, 0.13],
    color: '#0EA5E9',
    metrics: ['spo2_avg', 'respiratory_rate_avg'],
    dormantHint: 'SpO2/respiratory readings appear once your device records them.',
  },
  {
    id: 'arm',
    label: 'Blood Pressure',
    position: [-0.284, 1.44, -0.079],
    color: '#0EA5E9',
    metrics: ['bp_systolic', 'bp_diastolic'],
    dormantHint: 'Log a blood pressure reading to activate this anchor.',
  },
  {
    id: 'core',
    label: 'Body Composition',
    position: [0.025, 1.209, 0.116],
    color: HEALTH_COLORS.body,
    metrics: ['weight_kg', 'body_fat_pct', 'lean_mass_kg', 'bmr_kcal'],
    dormantHint: 'A smart scale sync will populate weight and body composition.',
  },
  {
    id: 'belly',
    label: 'Nutrition & Hydration',
    position: [0.056, 1.298, 0.111],
    color: HEALTH_COLORS.activity,
    metrics: ['hydration_ml', 'nutrition_kcal'],
    dormantHint: 'Log meals or water intake to light this anchor up.',
  },
  {
    id: 'legs',
    label: 'Activity',
    position: [0.21, 0.83, -0.056],
    color: HEALTH_COLORS.activity,
    metrics: ['steps', 'distance_m', 'floors', 'active_kcal', 'exercise_minutes'],
    dormantHint: 'Steps and workouts show up here once your device syncs movement.',
  },
] as const;

/**
 * Softens a hex color toward the hologram's pale low-saturation palette:
 * blends each channel toward the pixel's luma (desaturate, default 80% per
 * the scene-matched palette spec) and then toward white (lighten) so softened
 * glows stay readable on the dark scene. Non-#RRGGBB inputs pass through.
 */
export function softenColor(hex: string, desaturate = 0.8, lighten = 0.25): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => c / 255);
  const luma = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const out = channels
    .map((c) => c + (luma - c) * desaturate)
    .map((c) => c + (1 - c) * lighten)
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
  return `#${out.toUpperCase()}`;
}

export interface AnchorState {
  id: AnchorId;
  /** Formatted current-value lines, one per metric with data (most-recent value). */
  lines: string[];
  /** True if any of the anchor's metrics has a data point in the trailing 30 days. */
  active: boolean;
  /** Heart anchor only: latest hr_avg, falling back to resting_hr, for pulse animation. */
  pulseBpm?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Metric-specific display formatting, mirroring Health.tsx's HEROES formatters. */
function formatMetricValue(metric: string, value: number): string {
  switch (metric) {
    case 'sleep_minutes':
    case 'exercise_minutes':
      return fmtHm(value);
    case 'steps':
    case 'distance_m':
    case 'floors':
    case 'active_kcal':
    case 'total_kcal':
    case 'hydration_ml':
    case 'nutrition_kcal':
    case 'bmr_kcal':
      return fmtInt(value);
    case 'hr_avg':
    case 'resting_hr':
    case 'hr_min':
    case 'hr_max':
    case 'bp_systolic':
    case 'bp_diastolic':
      return `${Math.round(value)}`;
    case 'hrv_rmssd':
    case 'respiratory_rate_avg':
      return `${Math.round(value * 10) / 10}`;
    case 'spo2_avg':
    case 'body_fat_pct':
      return `${value.toFixed(1)}`;
    case 'weight_kg':
    case 'lean_mass_kg':
    case 'body_temp_c':
      return value.toFixed(1);
    default:
      return fmtInt(value);
  }
}

const METRIC_LABELS: Record<string, string> = {
  sleep_minutes: 'Sleep',
  hr_avg: 'Avg HR',
  resting_hr: 'Resting HR',
  hrv_rmssd: 'HRV',
  spo2_avg: 'SpO2',
  respiratory_rate_avg: 'Resp. rate',
  bp_systolic: 'Systolic',
  bp_diastolic: 'Diastolic',
  weight_kg: 'Weight',
  body_fat_pct: 'Body fat',
  lean_mass_kg: 'Lean mass',
  bmr_kcal: 'BMR',
  hydration_ml: 'Hydration',
  nutrition_kcal: 'Nutrition',
  steps: 'Steps',
  distance_m: 'Distance',
  floors: 'Floors',
  active_kcal: 'Active energy',
  exercise_minutes: 'Exercise',
};

const METRIC_UNITS: Record<string, string> = {
  hr_avg: 'bpm',
  resting_hr: 'bpm',
  hrv_rmssd: 'ms',
  spo2_avg: '%',
  respiratory_rate_avg: 'rpm',
  bp_systolic: 'mmHg',
  bp_diastolic: 'mmHg',
  weight_kg: 'kg',
  body_fat_pct: '%',
  lean_mass_kg: 'kg',
  bmr_kcal: 'kcal/day',
  hydration_ml: 'ml',
  nutrition_kcal: 'kcal',
  distance_m: 'm',
  active_kcal: 'kcal',
};

function formatLine(metric: string, value: number): string {
  const label = METRIC_LABELS[metric] ?? metric;
  const formatted = formatMetricValue(metric, value);
  const unit = METRIC_UNITS[metric];
  return unit ? `${label}: ${formatted} ${unit}` : `${label}: ${formatted}`;
}

/**
 * Builds per-anchor display state from the existing healthData overview + trailing
 * daily rows. `rows` should cover at least the trailing 30 days for correct dormancy
 * classification; `todayISO` is the reference date (YYYY-MM-DD) "now" is measured from.
 */
export function buildAnchorStates(
  overview: HealthOverview | null,
  rows: DailyRow[],
  todayISO: string,
): Record<AnchorId, AnchorState> {
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  const cutoffISO = Number.isFinite(todayMs)
    ? new Date(todayMs - 30 * MS_PER_DAY).toISOString().slice(0, 10)
    : todayISO;

  // Latest value per metric within the trailing-30d window (rows outside the
  // window never activate an anchor or contribute a display line).
  const latestInWindow = new Map<string, DailyRow>();
  for (const row of rows) {
    if (row.day < cutoffISO || row.day > todayISO) continue;
    const cur = latestInWindow.get(row.metric);
    if (!cur || row.day > cur.day) latestInWindow.set(row.metric, row);
  }

  const out = {} as Record<AnchorId, AnchorState>;

  for (const anchor of ANCHORS) {
    const lines: string[] = [];
    let active = false;

    for (const metric of anchor.metrics) {
      const row = latestInWindow.get(metric);
      if (!row) continue;
      active = true;
      lines.push(formatLine(metric, row.value));
    }

    const state: AnchorState = { id: anchor.id, lines, active };

    if (anchor.id === 'heart') {
      const hrRow = latestInWindow.get('hr_avg');
      const restingRow = latestInWindow.get('resting_hr');
      const pulseSource = hrRow ?? restingRow;
      if (pulseSource) state.pulseBpm = Math.round(pulseSource.value);
      else if (overview?.today?.resting_hr !== undefined) {
        state.pulseBpm = Math.round(overview.today.resting_hr);
      }
    }

    out[anchor.id] = state;
  }

  return out;
}

export interface FocusMetricTrend {
  metric: string;
  label: string;
  unit?: string;
  /** Chronological (oldest→newest) values in the trailing window, one per day with data. */
  values: number[];
  /** Same length as values; YYYY-MM-DD for each point. */
  days: string[];
  latest: number | null;
}

/**
 * Builds the focus-panel detail for one anchor: per-metric current values plus a
 * trailing-window trend (default 7 days) for a mini-sparkline. Pure — no chart
 * library involved; the caller renders `values` however it likes.
 */
export function buildFocusTrend(
  anchor: AnchorConfig,
  rows: DailyRow[],
  todayISO: string,
  windowDays = 7,
): FocusMetricTrend[] {
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  const cutoffISO = Number.isFinite(todayMs)
    ? new Date(todayMs - (windowDays - 1) * MS_PER_DAY).toISOString().slice(0, 10)
    : todayISO;

  return anchor.metrics.map((metric) => {
    const inWindow = rows
      .filter((r) => r.metric === metric && r.day >= cutoffISO && r.day <= todayISO)
      .sort((a, b) => a.day.localeCompare(b.day));
    const values = inWindow.map((r) => r.value);
    const days = inWindow.map((r) => r.day);
    return {
      metric,
      label: METRIC_LABELS[metric] ?? metric,
      unit: METRIC_UNITS[metric],
      values,
      days,
      latest: values.length ? values[values.length - 1] : null,
    };
  });
}

/** Formats a single metric value the same way the anchor state lines do (label-free). */
export function formatFocusValue(metric: string, value: number): string {
  return formatMetricValue(metric, value);
}

// ---------------------------------------------------------------------------
// Embed sizing — corner-drag resize clamp + persistence (pure; storage is
// injected so tests run in node). Used by HoloEmbed's bottom-right grip.
// ---------------------------------------------------------------------------

export interface EmbedSize {
  w: number;
  h: number;
}

/** localStorage key the Health-page embed persists its user-dragged size under. */
export const EMBED_SIZE_KEY = 'bos-holo-embed-size';

/** Smallest useful embed — below this the figure and hover chips get unreadable. */
export const EMBED_MIN_SIZE: EmbedSize = { w: 240, h: 360 } as const;

/** Largest allowed embed for a viewport — the 90vw / 92vh equivalents in px. */
export function embedMaxSize(viewportW: number, viewportH: number): EmbedSize {
  return { w: Math.round(viewportW * 0.9), h: Math.round(viewportH * 0.92) };
}

/**
 * Clamps a candidate embed size into [EMBED_MIN_SIZE, max], rounding to whole
 * px. When the viewport max dips below the minimum (tiny windows) the minimum
 * wins, so the embed never collapses below usability.
 */
export function clampEmbedSize(size: EmbedSize, max: EmbedSize): EmbedSize {
  return {
    w: Math.round(Math.min(Math.max(size.w, EMBED_MIN_SIZE.w), Math.max(max.w, EMBED_MIN_SIZE.w))),
    h: Math.round(Math.min(Math.max(size.h, EMBED_MIN_SIZE.h), Math.max(max.h, EMBED_MIN_SIZE.h))),
  };
}

/** The storage surface the persistence helpers need (injected for tests). */
export type EmbedSizeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Reads the persisted embed size. Returns null (caller falls back to its
 * default sizing) when the key is absent or corrupt — bad JSON, missing or
 * non-finite or non-positive dimensions — or when storage access throws.
 */
export function loadEmbedSize(storage: EmbedSizeStorage): EmbedSize | null {
  try {
    const raw = storage.getItem(EMBED_SIZE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { w, h } = parsed as { w?: unknown; h?: unknown };
    if (typeof w !== 'number' || typeof h !== 'number') return null;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w, h };
  } catch {
    return null;
  }
}

/** Persists the embed size; storage failures (quota, private mode) are swallowed. */
export function saveEmbedSize(storage: EmbedSizeStorage, size: EmbedSize): void {
  try {
    storage.setItem(
      EMBED_SIZE_KEY,
      JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) }),
    );
  } catch {
    // Best-effort — a failed write only loses the remembered size.
  }
}

// ---------------------------------------------------------------------------
// Embed framing — top-aligned camera fit offset (pure math, no three.js).
// Scene.tsx's align='top' fitter (used by HoloEmbed) applies this world-space
// Δy to the centered Bounds fit so the figure's head hugs the canvas top and
// the spare space falls below the feet instead of above the head.
// ---------------------------------------------------------------------------

export interface FitTopOffsetOptions {
  /** Bounds fit margin (Scene's fitMargin; the embed passes 1.05). */
  margin?: number;
  /** Fraction of the canvas height left above the figure's head (~4-6% spec). */
  topGapFrac?: number;
  /**
   * Largest bounding-box dimension of the fitted content; drei sizes the fit
   * distance from this. Defaults to figureHeight (the holo figure envelope is
   * height-dominant: ~1.97 tall vs ~0.66 wide, arms at the sides).
   */
  maxSize?: number;
}

/**
 * World-space Δy to add to a centered drei <Bounds> fit's camera position AND
 * look-target (a pure translation — view direction unchanged) so the top of
 * the figure sits `topGapFrac` of the canvas height below the canvas top.
 *
 * Mirrors drei Bounds' getSize() fit-distance math for perspective cameras —
 * including its Math.atan-in-place-of-tan quirk (a small-angle approximation
 * drei ships with; verified against @react-three/drei@9.122.0) — then compares
 * the true visible half-height at the target depth against the figure
 * envelope. Result is always <= 0 (never pushes the figure DOWN when the
 * window is already tight, e.g. sub-1 margins in landscape containers) and 0
 * for degenerate inputs (empty/negative container, non-finite dims, bad fov).
 */
export function fitTopOffset(
  containerW: number,
  containerH: number,
  figureHeight: number,
  fovDeg: number,
  { margin = 1.05, topGapFrac = 0.05, maxSize = figureHeight }: FitTopOffsetOptions = {},
): number {
  if (!Number.isFinite(containerW) || containerW <= 0) return 0;
  if (!Number.isFinite(containerH) || containerH <= 0) return 0;
  if (!Number.isFinite(figureHeight) || figureHeight <= 0) return 0;
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) return 0;
  if (!Number.isFinite(maxSize) || maxSize <= 0) return 0;
  if (!Number.isFinite(margin) || margin <= 0) return 0;

  const aspect = containerW / containerH;
  // drei Bounds getSize(): fitHeightDistance uses atan (not tan) of the half-fov.
  const fitHeightDistance = maxSize / (2 * Math.atan((Math.PI * fovDeg) / 360));
  const fitWidthDistance = fitHeightDistance / aspect;
  const distance = margin * Math.max(fitHeightDistance, fitWidthDistance);
  // True visible half-height at the fitted look-target depth.
  const halfVisible = distance * Math.tan((fovDeg * Math.PI) / 360);
  // Centered fit puts the box mid-window: gap above head = halfVisible - H/2.
  // Shift the window down so the gap becomes topGapFrac of the full height.
  const offset = figureHeight / 2 + halfVisible * (2 * topGapFrac - 1);
  return Math.min(0, offset);
}

// ---------------------------------------------------------------------------
// Label slot assignment — medical-diagram chip columns beside the figure.
// Dots stay on the body; each anchor's label chip is placed in one of two
// outer columns (left/right) with a fixed row so chips can never overlap.
// ---------------------------------------------------------------------------

export type LabelSide = 'left' | 'right';

export interface LabelSlot {
  side: LabelSide;
  /** 0-based row from the top within this side's column. */
  row: number;
  /** Total rows on this side, for computing evenly spaced slot positions. */
  rows: number;
}

/**
 * Assigns each anchor a chip slot in one of two outer label columns.
 *
 * Deterministic rules (stable for a given anchor list):
 * 1. Anchors are processed top-to-bottom (descending y; ties keep input order),
 *    so chip row order always follows body position.
 * 2. Side comes from the anchor's x-sign: x <= -eps goes left, x >= eps goes
 *    right; centered anchors (|x| < eps) go to whichever side currently has
 *    fewer chips (ties go left), keeping the columns balanced within one chip.
 *    The default eps (0.03) sits below the arms-down bake's chest probes
 *    (|x| ≈ 0.034-0.036) so heart/lungs stay deliberately sided by x-sign.
 * 3. Rows are consecutive (0..rows-1) per side — no two chips ever share a
 *    side+row pair, so a fixed-slot renderer cannot draw overlapping chips.
 */
export function assignLabelSlots(
  anchors: readonly AnchorConfig[],
  eps = 0.03,
): Record<AnchorId, LabelSlot> {
  const ordered = anchors
    .map((anchor, index) => ({ anchor, index }))
    .sort((a, b) => b.anchor.position[1] - a.anchor.position[1] || a.index - b.index);

  const columns: Record<LabelSide, AnchorId[]> = { left: [], right: [] };
  for (const { anchor } of ordered) {
    const x = anchor.position[0];
    let side: LabelSide;
    if (x <= -eps) side = 'left';
    else if (x >= eps) side = 'right';
    else side = columns.left.length <= columns.right.length ? 'left' : 'right';
    columns[side].push(anchor.id);
  }

  const out = {} as Record<AnchorId, LabelSlot>;
  for (const side of ['left', 'right'] as const) {
    const column = columns[side];
    column.forEach((id, row) => {
      out[id] = { side, row, rows: column.length };
    });
  }
  return out;
}

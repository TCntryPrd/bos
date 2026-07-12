import { describe, it, expect } from 'vitest';
import {
  ANCHORS,
  EMBED_MIN_SIZE,
  EMBED_SIZE_KEY,
  assignLabelSlots,
  buildAnchorStates,
  buildFocusTrend,
  clampEmbedSize,
  embedMaxSize,
  fitTopOffset,
  formatFocusValue,
  loadEmbedSize,
  saveEmbedSize,
  softenColor,
} from './holo';
import type { AnchorConfig } from './holo';
import type { DailyRow, HealthOverview } from './healthData';

const TODAY = '2026-07-05';

function row(metric: string, value: number, day: string): DailyRow {
  return { day, metric, value, detail: {} };
}

function overview(partial: Partial<HealthOverview> = {}): HealthOverview {
  return {
    paired: true,
    last_sync_at: `${TODAY}T08:00:00Z`,
    today: {},
    spark: { steps: [], sleep_minutes: [], resting_hr: [], active_kcal: [] },
    sleep_detail: null,
    ...partial,
  };
}

describe('ANCHORS', () => {
  it('covers all seven body regions with unique ids and non-empty metrics', () => {
    const ids = ANCHORS.map((a) => a.id);
    expect(ids).toEqual(['head', 'heart', 'lungs', 'arm', 'core', 'belly', 'legs']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const anchor of ANCHORS) {
      expect(anchor.metrics.length).toBeGreaterThan(0);
      expect(anchor.dormantHint.length).toBeGreaterThan(0);
      expect(anchor.position).toHaveLength(3);
    }
  });
});

describe('buildAnchorStates', () => {
  it('marks an anchor active when a metric has data within the trailing 30 days', () => {
    const rows = [row('steps', 8123, TODAY)];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.legs.active).toBe(true);
    expect(out.legs.lines).toEqual(['Steps: 8,123']);
  });

  it('marks an anchor dormant when its metrics have no data at all', () => {
    const out = buildAnchorStates(overview(), [], TODAY);
    expect(out.arm.active).toBe(false);
    expect(out.arm.lines).toEqual([]);
  });

  it('marks an anchor dormant when its only data point is older than 30 days', () => {
    const rows = [row('weight_kg', 81.4, '2026-05-01')]; // 65 days before TODAY
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.core.active).toBe(false);
    expect(out.core.lines).toEqual([]);
  });

  it('includes a metric right at the 30-day boundary as active', () => {
    // cutoff is TODAY - 30 days; a row exactly on the cutoff day should count.
    const rows = [row('hydration_ml', 1500, '2026-06-05')];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.belly.active).toBe(true);
  });

  it('excludes rows dated after todayISO (future/out-of-window data)', () => {
    const rows = [row('steps', 500, '2026-07-06')];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.legs.active).toBe(false);
  });

  it('formats multiple metrics for a multi-metric anchor using the latest value per metric', () => {
    const rows = [
      row('weight_kg', 80.2, '2026-07-01'),
      row('weight_kg', 79.8, '2026-07-04'), // more recent, should win
      row('body_fat_pct', 18.3, '2026-07-03'),
    ];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.core.active).toBe(true);
    expect(out.core.lines).toEqual(['Weight: 79.8 kg', 'Body fat: 18.3 %']);
  });

  it('formats sleep minutes and exercise minutes with fmtHm-style h/m formatting', () => {
    const rows = [row('sleep_minutes', 452, TODAY), row('exercise_minutes', 47, TODAY)];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.head.lines).toEqual(['Sleep: 7h 32m']);
    expect(out.legs.lines).toContain('Exercise: 0h 47m');
  });

  it('selects hr_avg as pulseBpm when present', () => {
    const rows = [row('hr_avg', 71, TODAY), row('resting_hr', 58, TODAY)];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.heart.pulseBpm).toBe(71);
  });

  it('falls back to resting_hr for pulseBpm when hr_avg is absent', () => {
    const rows = [row('resting_hr', 55, TODAY)];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.heart.pulseBpm).toBe(55);
  });

  it('falls back to overview.today.resting_hr when no daily rows have heart data', () => {
    const out = buildAnchorStates(overview({ today: { resting_hr: 62 } }), [], TODAY);
    expect(out.heart.pulseBpm).toBe(62);
    expect(out.heart.active).toBe(false); // overview fallback doesn't itself activate the anchor
  });

  it('leaves pulseBpm undefined when there is no heart data anywhere', () => {
    const out = buildAnchorStates(overview(), [], TODAY);
    expect(out.heart.pulseBpm).toBeUndefined();
  });

  it('handles a null overview and empty rows without throwing (fully dormant state)', () => {
    const out = buildAnchorStates(null, [], TODAY);
    for (const anchor of ANCHORS) {
      expect(out[anchor.id].active).toBe(false);
      expect(out[anchor.id].lines).toEqual([]);
    }
    expect(out.heart.pulseBpm).toBeUndefined();
  });

  it('formats blood pressure, hrv, and spo2 metrics with expected precision', () => {
    const rows = [
      row('bp_systolic', 118.6, TODAY),
      row('bp_diastolic', 76.2, TODAY),
      row('hrv_rmssd', 42.37, TODAY),
      row('spo2_avg', 97.6, TODAY),
    ];
    const out = buildAnchorStates(overview(), rows, TODAY);
    expect(out.arm.lines).toEqual(['Systolic: 119 mmHg', 'Diastolic: 76 mmHg']);
    expect(out.heart.lines).toContain('HRV: 42.4 ms');
    expect(out.lungs.lines).toContain('SpO2: 97.6 %');
  });
});

describe('buildFocusTrend', () => {
  const legsAnchor = ANCHORS.find((a) => a.id === 'legs')!;
  const heartAnchor = ANCHORS.find((a) => a.id === 'heart')!;

  it('returns one entry per anchor metric, ordered oldest to newest within the window', () => {
    const rows = [
      row('steps', 9000, '2026-07-03'),
      row('steps', 7000, '2026-07-01'),
      row('steps', 8000, '2026-07-02'),
    ];
    const out = buildFocusTrend(legsAnchor, rows, TODAY);
    const steps = out.find((m) => m.metric === 'steps')!;
    expect(steps.values).toEqual([7000, 8000, 9000]);
    expect(steps.days).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(steps.latest).toBe(9000);
  });

  it('excludes rows outside the default 7-day trailing window', () => {
    const rows = [row('steps', 5000, '2026-06-20')]; // 15 days before TODAY
    const out = buildFocusTrend(legsAnchor, rows, TODAY);
    const steps = out.find((m) => m.metric === 'steps')!;
    expect(steps.values).toEqual([]);
    expect(steps.latest).toBeNull();
  });

  it('respects a custom windowDays argument', () => {
    const rows = [row('steps', 5000, '2026-06-20')]; // 15 days before TODAY
    const out = buildFocusTrend(legsAnchor, rows, TODAY, 30);
    const steps = out.find((m) => m.metric === 'steps')!;
    expect(steps.values).toEqual([5000]);
    expect(steps.latest).toBe(5000);
  });

  it('carries label and unit metadata for each metric', () => {
    const out = buildFocusTrend(heartAnchor, [], TODAY);
    const hrAvg = out.find((m) => m.metric === 'hr_avg')!;
    expect(hrAvg.label).toBe('Avg HR');
    expect(hrAvg.unit).toBe('bpm');
  });

  it('returns empty-values entries (not throwing) when there is no data at all', () => {
    const out = buildFocusTrend(legsAnchor, [], TODAY);
    expect(out.every((m) => m.values.length === 0 && m.latest === null)).toBe(true);
  });
});

describe('formatFocusValue', () => {
  it('formats using the same rules as anchor-state line formatting', () => {
    expect(formatFocusValue('steps', 8123)).toBe('8,123');
    expect(formatFocusValue('sleep_minutes', 452)).toBe('7h 32m');
    expect(formatFocusValue('spo2_avg', 97.6)).toBe('97.6');
  });
});

describe('softenColor', () => {
  it('desaturates and lightens semantic anchor colors to muted pastels (defaults)', () => {
    expect(softenColor('#FF4D8D')).toBe('#AE939D'); // heart pink → muted rose
    expect(softenColor('#0EA5E9')).toBe('#95ABB5'); // body blue → muted steel
    expect(softenColor('#3FE0C5')).toBe('#BAD2CE'); // old hard teal → pale cyan-gray
  });

  it('reduces channel spread (saturation) while keeping the hue ordering', () => {
    const soft = softenColor('#FF4D8D'); // r > b > g must survive softening
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(soft.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(g);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0xff - 0x4d); // < original spread
  });

  it('is the identity for desaturate=0 lighten=0, and hits white at lighten=1', () => {
    expect(softenColor('#FF4D8D', 0, 0)).toBe('#FF4D8D');
    expect(softenColor('#123456', 0, 1)).toBe('#FFFFFF');
  });

  it('leaves pure grays unchanged by desaturation', () => {
    expect(softenColor('#808080', 0.8, 0)).toBe('#808080');
  });

  it('passes non-#RRGGBB inputs through untouched', () => {
    expect(softenColor('teal')).toBe('teal');
    expect(softenColor('#FFF')).toBe('#FFF');
  });

  it('softens every anchor color to a valid hex color', () => {
    for (const anchor of ANCHORS) {
      expect(softenColor(anchor.color)).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('assignLabelSlots', () => {
  /** Minimal AnchorConfig for synthetic layout cases (only id/position matter here). */
  function cfg(id: AnchorConfig['id'], position: readonly [number, number, number]): AnchorConfig {
    return { id, label: id, position, color: '#fff', metrics: ['steps'], dormantHint: 'hint' };
  }

  it('assigns every anchor exactly one slot with no side+row collisions (no overlap)', () => {
    const slots = assignLabelSlots(ANCHORS);
    const keys = ANCHORS.map((a) => {
      const slot = slots[a.id];
      expect(slot).toBeDefined();
      return `${slot.side}:${slot.row}`;
    });
    expect(new Set(keys).size).toBe(ANCHORS.length);
  });

  it('uses consecutive rows per side and reports the matching total row count', () => {
    const slots = assignLabelSlots(ANCHORS);
    for (const side of ['left', 'right'] as const) {
      const rows = ANCHORS.filter((a) => slots[a.id].side === side)
        .map((a) => slots[a.id].row)
        .sort((a, b) => a - b);
      expect(rows).toEqual(rows.map((_, i) => i)); // 0..n-1, no gaps
      for (const a of ANCHORS) {
        if (slots[a.id].side === side) expect(slots[a.id].rows).toBe(rows.length);
      }
    }
  });

  it('sides off-center anchors by x-sign and keeps the columns balanced within one chip', () => {
    const slots = assignLabelSlots(ANCHORS);
    expect(slots.heart.side).toBe('left'); // x = -0.034 (chest, viewer-left)
    expect(slots.lungs.side).toBe('right'); // x = +0.036
    expect(slots.arm.side).toBe('left'); // x = -0.284 (upper arm at the side, viewer-left)
    const left = ANCHORS.filter((a) => slots[a.id].side === 'left').length;
    const right = ANCHORS.filter((a) => slots[a.id].side === 'right').length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  });

  it('orders rows top-to-bottom by anchor height within each side (stable ordering)', () => {
    const slots = assignLabelSlots(ANCHORS);
    for (const side of ['left', 'right'] as const) {
      const ys = ANCHORS.filter((a) => slots[a.id].side === side)
        .sort((a, b) => slots[a.id].row - slots[b.id].row)
        .map((a) => a.position[1]);
      const sorted = [...ys].sort((a, b) => b - a);
      expect(ys).toEqual(sorted);
    }
  });

  it('is deterministic — repeated calls produce identical assignments', () => {
    expect(assignLabelSlots(ANCHORS)).toEqual(assignLabelSlots(ANCHORS));
  });

  it('breaks equal-height ties by input order and balances centered anchors', () => {
    const anchors = [
      cfg('head', [0, 1.5, 0]), // centered, first → left
      cfg('core', [0, 1.5, 0]), // centered, same y → right (balances)
      cfg('belly', [0, 0.8, 0]), // centered, tie again → left
    ];
    const slots = assignLabelSlots(anchors);
    expect(slots.head).toEqual({ side: 'left', row: 0, rows: 2 });
    expect(slots.core).toEqual({ side: 'right', row: 0, rows: 1 });
    expect(slots.belly).toEqual({ side: 'left', row: 1, rows: 2 });
  });
});

describe('embed size clamp', () => {
  const MAX = embedMaxSize(1600, 1000); // { w: 1440, h: 920 }

  it('derives max from the viewport as 90vw / 92vh in px, rounded', () => {
    expect(MAX).toEqual({ w: 1440, h: 920 });
    expect(embedMaxSize(1001, 999)).toEqual({ w: 901, h: 919 });
  });

  it('passes through an in-range size (rounded to whole px)', () => {
    expect(clampEmbedSize({ w: 420.4, h: 630.6 }, MAX)).toEqual({ w: 420, h: 631 });
  });

  it('clamps below the 240x360 minimum, per axis independently', () => {
    expect(clampEmbedSize({ w: 10, h: 5000 }, MAX)).toEqual({ w: EMBED_MIN_SIZE.w, h: MAX.h });
    expect(clampEmbedSize({ w: 5000, h: 10 }, MAX)).toEqual({ w: MAX.w, h: EMBED_MIN_SIZE.h });
  });

  it('clamps above the viewport max', () => {
    expect(clampEmbedSize({ w: 99999, h: 99999 }, MAX)).toEqual(MAX);
  });

  it('lets the minimum win when the viewport max is smaller than the minimum', () => {
    const tiny = embedMaxSize(200, 300); // { w: 180, h: 276 } — both under the minimum
    expect(clampEmbedSize({ w: 500, h: 500 }, tiny)).toEqual(EMBED_MIN_SIZE);
    expect(clampEmbedSize({ w: 1, h: 1 }, tiny)).toEqual(EMBED_MIN_SIZE);
  });
});

describe('fitTopOffset', () => {
  /** Holo figure envelope height (feet y=0, head top ≈1.97 per ANCHORS space). */
  const H = 1.97;
  const FOV = 45;

  /**
   * Independently reconstructs the visible half-height at the fitted target
   * depth, mirroring drei Bounds' getSize() distance math (atan quirk and all),
   * so tests can assert the resulting head gap geometrically.
   */
  function halfVisible(w: number, h: number, margin = 1.05, maxSize = H): number {
    const fitHeightDistance = maxSize / (2 * Math.atan((Math.PI * FOV) / 360));
    const distance = margin * Math.max(fitHeightDistance, fitHeightDistance / (w / h));
    return distance * Math.tan((FOV * Math.PI) / 360);
  }

  it('shifts a portrait container down so the head gap is exactly topGapFrac', () => {
    const offset = fitTopOffset(320, 480, H, FOV);
    expect(offset).toBeCloseTo(-0.5606, 3);
    // Window is centered on H/2 + offset; gap above the head as a fraction of
    // the full visible height must equal the default 5%.
    const half = halfVisible(320, 480);
    const gapFrac = (H / 2 + offset + half - H) / (2 * half);
    expect(gapFrac).toBeCloseTo(0.05, 10);
  });

  it('depends only on aspect ratio, and portrait needs a larger shift than square', () => {
    expect(fitTopOffset(240, 360, H, FOV)).toBeCloseTo(fitTopOffset(320, 480, H, FOV), 10);
    const square = fitTopOffset(500, 500, H, FOV);
    const portrait = fitTopOffset(320, 480, H, FOV);
    expect(square).toBeLessThan(0); // margin 1.05 always leaves a little slack
    expect(portrait).toBeLessThan(square);
    // Height-constrained fits (aspect >= 1) share the same window: same offset.
    expect(fitTopOffset(800, 400, H, FOV)).toBeCloseTo(square, 10);
  });

  it('respects margin and topGapFrac options', () => {
    const gap10 = fitTopOffset(320, 480, H, FOV, { topGapFrac: 0.1 });
    expect(gap10).toBeGreaterThan(fitTopOffset(320, 480, H, FOV)); // bigger gap → smaller shift
    const half = halfVisible(320, 480);
    expect((H / 2 + gap10 + half - H) / (2 * half)).toBeCloseTo(0.1, 10);
    expect(fitTopOffset(320, 480, H, FOV, { margin: 1.15 })).toBeLessThan(
      fitTopOffset(320, 480, H, FOV, { margin: 1.05 }),
    ); // looser margin → taller window → more room to shift
  });

  it('never returns a positive offset (would push the figure down/crop the feet)', () => {
    // margin 0.9 makes the window tighter than the figure + gap: clamp to 0.
    expect(fitTopOffset(800, 400, H, FOV, { margin: 0.9 })).toBe(0);
  });

  it('returns 0 for degenerate containers and inputs', () => {
    expect(fitTopOffset(0, 480, H, FOV)).toBe(0);
    expect(fitTopOffset(320, 0, H, FOV)).toBe(0);
    expect(fitTopOffset(-5, -5, H, FOV)).toBe(0);
    expect(fitTopOffset(NaN, 480, H, FOV)).toBe(0);
    expect(fitTopOffset(320, Infinity, H, FOV)).toBe(0);
    expect(fitTopOffset(320, 480, 0, FOV)).toBe(0);
    expect(fitTopOffset(320, 480, H, 0)).toBe(0);
    expect(fitTopOffset(320, 480, H, 180)).toBe(0);
    expect(fitTopOffset(320, 480, H, FOV, { margin: 0 })).toBe(0);
    expect(fitTopOffset(320, 480, H, FOV, { maxSize: 0 })).toBe(0);
  });
});

describe('embed size persistence', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
  }

  it('round-trips a size through the bos-holo-embed-size key', () => {
    const storage = fakeStorage();
    saveEmbedSize(storage, { w: 512, h: 768 });
    expect(storage.map.has(EMBED_SIZE_KEY)).toBe(true);
    expect(EMBED_SIZE_KEY).toBe('bos-holo-embed-size');
    expect(loadEmbedSize(storage)).toEqual({ w: 512, h: 768 });
  });

  it('rounds fractional px on save', () => {
    const storage = fakeStorage();
    saveEmbedSize(storage, { w: 512.4, h: 767.5 });
    expect(loadEmbedSize(storage)).toEqual({ w: 512, h: 768 });
  });

  it('returns null when nothing is stored', () => {
    expect(loadEmbedSize(fakeStorage())).toBeNull();
  });

  it('returns null for corrupt or invalid stored values', () => {
    const cases = [
      'not json',
      '"just a string"',
      'null',
      '[]',
      '{}',
      '{"w":100}',
      '{"w":"100","h":"200"}',
      '{"w":0,"h":200}',
      '{"w":100,"h":-5}',
      '{"w":null,"h":200}',
    ];
    for (const raw of cases) {
      expect(loadEmbedSize(fakeStorage({ [EMBED_SIZE_KEY]: raw }))).toBeNull();
    }
  });

  it('swallows storage read/write failures (private mode, quota)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadEmbedSize(throwing)).toBeNull();
    expect(() => saveEmbedSize(throwing, { w: 400, h: 600 })).not.toThrow();
  });
});

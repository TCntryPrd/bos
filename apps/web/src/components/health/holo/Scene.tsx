/**
 * Health Hologram — the <Canvas> scene: dark background, lights, the human-mesh
 * HoloFigure (GLB + fresnel shader; Suspense/error fallback to the procedural
 * Figure, and Bounds refits itself once the mesh loads — see HoloFigure.tsx),
 * per-anchor glow dots, OrbitControls (drag to orbit, no pan, sensible
 * zoom limits), and a slow auto-rotate. All self-animation (auto-rotate, pulse,
 * scan sweep) is disabled under prefers-reduced-motion, read once via matchMedia
 * (see docs/superpowers/specs/2026-07-05-health-hologram-design.md).
 *
 * Framing: the scene root is position:absolute inset:0 so it always fills its
 * (position:relative, definite-height) parent region, and the figure + anchors
 * are wrapped in drei <Bounds fit observe> so the mannequin fills ~75% of
 * the canvas height at any container size/aspect ratio. `clip` is deliberately
 * omitted: Bounds.clip() also reassigns controls.maxDistance = fitDistance * 10
 * on every mount/resize, silently overriding the OrbitControls maxDistance={6}
 * declared below. The default camera near/far (0.1 / 2000) already comfortably
 * covers this scene's fixed [1.8, 6] orbit range, so clip's near/far fitting
 * isn't needed here.
 *
 * Labels: medical-diagram style. The glow dots stay on the body (and rotate with
 * it); the label chips are plain HTML in two fixed outer columns (slots from
 * lib/holo.ts::assignLabelSlots — collision-free by construction), rendered as a
 * crisp non-scaling overlay above the canvas at 12px CSS. Chips are always dark
 * translucent (#0B1220 at 85% alpha) with light text — never a solid accent
 * fill. Thin dashed SVG leader lines connect each chip to its dot, retargeted
 * every frame from inside the Canvas (LeaderLineUpdater projects the rotating
 * dot positions to screen px). Chips and dots are both clickable and fire
 * onAnchorClick.
 *
 * Stuck-hover guard (labels='dots'): r3f only re-raycasts on pointer events, so
 * the auto-rotate can carry a hovered dot out from under a stationary cursor
 * without ever firing onPointerOut — leaving the revealed chip stuck on screen
 * at rest. Two guards clear it: the root div's onPointerLeave resets the hover
 * when the pointer exits the scene, and LeaderLineUpdater force-clears it the
 * moment the hovered dot rotates behind the figure's axis.
 *
 * No data fetching here — anchor states come in as props (built by
 * lib/holo.ts::buildAnchorStates from the existing healthData.ts client upstream).
 *
 * Embedding (HoloEmbed.tsx): optional props keep the standalone page's defaults —
 * `transparent` (alpha canvas, no painted background), `labels` ('full' | 'dots'
 * with hover-reveal chips | 'none'), `orbit={false}` to drop OrbitControls, and
 * `align` ('center' | 'top') — 'top' (the embed) swaps Bounds' centered fit for
 * TopAlignedFit, which top-aligns the figure so a portrait container's spare
 * space falls below the feet instead of above the head.
 *
 * Render loop: the Canvas switches to frameloop='never' while the document is
 * hidden (backgrounded/minimized tab, via useDocumentHidden's visibilitychange
 * listener), so a permanently-mounted embed (e.g. HoloEmbed on the Health page,
 * which has no on/off toggle) doesn't keep driving requestAnimationFrame and
 * useFrame work indefinitely while nothing is visible. It resumes 'always' the
 * moment the tab is foregrounded again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, OrbitControls, useBounds } from '@react-three/drei';
import * as THREE from 'three';
import type { Group } from 'three';
import { ANCHORS, assignLabelSlots, fitTopOffset, softenColor } from '../../../lib/holo';
import type { AnchorId, AnchorState, LabelSlot } from '../../../lib/holo';
import { HoloFigure } from './HoloFigure';
import { Anchor, DORMANT_COLOR } from './Anchor';

export const SCENE_BG = '#0B1220';
const AUTO_ROTATE_RAD_PER_S = 0.12; // slow — roughly one revolution every ~52s
/** Default Bounds margin — 1.15 leaves the figure at roughly 75-80% of canvas height. */
const FIT_MARGIN = 1.15;
/** Horizontal inset of the label columns from the scene edges. */
const COLUMN_INSET = 12;
/** Initial camera pose; align='top' refits re-derive their view direction from it. */
const CAMERA_POSITION: [number, number, number] = [0, 1.3, 3.2];
/** align='top': fraction of the canvas height left above the figure's head (~4-6% spec). */
const TOP_ALIGN_GAP_FRAC = 0.05;

type ElementMap<T> = Partial<Record<AnchorId, T | null>>;

/** Reads prefers-reduced-motion once; SSR-safe (defaults to false when no window). */
function useReducedMotionOnce(): boolean {
  const [reduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  return reduced;
}

/**
 * True while the document is hidden (tab backgrounded/minimized). SSR-safe
 * (defaults to false when no document). Scene uses this to switch the Canvas
 * to frameloop='never' so a permanently-mounted embed (e.g. HoloEmbed on the
 * Health page) doesn't keep rendering every frame while off-screen/backgrounded.
 */
function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden,
  );

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisibilityChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return hidden;
}

function AutoRotateGroup({
  reducedMotion,
  rotationRef,
  children,
}: {
  reducedMotion: boolean;
  /** Mirrors the group's current y-rotation so the label overlay can track dots. */
  rotationRef: MutableRefObject<number>;
  children: React.ReactNode;
}) {
  const groupRef = useRef<Group>(null);

  useFrame((_, delta) => {
    if (reducedMotion || !groupRef.current) return;
    groupRef.current.rotation.y += AUTO_ROTATE_RAD_PER_S * delta;
    rotationRef.current = groupRef.current.rotation.y;
  });

  return <group ref={groupRef}>{children}</group>;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Runs inside the Canvas: every frame, projects each anchor dot's current world
 * position (its config position rotated by the auto-rotate angle) into screen px
 * and imperatively points the dashed SVG leader line from the chip's inner edge
 * to the dot. Imperative attribute writes keep this out of the React render loop.
 *
 * `onDotBehind` (labels='dots' only) fires when a mounted chip's dot has rotated
 * behind the figure — the Scene uses it to clear a stuck hover reveal, since
 * r3f never fires onPointerOut for a dot that rotated away from a stationary
 * cursor (raycasts only happen on pointer events).
 */
function LeaderLineUpdater({
  rotationRef,
  slots,
  chipRefs,
  lineRefs,
  onDotBehind,
}: {
  rotationRef: MutableRefObject<number>;
  slots: Record<AnchorId, LabelSlot>;
  chipRefs: MutableRefObject<ElementMap<HTMLButtonElement>>;
  lineRefs: MutableRefObject<ElementMap<SVGLineElement>>;
  onDotBehind?: (id: AnchorId) => void;
}) {
  const { camera, size } = useThree();
  const world = useMemo(() => new THREE.Vector3(), []);
  const axisPoint = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    camera.updateMatrixWorld();
    for (const anchor of ANCHORS) {
      const line = lineRefs.current[anchor.id];
      const chip = chipRefs.current[anchor.id];
      const slot = slots[anchor.id];
      if (!line || !chip || !slot) continue;

      world
        .set(anchor.position[0], anchor.position[1], anchor.position[2])
        .applyAxisAngle(UP, rotationRef.current);

      // Dim the leader line while its dot has rotated behind the figure's axis
      // (farther from the camera than the spine point at the same height).
      axisPoint.set(0, anchor.position[1], 0);
      const behind =
        camera.position.distanceToSquared(world) >
        camera.position.distanceToSquared(axisPoint) + 1e-4;
      if (behind) onDotBehind?.(anchor.id);

      world.project(camera);
      const dotX = (world.x * 0.5 + 0.5) * size.width;
      const dotY = (-world.y * 0.5 + 0.5) * size.height;
      // Chips are translateY(-50%)-centered on their slot, so offsetTop is the
      // visual vertical center; the line leaves the chip's figure-facing edge.
      const chipX = slot.side === 'left' ? chip.offsetLeft + chip.offsetWidth : chip.offsetLeft;
      const chipY = chip.offsetTop;

      line.setAttribute('x1', String(chipX));
      line.setAttribute('y1', String(chipY));
      line.setAttribute('x2', String(dotX));
      line.setAttribute('y2', String(dotY));
      line.style.opacity = behind ? '0.35' : '1';
      line.style.visibility = 'visible';
    }
  });

  return null;
}

/**
 * One fixed-slot label chip in an outer column; clickable like its body dot.
 * `hoverOnly` chips (labels='dots' hover-reveal) render as inert tooltips —
 * pointer-events none so the chip can't steal hover from the dot that
 * revealed it (which would immediately unmount the chip and flicker).
 */
function LabelChip({
  config,
  state,
  slot,
  onClick,
  registerRef,
  hoverOnly = false,
}: {
  config: (typeof ANCHORS)[number];
  state: AnchorState;
  slot: LabelSlot;
  onClick?: (id: AnchorId) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
  hoverOnly?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  // Softened semantic accent (never a solid fill — accents only tint border/title).
  const color = state.active ? softenColor(config.color) : DORMANT_COLOR;
  const subtext = state.active ? state.lines[0] : config.dormantHint;
  // Evenly spaced vertical slots per side — distinct rows can never overlap.
  const topPct = ((slot.row + 1) / (slot.rows + 1)) * 100;
  const lit = hovered || hoverOnly;

  return (
    <button
      type="button"
      ref={registerRef}
      className={`holo-anchor-chip${state.active ? '' : ' is-dormant'}${lit ? ' is-hovered' : ''}`}
      onClick={() => onClick?.(config.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        top: `${topPct}%`,
        [slot.side]: COLUMN_INSET,
        transform: 'translateY(-50%)',
        pointerEvents: hoverOnly ? 'none' : 'auto',
        cursor: 'pointer',
        maxWidth: 'min(230px, 32%)',
        padding: '4px 9px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.35,
        textAlign: slot.side === 'left' ? 'right' : 'left',
        color: state.active ? '#EAF4FF' : '#9AA7BD',
        background: 'rgba(11, 18, 32, 0.85)',
        border: `1px solid ${color}`,
        boxShadow: lit ? `0 0 10px ${color}` : 'none',
        fontFamily: 'var(--font-mono, monospace)',
      }}
    >
      <strong style={{ color, fontWeight: 600, display: 'block' }}>{config.label}</strong>
      {subtext ? <span style={{ opacity: 0.85, display: 'block' }}>{subtext}</span> : null}
    </button>
  );
}

/**
 * Camera fitter for align='top' — replaces Bounds' built-in `fit observe`
 * behavior (which centers the fitted box vertically, splitting a portrait
 * container's dead space above the head and below the feet). On mount, on
 * every container resize, and whenever the async human mesh swaps in
 * (refitSignal), it refreshes the Bounds box and animates the camera to the
 * centered-fit pose translated down by lib/holo.ts::fitTopOffset — a pure
 * translation of both camera and look-target, so the view direction never
 * changes — leaving the head ~TOP_ALIGN_GAP_FRAC of the canvas below the top
 * edge with the spare space under the feet. The direction is re-derived from
 * the fixed CAMERA_POSITION (not the live, already-shifted camera) each refit
 * so live corner-drag resize can't accumulate tilt drift. Bounds' maxDuration
 * still drives the move animation (effectively instant under reduced motion).
 *
 * Deliberately useEffect, not useLayoutEffect: Bounds' own initial
 * useLayoutEffect calls refresh(), which clears any pending camera goals —
 * and a child's layout effect would fire BEFORE that parent effect.
 */
function TopAlignedFit({ margin, refitSignal }: { margin: number; refitSignal: number }) {
  const bounds = useBounds();
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  useEffect(() => {
    if (!bounds || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    bounds.refresh();
    const { center, distance, size: boxSize } = bounds.getSize();
    const offsetY = fitTopOffset(
      size.width,
      size.height,
      boxSize.y,
      (camera as THREE.PerspectiveCamera).fov,
      {
        margin,
        topGapFrac: TOP_ALIGN_GAP_FRAC,
        maxSize: Math.max(boxSize.x, boxSize.y, boxSize.z),
      },
    );
    // Same pose Bounds.reset() would pick, shifted down by offsetY.
    const direction = new THREE.Vector3(...CAMERA_POSITION).sub(center).normalize();
    const position = center.clone().addScaledVector(direction, distance);
    position.y += offsetY;
    const target = center.clone();
    target.y += offsetY;
    bounds.moveTo(position).lookAt({ target });
  }, [bounds, camera, size, margin, refitSignal]);

  return null;
}

/**
 * Label detail level. 'full' (the /health/holo page): every chip + leader line
 * always visible. 'dots' (embeds): body dots only, with a single chip + leader
 * line revealed while its dot is hovered. 'none': dots only, no overlay.
 */
export type LabelMode = 'none' | 'dots' | 'full';

/**
 * Vertical framing. 'center' (the standalone page): Bounds' own centered fit.
 * 'top' (embeds): the figure top-aligns — head ~5% from the canvas top, spare
 * space below the feet — via TopAlignedFit.
 */
export type SceneAlign = 'center' | 'top';

export interface SceneProps {
  /** Per-anchor display state, e.g. from buildAnchorStates(). */
  anchorStates: Record<AnchorId, AnchorState>;
  onAnchorClick?: (id: AnchorId) => void;
  className?: string;
  /** Chip/leader-line detail — defaults to 'full' (the standalone page). */
  labels?: LabelMode;
  /** Transparent canvas, no painted background — for embedding over page art. */
  transparent?: boolean;
  /** Set false to drop OrbitControls (embedded, non-orbitable placements). */
  orbit?: boolean;
  /**
   * Bounds fit margin — lower means a larger figure. Defaults to the standalone
   * page's 1.15 (~75-80% of canvas height); HoloEmbed passes 1.05 (~90%).
   */
  fitMargin?: number;
  /** Vertical framing — defaults to 'center' (the standalone page); HoloEmbed passes 'top'. */
  align?: SceneAlign;
}

export function Scene({
  anchorStates,
  onAnchorClick,
  className,
  labels = 'full',
  transparent = false,
  orbit = true,
  fitMargin = FIT_MARGIN,
  align = 'center',
}: SceneProps) {
  const reducedMotion = useReducedMotionOnce();
  const documentHidden = useDocumentHidden();
  const rotationRef = useRef(0);
  const chipRefs = useRef<ElementMap<HTMLButtonElement>>({});
  const lineRefs = useRef<ElementMap<SVGLineElement>>({});
  const slots = useMemo(() => assignLabelSlots(ANCHORS), []);
  // Hover-reveal state for labels='dots'; unused (never set) in other modes.
  const [hoveredId, setHoveredId] = useState<AnchorId | null>(null);
  const handleHoverChange = useCallback((id: AnchorId, hovered: boolean) => {
    setHoveredId((current) => (hovered ? id : current === id ? null : current));
  }, []);
  // Stuck-hover guards (see file header): drop a hover reveal whose dot rotated
  // behind the figure, and any reveal once the pointer leaves the scene.
  const clearHoverIfBehind = useCallback((id: AnchorId) => {
    setHoveredId((current) => (current === id ? null : current));
  }, []);
  const clearHover = useCallback(() => setHoveredId(null), []);
  const chipVisible = (id: AnchorId) =>
    labels === 'full' || (labels === 'dots' && hoveredId === id);
  // align='top': bumped when the async human mesh mounts, so TopAlignedFit
  // refits to the real envelope (the centered path self-fits inside HoloFigure).
  const [figureRevision, setFigureRevision] = useState(0);
  const handleFigureLoaded = useCallback(() => setFigureRevision((n) => n + 1), []);

  return (
    <div
      className={className}
      onPointerLeave={labels === 'dots' ? clearHover : undefined}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: transparent ? 'transparent' : SCENE_BG,
      }}
    >
      <Canvas
        camera={{ position: CAMERA_POSITION, fov: 45 }}
        dpr={[1, 2]}
        gl={transparent ? { alpha: true } : undefined}
        frameloop={documentHidden ? 'never' : 'always'}
      >
        {!transparent && <color attach="background" args={[SCENE_BG]} />}
        <ambientLight intensity={0.55} />
        <pointLight position={[2, 3, 2]} intensity={1.1} color="#DFF6FF" />
        <pointLight position={[-2, 1, -1.5]} intensity={0.4} color="#BFEAFF" />

        {/* maxDuration must stay > 0: drei Bounds divides delta by it each frame,
            and a zero-delta frame would turn the camera lerp into NaN. 0.01 makes
            the reduced-motion fit effectively instant (one frame) but NaN-safe.
            No `clip` prop here — see file header comment: Bounds.clip() stomps
            OrbitControls.maxDistance on every mount/resize. align='top' drops
            the built-in fit/observe (they only ever center the box) and lets
            TopAlignedFit drive every fit instead. */}
        <Bounds
          fit={align === 'center'}
          observe={align === 'center'}
          margin={fitMargin}
          maxDuration={reducedMotion ? 0.01 : 0.8}
        >
          {align === 'top' && <TopAlignedFit margin={fitMargin} refitSignal={figureRevision} />}
          <AutoRotateGroup reducedMotion={reducedMotion} rotationRef={rotationRef}>
            <HoloFigure
              reducedMotion={reducedMotion}
              onLoaded={align === 'top' ? handleFigureLoaded : undefined}
            />
            {ANCHORS.map((config) => {
              const state = anchorStates[config.id];
              if (!state) return null;
              return (
                <Anchor
                  key={config.id}
                  config={config}
                  state={state}
                  reducedMotion={reducedMotion}
                  onClick={onAnchorClick}
                  onHoverChange={labels === 'dots' ? handleHoverChange : undefined}
                />
              );
            })}
          </AutoRotateGroup>
        </Bounds>

        {labels !== 'none' && (
          <LeaderLineUpdater
            rotationRef={rotationRef}
            slots={slots}
            chipRefs={chipRefs}
            lineRefs={lineRefs}
            onDotBehind={labels === 'dots' ? clearHoverIfBehind : undefined}
          />
        )}

        {orbit && (
          <OrbitControls
            enablePan={false}
            enableZoom
            minDistance={1.8}
            maxDistance={6}
            minPolarAngle={Math.PI / 6}
            maxPolarAngle={Math.PI - Math.PI / 6}
            target={[0, 1, 0]}
            makeDefault
          />
        )}
      </Canvas>

      {/* Label overlay — crisp, non-scaling HTML above the canvas. In 'dots'
          mode only the hovered anchor's chip + line mount (unmounting clears
          the refs, so LeaderLineUpdater simply skips the hidden ones). */}
      {labels !== 'none' && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <svg
            width="100%"
            height="100%"
            style={{ position: 'absolute', inset: 0, display: 'block' }}
            aria-hidden="true"
          >
            {ANCHORS.map((config) => {
              const state = anchorStates[config.id];
              if (!state || !chipVisible(config.id)) return null;
              return (
                <line
                  key={config.id}
                  ref={(el) => {
                    lineRefs.current[config.id] = el;
                  }}
                  stroke={state.active ? softenColor(config.color) : DORMANT_COLOR}
                  strokeWidth={1}
                  strokeDasharray="5 4"
                  strokeOpacity={state.active ? 0.55 : 0.25}
                  style={{ visibility: 'hidden' }}
                />
              );
            })}
          </svg>
          {ANCHORS.map((config) => {
            const state = anchorStates[config.id];
            const slot = slots[config.id];
            if (!state || !slot || !chipVisible(config.id)) return null;
            return (
              <LabelChip
                key={config.id}
                config={config}
                state={state}
                slot={slot}
                onClick={onAnchorClick}
                registerRef={(el) => {
                  chipRefs.current[config.id] = el;
                }}
                hoverOnly={labels === 'dots'}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

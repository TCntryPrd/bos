/**
 * Health Hologram — clean anchor point on the mannequin.
 *
 * An additive-blended dot at a body position. Active anchors keep their
 * semantic color but softened (~80% desaturated, per lib/holo.ts::softenColor)
 * to match the pale hologram palette; dormant anchors (no data in the trailing
 * 30 days, per lib/holo.ts) render dim gray. The heart anchor pulses by
 * scaling at pulseBpm/60 Hz. Hover brightens; click fires onClick (see
 * docs/superpowers/specs/2026-07-05-health-hologram-design.md).
 *
 * Label chips are NOT rendered here: they live in Scene.tsx's HTML overlay as
 * fixed-slot columns beside the figure (medical-diagram style, per
 * lib/holo.ts::assignLabelSlots), connected to these dots by leader lines.
 */
import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { softenColor } from '../../../lib/holo';
import type { AnchorConfig, AnchorState } from '../../../lib/holo';

/** Dormant anchor tint (design palette) — shared with the Scene label overlay. */
export const DORMANT_COLOR = '#5A6B85';
const BASE_DOT_RADIUS = 0.035;
const HOVER_SCALE = 1.35;

export interface AnchorProps {
  config: AnchorConfig;
  state: AnchorState;
  /** When true, pulse/hover-transition animation is frozen — prefers-reduced-motion. */
  reducedMotion?: boolean;
  onClick?: (id: AnchorConfig['id']) => void;
  /** Fired when pointer hover over the dot starts/ends (drives hover-reveal labels). */
  onHoverChange?: (id: AnchorConfig['id'], hovered: boolean) => void;
}

export function Anchor({ config, state, reducedMotion = false, onClick, onHoverChange }: AnchorProps) {
  const dotRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const color = useMemo(
    () => (state.active ? softenColor(config.color) : DORMANT_COLOR),
    [state.active, config.color],
  );
  const baseOpacity = state.active ? 0.95 : 0.35;

  // Pulse angular frequency in rad/s for a sine wave at pulseBpm/60 Hz.
  const pulseOmega = useMemo(() => {
    if (config.id !== 'heart' || !state.pulseBpm) return null;
    const hz = state.pulseBpm / 60;
    return 2 * Math.PI * hz;
  }, [config.id, state.pulseBpm]);

  useFrame(({ clock }) => {
    const hoverScale = hovered ? HOVER_SCALE : 1;
    let pulseScale = 1;
    if (!reducedMotion && pulseOmega) {
      // Oscillate 0.85x .. 1.25x so the pulse reads clearly without swallowing the dot.
      pulseScale = 1.05 + 0.2 * Math.sin(clock.getElapsedTime() * pulseOmega);
    }
    const scale = hoverScale * pulseScale;
    if (dotRef.current) dotRef.current.scale.setScalar(scale);
  });

  const handlePointerOver = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setHovered(true);
    onHoverChange?.(config.id, true);
  };
  const handlePointerOut = () => {
    setHovered(false);
    onHoverChange?.(config.id, false);
  };
  // Stops the NATIVE pointerdown from bubbling past the canvas: embedded
  // placements (Health page drag-layout) setPointerCapture on an ancestor for
  // any uncaptured pointerdown, which would redirect the follow-up click away
  // from the canvas and silently kill dot clicks. r3f's e.stopPropagation()
  // only halts its own raycast propagation, so the native event needs it too.
  const handlePointerDown = (e: {
    stopPropagation: () => void;
    nativeEvent: { stopPropagation: () => void };
  }) => {
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
  };
  const handleClick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onClick?.(config.id);
  };

  return (
    <group position={config.position as unknown as [number, number, number]}>
      {/* Core dot */}
      <mesh
        ref={dotRef}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
      >
        <sphereGeometry args={[BASE_DOT_RADIUS, 12, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={baseOpacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

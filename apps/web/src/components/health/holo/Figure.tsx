/**
 * Health Hologram — procedural translucent mannequin.
 *
 * Built entirely from three.js primitives (sphere head, capsule torso/limbs) —
 * no external 3D model assets (see docs/superpowers/specs/
 * 2026-07-05-health-hologram-design.md). Styling per the owner's polish pass:
 * a slim ~7.5-head figure (feet y=0, head top ~1.97) whose parts render as a
 * soft translucent fill (opacity ~0.12, depthWrite off) with a subtle
 * low-density wireframe overlay — clean contours rather than dense
 * triangulation — in the scene-matched pale-cyan palette (#BFEAFF family)
 * instead of hard teal. Purely presentational: takes no data props, only the
 * reduced-motion flag that gates its own animation (the slow scan sweep).
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/** Scene-matched pale cyan — low saturation, replaces the old hard #3FE0C5. */
export const HOLO_CYAN = '#BFEAFF';

/** Soft translucent body fill — reads as glass, not paint. */
const FILL_MATERIAL_PROPS = {
  color: HOLO_CYAN,
  transparent: true,
  opacity: 0.12,
  depthWrite: false,
} as const;

/** Subtle contour wireframe drawn over the fill. */
const WIRE_MATERIAL_PROPS = {
  color: HOLO_CYAN,
  wireframe: true,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
} as const;

const LINE_MATERIAL_PROPS = {
  color: HOLO_CYAN,
  transparent: true,
  opacity: 0.45,
} as const;

/** Low segment counts so wireframe lines read as clean contours, not scribble. */
const CAP_SEGMENTS = 2;
const RADIAL_SEGMENTS = 6;

/** Vertical extent the scan sweep travels, matching the mannequin's rough bounding box. */
const SCAN_MIN_Y = 0.02;
const SCAN_MAX_Y = 1.96;
const SCAN_PERIOD_S = 6; // one full sweep every 6s — "slow" per spec

export interface FigureProps {
  /** When true, all self-animation (scan sweep) is frozen — prefers-reduced-motion. */
  reducedMotion?: boolean;
}

/**
 * A capsule-shaped limb/torso segment oriented along its local Y axis:
 * translucent fill plus a low-density wireframe contour overlay.
 */
function BodyCapsule({
  position,
  rotation,
  radius,
  length,
}: {
  position: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  radius: number;
  length: number;
}) {
  return (
    <group position={position} rotation={rotation as [number, number, number] | undefined}>
      <mesh>
        <capsuleGeometry args={[radius, length, CAP_SEGMENTS, RADIAL_SEGMENTS]} />
        <meshBasicMaterial {...FILL_MATERIAL_PROPS} />
      </mesh>
      <mesh>
        <capsuleGeometry args={[radius, length, CAP_SEGMENTS, RADIAL_SEGMENTS]} />
        <meshBasicMaterial {...WIRE_MATERIAL_PROPS} />
      </mesh>
    </group>
  );
}

/**
 * The flat ring the figure appears to stand on, plus faint concentric rings for
 * depth. Exported so HoloFigure.tsx grounds the loaded human mesh identically.
 */
export function BaseRing() {
  const rings = useMemo(
    () => [
      { radius: 0.4, opacity: 0.5 },
      { radius: 0.48, opacity: 0.28 },
      { radius: 0.56, opacity: 0.14 },
    ],
    [],
  );
  return (
    <group position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      {rings.map((r) => (
        <mesh key={r.radius}>
          <ringGeometry args={[r.radius - 0.01, r.radius, 64]} />
          <meshBasicMaterial
            color={HOLO_CYAN}
            transparent
            opacity={r.opacity}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

/** A thin glowing plane that sweeps up/down the figure, disabled under reduced motion. */
function ScanSweep({ reducedMotion }: { reducedMotion: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (reducedMotion || !meshRef.current) return;
    const t = (clock.getElapsedTime() % SCAN_PERIOD_S) / SCAN_PERIOD_S; // 0..1
    // Triangle wave so the sweep travels up then back down rather than snapping.
    const tri = t < 0.5 ? t * 2 : 2 - t * 2;
    meshRef.current.position.y = SCAN_MIN_Y + tri * (SCAN_MAX_Y - SCAN_MIN_Y);
  });

  if (reducedMotion) return null;

  return (
    <mesh ref={meshRef} position={[0, SCAN_MIN_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0, 0.34, 48]} />
      <meshBasicMaterial
        color={HOLO_CYAN}
        transparent
        opacity={0.1}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

/**
 * Slim ~7.5-head mannequin: small sphere head (r 0.13, center y 1.84), narrow
 * capsule torso/pelvis, arms relaxed in a slight A-pose, long legs (hip line
 * ~y 1.0), standing on a base ring with a slow vertical scan sweep. Feet at
 * y=0, head top ~1.97 — the anchor position space documented in lib/holo.ts.
 */
export function Figure({ reducedMotion = false }: FigureProps) {
  return (
    <group>
      <BaseRing />
      <ScanSweep reducedMotion={reducedMotion} />

      {/* Head — fill + contour overlay, low segment counts */}
      <group position={[0, 1.84, 0]}>
        <mesh>
          <sphereGeometry args={[0.13, 10, 8]} />
          <meshBasicMaterial {...FILL_MATERIAL_PROPS} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.13, 10, 8]} />
          <meshBasicMaterial {...WIRE_MATERIAL_PROPS} />
        </mesh>
      </group>

      {/* Neck */}
      <BodyCapsule position={[0, 1.66, 0]} radius={0.035} length={0.1} />

      {/* Torso (shoulders ~1.6 to waist ~1.0) */}
      <BodyCapsule position={[0, 1.3, 0]} radius={0.15} length={0.3} />

      {/* Pelvis (waist to hip line ~1.0) */}
      <BodyCapsule position={[0, 0.98, 0]} radius={0.12} length={0.1} />

      {/* Upper arms — relaxed, slightly out from the torso */}
      <BodyCapsule
        position={[-0.23, 1.37, 0]}
        rotation={[0, 0, -0.16]}
        radius={0.042}
        length={0.29}
      />
      <BodyCapsule
        position={[0.23, 1.37, 0]}
        rotation={[0, 0, 0.16]}
        radius={0.042}
        length={0.29}
      />

      {/* Forearms */}
      <BodyCapsule
        position={[-0.28, 1.0, 0.03]}
        rotation={[0, 0, -0.11]}
        radius={0.036}
        length={0.29}
      />
      <BodyCapsule
        position={[0.28, 1.0, 0.03]}
        rotation={[0, 0, 0.11]}
        radius={0.036}
        length={0.29}
      />

      {/* Thighs (hip ~1.0 to knee ~0.55) */}
      <BodyCapsule position={[-0.085, 0.78, 0]} radius={0.06} length={0.34} />
      <BodyCapsule position={[0.085, 0.78, 0]} radius={0.06} length={0.34} />

      {/* Calves (knee to ankle) */}
      <BodyCapsule position={[-0.095, 0.3, 0]} radius={0.048} length={0.38} />
      <BodyCapsule position={[0.095, 0.3, 0]} radius={0.048} length={0.38} />

      {/* Faint centerline connecting head to base, reinforcing the "spine" silhouette */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([0, 1.95, 0, 0, 0, 0]), 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial {...LINE_MATERIAL_PROPS} />
      </lineSegments>
    </group>
  );
}

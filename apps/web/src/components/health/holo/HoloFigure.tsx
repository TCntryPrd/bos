/**
 * Health Hologram — real human mesh with a fresnel hologram shader.
 *
 * Loads the CC0 Quaternius Universal Base Characters body mesh from
 * '/holo/figure.glb' — a runtime public asset served from the site root
 * (vite base is '/', same absolute-URL form index.html uses for
 * /customaios.png), NOT a bundled import — and normalizes it via its loaded
 * bounding box so the feet sit at y=0 and the head top lands at y≈1.97: the
 * anchor position space documented in lib/holo.ts and the envelope
 * Scene.tsx's <Bounds> expects.
 *
 * Shading: a custom fresnel hologram ShaderMaterial — translucent deep
 * teal-cyan body base (HOLO_CYAN_DEEP, ~0.15 opacity; owner pass: "a little
 * darker"), fresnel rim glow (pow(1 - |N·V|, 2.5)) on its own brighter
 * HOLO_RIM tint so the edge still pops against the deeper body, a slow
 * moving horizontal scan band plus fine scanline striping (time uniform
 * driven by useFrame and FROZEN under prefers-reduced-motion), additive
 * blending, depthWrite off — so the mesh reads as projected light, not paint.
 *
 * Resilience: the exported HoloFigure wraps the loaded mesh in Suspense + a
 * small error boundary, both falling back to the procedural Figure (with a
 * console.warn on load failure), so the hologram never renders empty. The
 * loaded figure calls Bounds' refresh().fit() on mount so the camera refits
 * to the real mesh's envelope after the async load, and useGLTF.preload
 * starts the fetch as soon as this (lazy) chunk loads.
 */
import { Component, Suspense, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useBounds, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { BaseRing, Figure } from './Figure';
import type { FigureProps } from './Figure';

/** Runtime public asset (see file header) — resolves at the site root in prod nginx. */
const MODEL_URL = '/holo/figure.glb';

/**
 * Deeper teal-cyan for the hologram body base — owner pass: "maybe a little
 * darker" than Figure.tsx's pale HOLO_CYAN (#BFEAFF), which stays in place for
 * the base ring / procedural fallback / anchor palette.
 */
export const HOLO_CYAN_DEEP = '#8ED2EF';
/** Rim tint — slightly deeper than HOLO_CYAN but brighter than the body, so the fresnel edge pops. */
const HOLO_RIM = '#A9DFF7';

/** Normalized envelope height: feet y=0, head top ≈ this (per lib/holo.ts anchors). */
const TARGET_HEIGHT = 1.97;

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vWorldY;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldY = worldPos.y;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = viewMatrix * worldPos;
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

/*
 * Alpha = translucent base (~0.15) + fresnel rim + scan band, modulated by fine
 * scanline striping. The scan band sweeps feet→head→feet on the same 6s
 * triangle wave as the procedural Figure's ScanSweep; with uTime frozen at 0
 * (reduced motion) it parks at the feet, effectively invisible. Color splits
 * body (uColor, deep) from rim (uRimColor, brighter) so darkening the body
 * doesn't dull the fresnel edge.
 */
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uRimColor;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vWorldY;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vViewDir);
    float fresnel = pow(1.0 - abs(dot(n, v)), 2.5);

    float t = mod(uTime, 6.0) / 6.0;
    float tri = 1.0 - abs(1.0 - 2.0 * t);
    float bandCenter = mix(0.02, 1.95, tri);
    float band = exp(-pow((vWorldY - bandCenter) / 0.05, 2.0));

    // Fine horizontal striping, ~2.6cm pitch on the ~2-unit figure.
    float stripe = 0.5 + 0.5 * sin(vWorldY * 240.0);

    float alpha = 0.15 + 0.55 * fresnel + 0.18 * band;
    alpha *= 0.82 + 0.18 * stripe;

    vec3 color = uColor * (0.45 + 0.9 * band) + uRimColor * (1.1 * fresnel);
    gl_FragColor = vec4(color, alpha);
  }
`;

function createHologramMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(HOLO_CYAN_DEEP) },
      uRimColor: { value: new THREE.Color(HOLO_RIM) },
      uTime: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

export interface HoloFigureProps extends FigureProps {
  /**
   * When provided, the loaded mesh reports readiness through this callback
   * INSTEAD of self-refitting the Bounds camera — the Scene's align='top'
   * fitter owns the (offset) refit. Omitted (the default, and the standalone
   * page's centered framing), the mesh keeps calling bounds.refresh().fit()
   * itself as before.
   */
  onLoaded?: () => void;
}

/** The GLB body mesh, normalized and holo-shaded. Suspends until the model loads. */
function LoadedFigure({ reducedMotion = false, onLoaded }: HoloFigureProps) {
  const { scene } = useGLTF(MODEL_URL);
  const bounds = useBounds();

  const material = useMemo(createHologramMaterial, []);
  useEffect(() => () => material.dispose(), [material]);

  // Clone so the (globally cached) GLTF scene is never mutated or reparented,
  // then paint every mesh with the hologram shader. Geometry stays shared.
  const figure = useMemo(() => {
    const root = scene.clone();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) mesh.material = material;
    });
    return root;
  }, [scene, material]);

  // Normalize via the loaded bbox: uniform scale to TARGET_HEIGHT with the
  // feet (bbox bottom) sitting exactly on y=0.
  const { scale, yOffset } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const s = TARGET_HEIGHT / (box.max.y - box.min.y);
    return { scale: s, yOffset: -box.min.y * s };
  }, [scene]);

  // The mesh arrives async (Suspense) after Bounds' initial fit-to-fallback:
  // refit the camera to the real envelope the moment the loaded mesh mounts —
  // via onLoaded when the parent owns the refit (align='top'), else directly.
  useEffect(() => {
    if (onLoaded) {
      onLoaded();
      return;
    }
    bounds?.refresh().fit();
  }, [bounds, onLoaded]);

  // Drive the shader clock; frozen (uTime stays put) under reduced motion.
  useFrame(({ clock }) => {
    if (reducedMotion) return;
    material.uniforms.uTime.value = clock.getElapsedTime();
  });

  return (
    <group>
      <BaseRing />
      <group scale={scale} position={[0, yOffset, 0]}>
        <primitive object={figure} />
      </group>
    </group>
  );
}

/** Falls back to the given node when any descendant throws (e.g. GLB fetch/parse). */
class FigureErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(
      '[health-holo] human mesh failed to load — falling back to the procedural figure.',
      error,
    );
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Drop-in replacement for Figure: the real human mesh once loaded, the
 * procedural Figure while loading or if loading ever fails.
 */
export function HoloFigure({ reducedMotion = false, onLoaded }: HoloFigureProps) {
  const fallback = <Figure reducedMotion={reducedMotion} />;
  return (
    <FigureErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <LoadedFigure reducedMotion={reducedMotion} onLoaded={onLoaded} />
      </Suspense>
    </FigureErrorBoundary>
  );
}

useGLTF.preload(MODEL_URL);

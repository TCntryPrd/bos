/**
 * AgentAvatar — cartoon portraits for each Little Rascals character.
 *
 * One inline SVG per known handle, sized via a single `size` prop and
 * a 60×60 viewBox. Each character has a distinguishing silhouette
 * (Petey's dog face, Darla's bow, Spanky's derby, Alfalfa's cowlick,
 * etc.) so the user can identify the rascal at a glance without
 * reading the label.
 *
 * Unknown handles (rascals added later via the +Add modal) fall
 * through to a hue-letter avatar so the page never breaks. The
 * portraits are intentionally simple — bold shapes, flat fills,
 * one signature trait — so they read clearly at 28-40 px in roster
 * grids and still hold up at 64 px on the Rascals card grid.
 *
 * The art is hand-coded SVG. Drop-in replacement with real cartoon
 * raster art is supported by adding an entry to PORTRAIT_OVERRIDES
 * (handle → PNG/SVG URL) without touching this component's call
 * sites.
 */

import React from 'react';

// ─────────────────────────────────────────────────────────────────────
// Theme palette per character. The `hue` doubles as the card-grid hue
// in Rascals.tsx so each rascal has a single consistent brand color.
// ─────────────────────────────────────────────────────────────────────

type RascalTheme = {
  /** Primary brand hue (also used for the card glow). */
  hue: string;
  /** Skin tone for the face fill. */
  skin: string;
  /** Hair / hat / fur color. */
  hair: string;
};

const THEMES: Record<string, RascalTheme> = {
  alfalfa:   { hue: '#b56cff', skin: '#f3d3a8', hair: '#3d2814' },
  buckwheat: { hue: '#ffb86b', skin: '#6b3d1f', hair: '#1a1208' },
  butch:     { hue: '#ff5c5c', skin: '#e9c39c', hair: '#1f1a16' },
  darla:     { hue: '#ff5cc8', skin: '#f5d7b8', hair: '#d4a04c' },
  froggy:    { hue: '#4df5a5', skin: '#dec9a3', hair: '#2a3a1e' },
  petey:     { hue: '#a07060', skin: '#f4ead4', hair: '#5a3a1a' }, // dog
  porky:     { hue: '#ff8c5c', skin: '#f0c9a3', hair: '#2a1a14' },
  spanky:    { hue: '#5cc8ff', skin: '#e9c8a3', hair: '#1f1612' },
  stymie:    { hue: '#d6b6ff', skin: '#5d3820', hair: '#100a08' },
  wheezer:   { hue: '#9d8bff', skin: '#eecdb0', hair: '#5a3a26' },
};

export const KNOWN_RASCAL_HANDLES = Object.keys(THEMES);

/** Public hue accessor — keeps Rascals.tsx in sync with the palette. */
export function agentHue(handle: string): string {
  return THEMES[handle]?.hue ?? '#8a93a7';
}

// ─────────────────────────────────────────────────────────────────────
// Portrait overrides — drop-in slot for real raster cartoon art when
// it lands. Map handle → asset URL and the SVG below is bypassed.
// ─────────────────────────────────────────────────────────────────────

const PORTRAIT_OVERRIDES: Record<string, string> = {
  // e.g. alfalfa: '/avatars/alfalfa.png'
};

// ─────────────────────────────────────────────────────────────────────
// Shared SVG primitives so each character body is short.
// Coordinates assume a 60×60 viewBox.
// ─────────────────────────────────────────────────────────────────────

function FaceOval({ skin, cx = 30, cy = 32, rx = 17, ry = 19 }: {
  skin: string; cx?: number; cy?: number; rx?: number; ry?: number;
}) {
  return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={skin} />;
}

function Eyes({ y = 30, dx = 6, color = '#1a1208' }: { y?: number; dx?: number; color?: string }) {
  return (
    <>
      <circle cx={30 - dx} cy={y} r="1.6" fill={color} />
      <circle cx={30 + dx} cy={y} r="1.6" fill={color} />
    </>
  );
}

function Smile({ y = 40, w = 8, color = '#1a1208' }: { y?: number; w?: number; color?: string }) {
  return <path d={`M ${30 - w} ${y} Q 30 ${y + 3} ${30 + w} ${y}`} stroke={color} strokeWidth="1.2" fill="none" strokeLinecap="round" />;
}

function Cheeks({ color = '#ff8a8a', y = 36 }: { color?: string; y?: number }) {
  return (
    <>
      <circle cx="18" cy={y} r="2.2" fill={color} opacity="0.6" />
      <circle cx="42" cy={y} r="2.2" fill={color} opacity="0.6" />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-character portraits. Each renders inside an enclosing <svg>.
// ─────────────────────────────────────────────────────────────────────

function Alfalfa({ t }: { t: RascalTheme }) {
  return (
    <>
      <FaceOval skin={t.skin} />
      {/* Cowlick — Alfalfa's signature spike */}
      <path d="M 30 14 L 28 4 L 31 8 L 30 14 Z" fill={t.hair} />
      {/* Side hair */}
      <path d="M 14 26 Q 20 18 30 18 Q 40 18 46 26 L 44 22 Q 38 14 30 14 Q 22 14 16 22 Z" fill={t.hair} />
      <Eyes />
      {/* Freckles */}
      <circle cx="22" cy="35" r="0.7" fill="#a87038" />
      <circle cx="38" cy="35" r="0.7" fill="#a87038" />
      <circle cx="25" cy="37" r="0.5" fill="#a87038" />
      <circle cx="35" cy="37" r="0.5" fill="#a87038" />
      <Smile y={42} />
      {/* Bow tie */}
      <path d="M 22 50 L 30 47 L 38 50 L 38 53 L 30 50 L 22 53 Z" fill="#ff5c5c" />
      <circle cx="30" cy="50" r="1.2" fill="#a02020" />
    </>
  );
}

function Buckwheat({ t }: { t: RascalTheme }) {
  return (
    <>
      {/* Tall fluffy hair as overlapping circles */}
      <circle cx="30" cy="14" r="9" fill={t.hair} />
      <circle cx="20" cy="18" r="7" fill={t.hair} />
      <circle cx="40" cy="18" r="7" fill={t.hair} />
      <circle cx="25" cy="11" r="6" fill={t.hair} />
      <circle cx="35" cy="11" r="6" fill={t.hair} />
      <FaceOval skin={t.skin} cy={34} ry={17} />
      <Eyes y={32} color="#fff" />
      <circle cx="24" cy="32" r="0.8" fill="#1a1208" />
      <circle cx="36" cy="32" r="0.8" fill="#1a1208" />
      {/* Big surprised mouth */}
      <ellipse cx="30" cy="42" rx="3.5" ry="2.5" fill="#3a1a1a" />
    </>
  );
}

function Butch({ t }: { t: RascalTheme }) {
  return (
    <>
      <FaceOval skin={t.skin} />
      {/* Slicked hair across forehead */}
      <path d="M 14 24 Q 20 12 30 12 Q 40 12 46 24 L 46 26 Q 38 22 30 24 Q 22 22 14 26 Z" fill={t.hair} />
      {/* Scowl brows */}
      <path d="M 21 26 L 27 28" stroke="#1a1208" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M 39 26 L 33 28" stroke="#1a1208" strokeWidth="1.6" strokeLinecap="round" />
      <Eyes y={31} />
      {/* Smug grin */}
      <path d="M 24 41 Q 30 44 36 41" stroke="#1a1208" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M 34 41 L 36 39" stroke="#1a1208" strokeWidth="1" strokeLinecap="round" />
    </>
  );
}

function Darla({ t }: { t: RascalTheme }) {
  return (
    <>
      {/* Curly bob — wider than face */}
      <ellipse cx="30" cy="22" rx="20" ry="14" fill={t.hair} />
      <FaceOval skin={t.skin} cy={34} />
      {/* Side curls */}
      <circle cx="13" cy="30" r="4" fill={t.hair} />
      <circle cx="47" cy="30" r="4" fill={t.hair} />
      <Eyes y={32} />
      {/* Long lashes */}
      <path d="M 22 30 L 21 28 M 24 29 L 24 27" stroke="#1a1208" strokeWidth="0.8" strokeLinecap="round" />
      <path d="M 38 30 L 39 28 M 36 29 L 36 27" stroke="#1a1208" strokeWidth="0.8" strokeLinecap="round" />
      <Cheeks y={38} />
      {/* Smile with lipstick */}
      <path d="M 24 42 Q 30 46 36 42" stroke="#d63060" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {/* Pink bow on top */}
      <path d="M 22 12 L 30 16 L 38 12 L 38 18 L 30 18 L 22 18 Z" fill="#ff5cc8" />
      <circle cx="30" cy="16" r="2" fill="#d4308c" />
    </>
  );
}

function Froggy({ t }: { t: RascalTheme }) {
  return (
    <>
      <FaceOval skin={t.skin} />
      {/* Side hair tufts */}
      <path d="M 14 24 Q 20 16 30 16 Q 40 16 46 24" stroke={t.hair} strokeWidth="3" fill="none" />
      {/* Round glasses */}
      <circle cx="22" cy="30" r="5" fill="none" stroke="#1a1208" strokeWidth="1.4" />
      <circle cx="38" cy="30" r="5" fill="none" stroke="#1a1208" strokeWidth="1.4" />
      <line x1="27" y1="30" x2="33" y2="30" stroke="#1a1208" strokeWidth="1.4" />
      {/* Eyes inside glasses */}
      <circle cx="22" cy="30" r="1.4" fill="#1a1208" />
      <circle cx="38" cy="30" r="1.4" fill="#1a1208" />
      {/* Wide cartoon mouth */}
      <path d="M 20 41 Q 30 47 40 41 Q 30 43 20 41 Z" fill="#3a1a1a" stroke="#1a1208" strokeWidth="1" />
    </>
  );
}

function Petey({ t }: { t: RascalTheme }) {
  return (
    <>
      {/* Floppy ears */}
      <ellipse cx="14" cy="22" rx="6" ry="9" fill={t.hair} />
      <ellipse cx="46" cy="22" rx="6" ry="9" fill={t.hair} />
      {/* Dog face — slightly squashed circle */}
      <circle cx="30" cy="32" r="18" fill={t.skin} />
      {/* Brown eye patch (Petey's ring) */}
      <circle cx="22" cy="29" r="6" fill={t.hair} opacity="0.85" />
      <circle cx="22" cy="30" r="2" fill="#1a1208" />
      {/* Other eye */}
      <circle cx="38" cy="30" r="2" fill="#1a1208" />
      {/* Snout */}
      <ellipse cx="30" cy="40" rx="6" ry="4" fill="#f0d8b8" />
      <ellipse cx="30" cy="38" rx="2.5" ry="1.6" fill="#1a1208" />
      {/* Tongue */}
      <path d="M 28 41 Q 30 46 32 41 Z" fill="#ff7090" />
    </>
  );
}

function Porky({ t }: { t: RascalTheme }) {
  return (
    <>
      {/* Backwards cap brim */}
      <rect x="38" y="16" width="10" height="3" fill={t.hue} />
      {/* Cap dome */}
      <path d="M 14 22 Q 14 12 30 12 Q 44 12 44 22 Z" fill={t.hue} />
      {/* Round chubby face */}
      <FaceOval skin={t.skin} cy={36} ry={17} rx={18} />
      <Eyes y={34} />
      <Cheeks y={40} color="#ff7090" />
      {/* Wide content smile */}
      <path d="M 24 44 Q 30 49 36 44" stroke="#1a1208" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  );
}

function Spanky({ t }: { t: RascalTheme }) {
  return (
    <>
      <FaceOval skin={t.skin} cy={34} />
      {/* Derby hat — brim */}
      <ellipse cx="30" cy="18" rx="16" ry="2" fill={t.hair} />
      {/* Derby crown */}
      <path d="M 19 18 Q 19 9 30 9 Q 41 9 41 18 Z" fill={t.hair} />
      {/* Hat band */}
      <line x1="19" y1="16" x2="41" y2="16" stroke="#3a2a18" strokeWidth="1" />
      <Eyes y={32} />
      {/* Smug little smirk */}
      <path d="M 26 43 Q 30 45 34 41" stroke="#1a1208" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  );
}

function Stymie({ t }: { t: RascalTheme }) {
  return (
    <>
      {/* Bowler hat — brim */}
      <ellipse cx="30" cy="20" rx="18" ry="2" fill={t.hair} />
      {/* Bowler dome — squat */}
      <path d="M 18 20 Q 18 11 30 11 Q 42 11 42 20 Z" fill={t.hair} />
      <FaceOval skin={t.skin} cy={36} ry={16} />
      <Eyes y={34} color="#fff" />
      <circle cx="24" cy="34" r="0.8" fill="#1a1208" />
      <circle cx="36" cy="34" r="0.8" fill="#1a1208" />
      {/* Earnest little smile */}
      <Smile y={43} w={5} />
    </>
  );
}

function Wheezer({ t }: { t: RascalTheme }) {
  return (
    <>
      <FaceOval skin={t.skin} cy={34} ry={17} />
      {/* Tousled side hair */}
      <path d="M 14 24 Q 18 16 26 16 L 24 22 Q 20 22 16 26 Z" fill={t.hair} />
      <path d="M 46 24 Q 42 16 34 16 L 36 22 Q 40 22 44 26 Z" fill={t.hair} />
      <path d="M 22 18 Q 30 12 38 18 L 36 22 Q 30 18 24 22 Z" fill={t.hair} />
      <Eyes y={33} />
      <Cheeks y={38} />
      {/* Tiny "o" mouth — Wheezer was the youngest, always slightly open */}
      <ellipse cx="30" cy="42" rx="1.5" ry="2" fill="#3a1a1a" />
    </>
  );
}

const PORTRAITS: Record<string, React.FC<{ t: RascalTheme }>> = {
  alfalfa: Alfalfa,
  buckwheat: Buckwheat,
  butch: Butch,
  darla: Darla,
  froggy: Froggy,
  petey: Petey,
  porky: Porky,
  spanky: Spanky,
  stymie: Stymie,
  wheezer: Wheezer,
};

// ─────────────────────────────────────────────────────────────────────
// Public component
// ─────────────────────────────────────────────────────────────────────

interface AgentAvatarProps {
  handle: string;
  /** Display name — used only for the unknown-handle fallback initial. */
  displayName?: string;
  /** Pixel size (square). Defaults to 40. */
  size?: number;
  /** Adds a soft outer glow ring tinted by the rascal's hue. */
  ring?: boolean;
}

export function AgentAvatar({ handle, displayName, size = 40, ring }: AgentAvatarProps) {
  const override = PORTRAIT_OVERRIDES[handle];
  if (override) {
    return (
      <img
        src={override}
        alt=""
        width={size}
        height={size}
        className="rounded-full flex-shrink-0 object-cover"
        style={
          ring
            ? { boxShadow: `0 0 0 2px ${agentHue(handle)}55, 0 0 12px ${agentHue(handle)}33` }
            : undefined
        }
        data-rascal-handle={handle}
      />
    );
  }

  const Portrait = PORTRAITS[handle];
  const theme = THEMES[handle];

  if (!Portrait || !theme) {
    return <FallbackAvatar handle={handle} displayName={displayName ?? handle} size={size} ring={ring} />;
  }

  return (
    <svg
      viewBox="0 0 60 60"
      width={size}
      height={size}
      className="flex-shrink-0 rounded-full"
      style={{
        background: `radial-gradient(circle at 30% 30%, ${theme.hue}26, transparent 70%)`,
        boxShadow: ring
          ? `0 0 0 2px ${theme.hue}55, 0 0 12px ${theme.hue}33`
          : undefined,
      }}
      aria-hidden
      role="img"
      data-rascal-handle={handle}
    >
      <Portrait t={theme} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Fallback hue-letter avatar — for any handle that hasn't been
// hand-illustrated yet (e.g., a new rascal added via +Add modal).
// ─────────────────────────────────────────────────────────────────────

function FallbackAvatar({ handle, displayName, size, ring }: {
  handle: string; displayName: string; size: number; ring?: boolean;
}) {
  const hue = hashedHue(handle);
  return (
    <div
      className="flex items-center justify-center rounded-full font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `linear-gradient(135deg, ${hue}, ${hue}88)`,
        color: '#0a0c12',
        boxShadow: ring
          ? `0 0 0 2px ${hue}55, 0 0 12px ${hue}33`
          : `0 0 12px ${hue}55, inset 0 0 8px ${hue}33`,
        border: `1px solid ${hue}44`,
      }}
      aria-hidden
      data-rascal-handle={handle}
    >
      {displayName.slice(0, 1).toUpperCase()}
    </div>
  );
}

const HUE_CYCLE = ['#b56cff', '#ff5cc8', '#4df5a5', '#5cc8ff', '#ffb86b', '#d6b6ff'];

function hashedHue(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return HUE_CYCLE[h % HUE_CYCLE.length];
}

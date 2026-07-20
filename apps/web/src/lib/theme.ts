// Display mode (BOS): Executive · Plain.
// - Executive = the full identity (warm navy depths, violet accents, gradients
//   + glow). The default boardroom look.
// - Plain      = a quiet, flat operations look (warm paper, slate ink, a single
//   restrained accent, hairline borders, no gradients/glow).
// Paint is driven by <html data-theme="dark|plain"> so the existing token
// pipeline is reused (Executive -> dark tokens, Plain -> plain tokens).

export type BossMode = 'executive' | 'plain';

const KEY = 'boss_mode';
const LEGACY_KEY = 'boss_theme';

export function modeToTheme(mode: BossMode): 'dark' | 'plain' {
  return mode === 'plain' ? 'plain' : 'dark';
}

export function getStoredMode(): BossMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'executive' || v === 'plain') return v;
    // Migrate the old dark/light/system preference (light -> plain).
    if (localStorage.getItem(LEGACY_KEY) === 'light') return 'plain';
  } catch {
    /* ignore */
  }
  return 'executive';
}

export function applyMode(mode: BossMode): void {
  document.documentElement.setAttribute('data-theme', modeToTheme(mode));
}

export function setBossMode(mode: BossMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  applyMode(mode);
}

// The per-install AIOS name (e.g. "Vasari", "Kane"). Injected by the installer
// into <meta name="aios-name">. Empty when unset -> the lockup shows just "BOS".
export function getAiosName(): string {
  try {
    const el = document.querySelector('meta[name="aios-name"]');
    const v = (el?.getAttribute('content') || '').trim();
    if (!v || v.startsWith('__')) return '';
    return v;
  } catch {
    return '';
  }
}

// Per-install lockup byline. When the meta tag is ABSENT the brand default
// applies ("From Industry Rockstar" on the ir brand); when present its content
// is used verbatim — content="" hides the byline entirely.
export function getBrandByline(brandDefault: string): string {
  try {
    const el = document.querySelector('meta[name="aios-byline"]');
    if (!el) return brandDefault;
    const v = (el.getAttribute('content') || '').trim();
    if (v.startsWith('__')) return brandDefault;
    return v;
  } catch {
    return brandDefault;
  }
}

// Per-install badge visibility: <meta name="aios-badge" content="off"> hides
// the brand badge image in the lockup. Absent -> shown (brand default).
export function isBrandBadgeHidden(): boolean {
  try {
    const el = document.querySelector('meta[name="aios-badge"]');
    return (el?.getAttribute('content') || '').trim().toLowerCase() === 'off';
  } catch {
    return false;
  }
}

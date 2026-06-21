// Theme preference (Phase 5, LOCKED): Dark · Light · Follow System.
// Default = Dark when nothing is stored (locked: "default Dark if skipped").
// "system" honors the OS prefers-color-scheme and stays in sync with changes.
// The actual paint is driven by <html data-theme="dark|light"> (see token blocks).

export type ThemePref = 'dark' | 'light' | 'system';

const KEY = 'boss_theme';

export function getStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'dark'; // locked default
}

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return pref;
}

export function applyPref(pref: ThemePref): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyPref(pref);
}

// Keep a "system" preference following the OS. Registers once.
let synced = false;
export function initThemeSync(onChange?: (resolved: 'dark' | 'light') => void): void {
  if (synced) return;
  synced = true;
  const mql = window.matchMedia('(prefers-color-scheme: light)');
  mql.addEventListener('change', () => {
    if (getStoredPref() === 'system') {
      applyPref('system');
      onChange?.(resolveTheme('system'));
    }
  });
}

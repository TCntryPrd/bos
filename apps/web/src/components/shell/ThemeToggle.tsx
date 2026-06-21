import { useEffect, useState } from 'react';
import { getStoredPref, setThemePref, initThemeSync, type ThemePref } from '../../lib/theme';

// Header theme control (LOCKED): Dark · Light · Follow System — plainly labeled,
// persisted per browser. Status is conveyed by icon + label (not color alone).
const OPTIONS: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '☾' },
  { value: 'system', label: 'System', icon: '🖥' },
];

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getStoredPref);

  useEffect(() => {
    initThemeSync();
  }, []);

  function choose(p: ThemePref) {
    setThemePref(p);
    setPref(p);
  }

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center rounded-md border border-border overflow-hidden"
    >
      {OPTIONS.map((o) => {
        const active = pref === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            title={`${o.label} theme`}
            onClick={() => choose(o.value)}
            className={`px-2 py-1 text-xs flex items-center gap-1 transition-colors ${
              active
                ? 'bg-accent/15 text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <span aria-hidden>{o.icon}</span>
            <span className="hidden md:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

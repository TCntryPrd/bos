import { useState } from 'react';
import { getStoredMode, setBossMode, type BossMode } from '../../lib/theme';

// Header display-mode control: Executive · Plain. Executive is the full themed
// identity; Plain is the flat, quiet operations look. Conveyed by icon + label
// (not color alone), persisted per browser.
const OPTIONS: { value: BossMode; label: string; icon: string }[] = [
  { value: 'executive', label: 'Executive', icon: '◆' },
  { value: 'plain', label: 'Plain', icon: '▭' },
];

export function ThemeToggle() {
  const [mode, setMode] = useState<BossMode>(getStoredMode);

  function choose(m: BossMode) {
    setBossMode(m);
    setMode(m);
  }

  return (
    <div
      role="group"
      aria-label="Display mode"
      className="inline-flex items-center rounded-md border border-border overflow-hidden"
    >
      {OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            title={`${o.label} mode`}
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

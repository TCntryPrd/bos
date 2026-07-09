import React from 'react';
import irBadge from '../../assets/ir-badge.png';
import { getAiosName } from '../../lib/theme';

/**
 * BOS lockup — Industry Rockstar badge + wordmark:
 *   BOS — {AIOS Name}
 *   BUSINESS OPERATING SYSTEM
 *   From Industry Rockstar
 * The AIOS name is per-install (see getAiosName); when unset the mark reads "BOS".
 * The badge is black artwork, so `.ir-mark` is inverted to white in the dark
 * (Executive) theme (see index.css).
 */
export function BossMark({ scale = 1, collapsed = false }: { scale?: number; collapsed?: boolean }) {
  const size = 28 * scale;
  const name = getAiosName();
  return (
    <div className="flex items-center" style={{ gap: 10 * scale }}>
      <img
        src={irBadge}
        alt="Industry Rockstar"
        className="ir-mark flex-shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
      {!collapsed && (
        <div className="leading-none">
          <div className="font-bold text-text-primary" style={{ fontSize: 15 * scale, letterSpacing: '0.18em' }}>
            BOS
            {name ? (
              <span className="font-semibold text-text-secondary" style={{ letterSpacing: '0.03em' }}>
                {' '}— {name}
              </span>
            ) : null}
          </div>
          <div
            className="vs-mono mt-1 text-text-muted"
            style={{ fontSize: 8.5 * scale, letterSpacing: '0.1em', whiteSpace: 'nowrap' }}
          >
            BUSINESS OPERATING SYSTEM
          </div>
          <div
            className="vs-mono mt-[3px] text-text-muted/70"
            style={{ fontSize: 7 * scale, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}
          >
            From Industry Rockstar
          </div>
        </div>
      )}
    </div>
  );
}

interface BossLogoProps {
  collapsed?: boolean;
  onCollapseToggle?: () => void;
}

export function BossLogo({ collapsed = false, onCollapseToggle }: BossLogoProps) {
  return (
    <div
      className={[
        'flex items-center gap-2 w-full',
        collapsed ? 'justify-center px-2 py-3.5' : 'px-3 py-3.5',
      ].join(' ')}
    >
      <div className="flex-1 min-w-0">
        <BossMark collapsed={collapsed} />
      </div>
      {onCollapseToggle && (
        <button
          type="button"
          onClick={onCollapseToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={[
            'flex-shrink-0 grid place-items-center text-text-muted hover:text-text-primary',
            'border border-border bg-surface-2/40 hover:bg-surface-2 transition-colors',
            collapsed ? 'w-6 h-6 rounded-md' : 'w-[22px] h-[22px] rounded',
          ].join(' ')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path
              d={collapsed ? 'M3.5 2L6.5 5L3.5 8' : 'M6.5 2L3.5 5L6.5 8'}
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

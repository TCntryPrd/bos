import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, LockOpen, Menu } from 'lucide-react';
import { getAiosName } from '../../lib/theme';
import { useTilesLocked, setTilesLocked } from '../../lib/tileLock';

function getUser(): { name: string; role: string } {
  try {
    const raw = localStorage.getItem('boss_user');
    if (!raw) return { name: 'User', role: 'user' };
    const u = JSON.parse(raw) as { displayName?: string; role?: string };
    return { name: u.displayName ?? 'User', role: u.role ?? 'user' };
  } catch {
    return { name: 'User', role: 'user' };
  }
}

interface TopBarProps {
  pageTitle: string;
  onMobileMenu?: () => void;
  immersive?: boolean;
}

export function TopBar({ pageTitle, onMobileMenu, immersive = false }: TopBarProps) {
  const { name, role } = getUser();
  const isAdmin = role === 'admin' || role === 'owner';
  const navigate = useNavigate();
  const aiosName = getAiosName();
  const locked = useTilesLocked();

  return (
    <header
      className={`boss-nav-surface flex-shrink-0 h-10 border-b border-border flex items-center px-4 gap-3 ${immersive ? 'backdrop-blur-xl shadow-lg' : ''}`}
      style={{ background: immersive ? 'rgba(5, 8, 15, 0.34)' : 'var(--v-nav-bg)' }}
      aria-label="Top bar"
    >
      {onMobileMenu && (
        <button
          className="lg:hidden w-6 h-6 rounded text-text-muted hover:text-text-primary flex items-center justify-center"
          onClick={onMobileMenu}
          aria-label="Open navigation menu"
        >
          <Menu className="w-4 h-4" aria-hidden />
        </button>
      )}
      <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
        BOS{aiosName ? <span className="text-text-muted/70"> · {aiosName}</span> : null}
      </div>
      <div className="text-text-muted/60 select-none" aria-hidden>
        /
      </div>
      <h1 className="text-sm font-medium text-text-primary leading-none">
        {pageTitle}
      </h1>
      {/* Tile lock — governs move/resize of tiles on every page. */}
      <button
        type="button"
        onClick={() => setTilesLocked(!locked)}
        className={`ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 transition-colors ${
          locked
            ? 'border-border text-text-muted hover:text-text-primary hover:bg-surface-2/60'
            : 'border-accent/50 text-accent bg-accent/10 hover:bg-accent/15'
        }`}
        aria-pressed={!locked}
        aria-label={locked ? 'Unlock tiles to arrange the layout' : 'Lock tile layout'}
        title={locked ? 'Unlock tiles — move & resize any tile, on any page' : 'Layout unlocked — drag or resize tiles, then lock'}
      >
        {locked ? <Lock className="w-3 h-3" aria-hidden /> : <LockOpen className="w-3 h-3" aria-hidden />}
        <span className="vs-mono hidden md:block text-[9px] tracking-[0.14em] uppercase">
          {locked ? 'Layout' : 'Editing'}
        </span>
      </button>
      {/* User pill — far right of the header (moved here from the nav rail). */}
      <button
        type="button"
        onClick={() => { if (isAdmin) navigate('/settings'); }}
        className={`ml-auto flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${isAdmin ? 'hover:bg-accent/10 cursor-pointer' : 'cursor-default'}`}
        aria-label={isAdmin ? 'Open Settings' : 'User'}
        title={isAdmin ? 'Settings' : name}
      >
        <span className="leading-tight text-right hidden sm:block">
          <span className="block text-[12px] text-text-primary truncate max-w-[160px]">{name}</span>
          <span className="vs-mono block text-[9px] tracking-[0.14em] uppercase text-accent">
            {role}
          </span>
        </span>
        <span
          className="w-[26px] h-[26px] rounded-full flex-shrink-0 grid place-items-center text-[11px] font-semibold text-[#0a0c12]"
          style={{ background: 'var(--grad-warm)', boxShadow: '0 6px 16px rgba(255,77,141,0.18)' }}
          aria-hidden
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      </button>
    </header>
  );
}

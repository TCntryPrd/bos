import React, { useState } from 'react';
import { Menu } from 'lucide-react';
import { AdminOverlay } from './AdminOverlay';
import { ThemeToggle } from './ThemeToggle';
import { getAiosName } from '../../lib/theme';

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
}

export function TopBar({ pageTitle, onMobileMenu }: TopBarProps) {
  const { name, role } = getUser();
  const isAdmin = role === 'admin' || role === 'owner';
  const [adminOpen, setAdminOpen] = useState(false);
  const aiosName = getAiosName();

  return (
    <header
      className="boss-nav-surface flex-shrink-0 h-10 border-b border-border flex items-center px-4 gap-3"
      style={{ background: 'var(--v-nav-bg)' }}
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

      {/* Theme toggle + user pill — far right of the header. */}
      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        <button
        type="button"
        onClick={() => { if (isAdmin) setAdminOpen(true); }}
        className={`flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${isAdmin ? 'hover:bg-accent/10 cursor-pointer' : 'cursor-default'}`}
        aria-label={isAdmin ? 'Open admin overlay' : 'User'}
        title={isAdmin ? 'Admin' : name}
      >
        <span className="leading-tight text-right hidden sm:block">
          <span className="block text-[12px] text-text-primary truncate max-w-[160px]">{name}</span>
          <span className="vs-mono block text-[9px] tracking-[0.14em] uppercase text-accent">
            {role}{isAdmin ? ' ⌥' : ''}
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
      </div>

      <AdminOverlay open={adminOpen} onClose={() => setAdminOpen(false)} />
    </header>
  );
}

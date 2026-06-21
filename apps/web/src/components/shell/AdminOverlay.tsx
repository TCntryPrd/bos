/**
 * AdminOverlay — full-viewport overlay launched from the NavRail user tile.
 *
 * Replaces the old in-rail Admin section. Per the v2 design handoff §4:
 *   "Admin is plumbing, not a destination."
 * Listed routes navigate and close the overlay.
 */

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  Mic2,
  Brain,
  Plug,
  BookOpen,
  ShieldCheck,
  DatabaseBackup,
  Settings,
  Users,
  Zap,
  LogOut,
} from 'lucide-react';

function handleSignOut() {
  localStorage.removeItem('boss_token');
  localStorage.removeItem('boss_refresh_token');
  localStorage.removeItem('boss_user');
  window.location.hash = '#/login';
  window.location.reload();
}

interface AdminLink {
  to: string;
  label: string;
  hue: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}

const ADMIN_LINKS: AdminLink[] = [
  { to: '/rascals',      label: 'Rascals',       hue: '#b56cff', icon: Users,          description: 'Per-client autonomous agents · cron · tmux' },
  { to: '/voice',        label: 'Voice Devices', hue: '#5cc8ff', icon: Mic2,           description: 'STT / TTS endpoints · Google Home · routing' },
  { to: '/brain',        label: 'Brain Config',  hue: '#b56cff', icon: Brain,          description: 'Model selection · system prompts · skills' },
  { to: '/connectors',   label: 'Connectors',    hue: '#4df5a5', icon: Plug,           description: 'OAuth + API keys for the 13 connectors' },
  { to: '/learning',     label: 'Learning',      hue: '#ff5cc8', icon: BookOpen,       description: 'Stored preferences and recall surface' },
  { to: '/self-healing', label: 'Self-Healing',  hue: '#ffb86b', icon: ShieldCheck,    description: 'Watchdog · auto-restart · incident log' },
  { to: '/backup',       label: 'Backup',        hue: '#4df5a5', icon: DatabaseBackup, description: 'Encrypted snapshots and rollback points' },
  { to: '/settings',     label: 'Settings',      hue: '#8a93a7', icon: Settings,       description: 'Tenant defaults · timezone · plan' },
];

interface AdminOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function AdminOverlay({ open, onClose }: AdminOverlayProps) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function go(path: string) {
    navigate(path);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Admin">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div
        className="relative w-full max-w-[860px] rounded-2xl border border-border overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(22,24,34,0.92), rgba(10,12,18,0.95))',
          boxShadow: '0 40px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(181,108,255,0.18)',
        }}
      >
        <div className="vs-aurora opacity-30 pointer-events-none" aria-hidden />

        <header className="relative flex items-start justify-between px-6 pt-5 pb-4 border-b border-border">
          <div>
            <div className="vs-mono text-[10px] uppercase tracking-[0.28em] text-text-muted">overlay / admin</div>
            <h2 className="text-xl font-semibold text-text-primary mt-1">Plumbing</h2>
            <p className="text-[12.5px] text-text-secondary mt-1">
              Configuration surfaces. Not a navigation destination — pick what you need and the overlay closes.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-md border border-border text-text-muted hover:text-text-primary hover:bg-surface-2 grid place-items-center transition-colors"
            aria-label="Close admin overlay"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-2 p-4">
          {ADMIN_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.to}
                type="button"
                onClick={() => go(item.to)}
                className="text-left group flex items-start gap-3 p-3 rounded-lg border border-border bg-surface-1/60 hover:bg-surface-2/70 hover:border-border-strong transition-colors"
              >
                <span
                  className="w-9 h-9 rounded-md grid place-items-center flex-shrink-0"
                  style={{ background: `${item.hue}1a`, border: `1px solid ${item.hue}55`, color: item.hue }}
                  aria-hidden
                >
                  <Icon className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-text-primary group-hover:text-white">{item.label}</span>
                  </div>
                  <p className="text-[11.5px] text-text-muted mt-0.5 leading-snug">{item.description}</p>
                </div>
              </button>
            );
          })}
        </div>

        <footer className="relative px-6 py-3 border-t border-border flex items-center gap-3">
          <Zap className="w-3.5 h-3.5 text-text-muted" aria-hidden />
          <span className="vs-mono text-[10px] tracking-[0.18em] uppercase text-text-muted">esc to close</span>
          <button
            type="button"
            onClick={handleSignOut}
            className="ml-auto flex items-center gap-1.5 vs-mono text-[10px] tracking-[0.16em] uppercase text-text-muted hover:text-danger transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </footer>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { NavRail } from './shell/NavRail';
import { TopBar } from './shell/TopBar';
import { BossOrb } from './shell/BossOrb';
import { useVoiceCommands } from '../hooks/useVoiceCommands';

const TITLE_MAP: Record<string, string> = {
  '/':             'Dashboard',
  '/calendar':     'Calendar',
  '/paperclip':    'Paperclip',
  '/crm':          'CRM',
  '/whatsapp':     'WhatsApp',
  '/oc':           'COE - Gio',
  '/rascals':      'Rascals',
  '/outsiders':    'Outsiders',
  '/voice':        'Voice Devices',
  '/brain':        'Brain Config',
  '/connectors':   'Connectors',
  '/learning':     'Learning',
  '/self-healing': 'Self-Healing',
  '/backup':       'Backup',
  '/settings':     'Settings',
  '/setup/claude-auth': 'Claude Auth',
};

function pageTitleFor(pathname: string): string {
  if (TITLE_MAP[pathname]) return TITLE_MAP[pathname];
  const match = Object.keys(TITLE_MAP)
    .filter((key) => key !== '/' && pathname.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return match ? TITLE_MAP[match] : 'BOS';
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('boss_sidebar_collapsed') === 'true';
  } catch {
    return false;
  }
}

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useVoiceCommands({ setCollapsed });

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('boss_sidebar_collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const pageTitle = useMemo(() => pageTitleFor(location.pathname), [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--v-base-bg, var(--v-base))' }}>
      {/* Desktop NavRail */}
      <div className="hidden lg:flex flex-shrink-0">
        <NavRail collapsed={collapsed} onCollapseToggle={toggleCollapse} />
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        </div>
      )}

      {/* Mobile NavRail drawer */}
      <div
        className={[
          'fixed inset-y-0 left-0 z-50 flex lg:hidden',
          'transform transition-transform duration-200 ease-in-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        aria-hidden={!mobileOpen}
      >
        <div className="relative">
          <NavRail
            collapsed={false}
            onCollapseToggle={() => setMobileOpen(false)}
            onNavClick={() => setMobileOpen(false)}
          />
          <button
            className="absolute top-3 right-2 p-1 rounded text-text-muted hover:text-text-primary"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar pageTitle={pageTitle} onMobileMenu={() => setMobileOpen(true)} />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>

      <BossOrb />
    </div>
  );
}

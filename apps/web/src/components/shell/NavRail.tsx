import React from 'react';
import {
  Building2,
  Eye,
  Frame,
  HeartPulse,
  LayoutDashboard,
  Linkedin,
  MessageCircle,
  Settings as SettingsIcon,
  TerminalSquare,
  UserCheck,
  Users,
} from 'lucide-react';
import { BossLogo } from './BossLogo';
import { NavTab } from './NavTab';
import { VoiceControl } from '../VoiceControl';

function getUserRole(): string {
  try {
    const raw = localStorage.getItem('boss_user');
    if (!raw) return 'user';
    return JSON.parse(raw).role ?? 'user';
  } catch {
    return 'user';
  }
}

interface NavRailProps {
  collapsed: boolean;
  onCollapseToggle?: () => void;
  onNavClick?: () => void;
  immersive?: boolean;
}

export function NavRail({ collapsed, onCollapseToggle, onNavClick, immersive = false }: NavRailProps) {
  const isAdmin = ['admin', 'owner'].includes(getUserRole());
  const railBg = immersive ? 'rgba(5, 8, 15, 0.34)' : 'var(--v-nav-bg)';

  return (
    <nav
      className={[
        'boss-nav-surface relative flex flex-col h-full border-r border-border',
        'transition-[width] duration-200',
        immersive ? 'backdrop-blur-xl shadow-2xl' : '',
        collapsed ? 'w-[56px]' : 'w-[212px]',
      ].join(' ')}
      style={{ background: railBg }}
      aria-label="Main navigation"
    >
      <div className="vs-aurora opacity-25 pointer-events-none" aria-hidden />

      <div className="relative flex-shrink-0 border-b border-border">
        <BossLogo collapsed={collapsed} onCollapseToggle={onCollapseToggle} />
      </div>

      <div className="relative flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        <NavTab to="/" end icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} onNavClick={onNavClick} />
        <NavTab to="/office" icon={Building2} label="Office" collapsed={collapsed} onNavClick={onNavClick} />
        <NavTab to="/board" icon={Eye} label="Advisory Board" collapsed={collapsed} onNavClick={onNavClick} />
        {import.meta.env.VITE_BUILDER === '1' && (
          <NavTab to="/builder" icon={TerminalSquare} label="Builder" collapsed={collapsed} onNavClick={onNavClick} />
        )}
        <NavTab to="/rascals" icon={Users} label="Client Managers" collapsed={collapsed} onNavClick={onNavClick} />

        {!collapsed && (
          <div className="vs-mono px-3 pt-4 pb-1 text-[10px] uppercase tracking-[0.22em] text-text-muted">
            Surfaces
          </div>
        )}
        {collapsed && <div className="h-px bg-border mx-2 my-2" aria-hidden />}

        <NavTab to="/canvas" icon={Frame} label="Canvas" variant="miro" collapsed={collapsed} onNavClick={onNavClick} />
        <NavTab to="/crm" icon={UserCheck} label="CRM" collapsed={collapsed} onNavClick={onNavClick} />
        <NavTab to="/linkedin" icon={Linkedin} label="LinkedIn" collapsed={collapsed} onNavClick={onNavClick} />
        <NavTab to="/whatsapp" icon={MessageCircle} label="WhatsApp" collapsed={collapsed} onNavClick={onNavClick} />

        {isAdmin && (
          <>
            {!collapsed && (
              <div className="vs-mono px-3 pt-4 pb-1 text-[10px] uppercase tracking-[0.22em] text-text-muted">
                Control
              </div>
            )}
            {collapsed && <div className="h-px bg-border mx-2 my-2" aria-hidden />}
            <NavTab to="/health" icon={HeartPulse} label="Health" collapsed={collapsed} onNavClick={onNavClick} />
            <NavTab to="/settings" icon={SettingsIcon} label="Settings" collapsed={collapsed} onNavClick={onNavClick} />
          </>
        )}
      </div>

      <div className="relative flex-shrink-0 border-t border-border">
        <div className={collapsed ? 'flex flex-col items-center py-2' : 'flex items-center px-3 py-2'}>
          <VoiceControl />
        </div>
      </div>
    </nav>
  );
}

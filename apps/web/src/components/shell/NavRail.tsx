import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Eye,
  UserCircle,
  Columns3,
  Frame,
  Calendar,
  UserCheck,
  Sparkles,
  Briefcase,
  Users,
  ChevronRight,
  MessageCircle,
  Brush,
  Terminal,
  Settings as SettingsIcon,
  TerminalSquare,
  Plug,
  HeartPulse,
} from 'lucide-react';
import { BossLogo } from './BossLogo';
import { NavTab } from './NavTab';
import { VoiceControl } from '../VoiceControl';
import { useAgentName, promptRenameAgent } from '../../lib/agentNames';

function getUserRole(): string {
  try {
    const raw = localStorage.getItem('boss_user');
    if (!raw) return 'user';
    return JSON.parse(raw).role ?? 'user';
  } catch {
    return 'user';
  }
}

interface IntegrationStatus {
  id: string;
  name?: string;
  configured: boolean;
}

const CONNECTOR_HUES: Record<string, string> = {
  google:        '#ea4335',
  google_workspace: '#ea4335',
  workspace:     '#ea4335',
  n8n:           '#ff6e5a',
  airtable:      '#ffb86b',
  notion:        '#e8ecf4',
  slack:         '#ff5cc8',
  telegram:      '#5cc8ff',
  make:          '#7c3cff',
  stripe:        '#9d8bff',
  homeassistant: '#20b26b',
  home_assistant: '#20b26b',
  ha:            '#20b26b',
  gemini:        '#0ea5e9',
  github:        '#e8ecf4',
  youtube:       '#ff5c5c',
  spotify:       '#20b26b',
};

function hueFor(id: string): string {
  return CONNECTOR_HUES[id] ?? '#718096';
}

function useConnections(): IntegrationStatus[] {
  const [list, setList] = useState<IntegrationStatus[]>([]);
  useEffect(() => {
    const token = localStorage.getItem('boss_token') ?? '';
    fetch('api/connectors/integrations', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        if (Array.isArray(data)) setList(data as IntegrationStatus[]);
      })
      .catch(() => { /* silent */ });
  }, []);
  return list;
}

interface NavRailProps {
  collapsed: boolean;
  onCollapseToggle: () => void;
  onNavClick?: () => void;
}

export function NavRail({ collapsed, onCollapseToggle, onNavClick }: NavRailProps) {
  const isAdmin = ['admin', 'owner'].includes(getUserRole());
  const connections = useConnections();
  const configuredCount = connections.filter((c) => c.configured).length;

  const [connOpen, setConnOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const navigate = useNavigate();

  const [claudeName] = useAgentName('claude');
  const [codexName] = useAgentName('codex');
  const [hermesName] = useAgentName('hermes');

  const railBg = 'var(--v-nav-bg)';

  return (
    <>
      <nav
        className={[
          'boss-nav-surface relative flex flex-col h-full border-r border-border',
          'transition-[width] duration-200',
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
          <NavTab to="/board" icon={Eye} label="Advisory Board" collapsed={collapsed} onNavClick={onNavClick} />
          <NavTab to="/coo" icon={UserCircle} label={claudeName} collapsed={collapsed} onNavClick={onNavClick} onRename={() => promptRenameAgent('claude')} />
          <NavTab to="/oc"  icon={Sparkles}   label={codexName} collapsed={collapsed} onNavClick={onNavClick} onRename={() => promptRenameAgent('codex')} />
          {isAdmin && (
            <NavTab to="/chief" icon={Sparkles} label={hermesName} collapsed={collapsed} onNavClick={onNavClick} onRename={() => promptRenameAgent('hermes')} />
          )}
          {isAdmin && (
            <NavTab to="/agents" icon={Briefcase} label="Employee Agents" collapsed={collapsed} onNavClick={onNavClick} />
          )}

          {!collapsed && (
            <div className="vs-mono px-3 pt-4 pb-1 text-[10px] uppercase tracking-[0.22em] text-text-muted">
              Surfaces
            </div>
          )}
          {collapsed && <div className="h-px bg-border mx-2 my-2" aria-hidden />}

          {import.meta.env.VITE_BUILDER === '1' && (
            <NavTab to="/builder" icon={TerminalSquare} label="Builder" collapsed={collapsed} onNavClick={onNavClick} />
          )}
          <NavTab to="/tasks" icon={Columns3} label="Task Board" variant="kanban" collapsed={collapsed} onNavClick={onNavClick} />
          <NavTab to="/canvas" icon={Frame} label="Canvas" variant="miro" collapsed={collapsed} onNavClick={onNavClick} />
          <NavTab to="/calendar" icon={Calendar}  label="Calendar" collapsed={collapsed} onNavClick={onNavClick} />
          <NavTab to="/crm"      icon={UserCheck} label="CRM"      collapsed={collapsed} onNavClick={onNavClick} />
          <NavTab to="/whatsapp" icon={MessageCircle} label="WhatsApp" collapsed={collapsed} onNavClick={onNavClick} />
          <NavTab to="/rascals" icon={Users} label="Your Team" collapsed={collapsed} onNavClick={onNavClick} />
            <NavTab to="/health" icon={HeartPulse} label="Health" collapsed={collapsed} onNavClick={onNavClick} />


          {/* Connections — expandable list with per-connector hue dots */}
          {!collapsed && (
            <div className="pt-3">
              <button
                type="button"
                onClick={() => setConnOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2/40 rounded-md transition-colors"
                aria-expanded={connOpen}
              >
                <ChevronRight
                  className={`w-3 h-3 text-text-muted transition-transform ${connOpen ? 'rotate-90' : ''}`}
                  aria-hidden
                />
                <span className="vs-mono flex-1 text-[10px] uppercase tracking-[0.22em] text-text-muted">Connected Apps</span>
                <span className="vs-mono text-[10px] text-success">{configuredCount}</span>
              </button>
              {connOpen && (
                <ul className="px-2 mt-1 space-y-px max-h-[200px] overflow-y-auto" role="list">
                  {connections.length === 0 ? (
                    <li className="px-3 py-1.5 text-[11px] text-text-muted italic">No connectors</li>
                  ) : connections.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-surface-2/40">
                      <span
                        className="w-1.5 h-1.5 rounded-sm flex-shrink-0"
                        style={{ background: hueFor(c.id), boxShadow: `0 0 6px ${hueFor(c.id)}99` }}
                      />
                      <span className="flex-1 text-[11.5px] text-text-secondary truncate">{c.name ?? c.id}</span>
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: c.configured ? '#20b26b' : '#cbd5e1', boxShadow: c.configured ? '0 0 5px #20b26b' : 'none' }}
                        title={c.configured ? 'configured' : 'not configured'}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* User tile + embedded voice control. The mic sits next to the
            user tile (per the v2 design, decided 2026-04-25) so chat-by-
            voice is a peer of chat-by-orb, not a floating overlay.
            Collapsed: avatar row on top, mic centered below. Expanded:
            user tile takes flex-1, mic sits on the right. The transcript
            bubble (when active) floats out of the rail to the right via
            absolute positioning relative to the mic button. */}
        {/* Settings popup → opens to the Connections page (or Settings). */}
        <div className="relative flex-shrink-0 border-t border-border">
          {settingsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSettingsOpen(false)} aria-hidden />
              <div
                className="absolute z-50 bottom-[calc(100%+6px)] left-2 right-2 rounded-lg border border-border bg-surface-1 shadow-xl overflow-hidden"
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setSettingsOpen(false); navigate('/connectors'); onNavClick?.(); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[12.5px] text-text-primary hover:bg-surface-2/60"
                >
                  <Plug className="w-4 h-4 text-accent" /> Connected Apps
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setSettingsOpen(false); navigate('/settings'); onNavClick?.(); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[12.5px] text-text-primary hover:bg-surface-2/60 border-t border-border/50"
                >
                  <SettingsIcon className="w-4 h-4 text-text-muted" /> Settings
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className={`flex items-center gap-2.5 text-left transition-colors w-full hover:bg-accent/8 ${collapsed ? 'p-2 justify-center' : 'px-3 py-2'}`}
            aria-label="Settings"
            aria-expanded={settingsOpen}
            title="Settings & Connections"
          >
            <SettingsIcon className="w-4 h-4 flex-shrink-0 text-text-muted" aria-hidden />
            {!collapsed && <span className="text-[12px] text-text-secondary">Settings</span>}
          </button>
        </div>

        <div className="relative flex-shrink-0 border-t border-border">
          <div className={collapsed ? 'flex flex-col items-center py-2' : 'flex items-center px-3 py-2'}>
            <VoiceControl />
          </div>
        </div>
      </nav>
    </>
  );
}

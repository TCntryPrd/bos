/**
 * agentNames — shared, editable display names for the three decision-maker
 * agents (Claude, Codex, Hermes).
 *
 * Names are user-editable from BOTH the NavBar and each agent's surface page.
 * They persist in localStorage and broadcast a change event so every mounted
 * consumer (nav rail + surface) updates live without a reload.
 */
import { useCallback, useEffect, useState } from 'react';

export type AgentId = 'claude' | 'codex' | 'hermes';

const KEY = (id: AgentId) => `boss_agent_name:${id}`;
const LEGACY_HERMES_KEY = 'boss_chief_name';
const CHANGE_EVENT = 'boss-agent-name-changed';

const DEFAULTS: Record<AgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes',
};

export function getAgentName(id: AgentId): string {
  try {
    const stored = localStorage.getItem(KEY(id));
    if (stored && stored.trim()) return stored;
    // Migrate the original Hermes name key so existing renames survive.
    if (id === 'hermes') {
      const legacy = localStorage.getItem(LEGACY_HERMES_KEY);
      if (legacy && legacy.trim()) {
        localStorage.setItem(KEY('hermes'), legacy);
        return legacy;
      }
    }
    return DEFAULTS[id];
  } catch {
    return DEFAULTS[id];
  }
}

export function setAgentName(id: AgentId, name: string): void {
  const v = name.trim().slice(0, 32);
  if (!v) return;
  try {
    localStorage.setItem(KEY(id), v);
    // Keep the legacy Hermes key in sync for any older consumer still reading it.
    if (id === 'hermes') localStorage.setItem(LEGACY_HERMES_KEY, v);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { id, name: v } }));
  } catch {
    /* ignore quota/availability errors */
  }
}

/** Prompt the user to rename an agent. Returns the new name, or null if cancelled. */
export function promptRenameAgent(id: AgentId): string | null {
  const current = getAgentName(id);
  const next = window.prompt(`Rename ${current}`, current);
  if (next && next.trim()) {
    setAgentName(id, next);
    return next.trim().slice(0, 32);
  }
  return null;
}

/** Live-updating display name for one agent, plus a setter. */
export function useAgentName(id: AgentId): [string, (name: string) => void] {
  const [name, setName] = useState<string>(() => getAgentName(id));
  useEffect(() => {
    const sync = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: AgentId } | undefined;
      if (!detail || detail.id === id) setName(getAgentName(id));
    };
    const onStorage = () => setName(getAgentName(id));
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, [id]);
  const update = useCallback((n: string) => setAgentName(id, n), [id]);
  return [name, update];
}

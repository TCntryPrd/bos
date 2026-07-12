import { useEffect } from 'react';
import { registerUICommand } from '../lib/ui-commands';

export interface VoiceCommandBridge {
  setCollapsed: (updater: (prev: boolean) => boolean) => void;
}

/**
 * Registers the baseline voice UI-commands that ship with every shell:
 *   - refresh_page   — reload the app
 *   - toggle_sidebar — collapse / expand the NavRail (honours action=open/close)
 *   - scroll_top     — scroll #main-content (or window) to top
 *
 * The brain invokes these via the `boss_ui_command` tool (see v1.2.1).
 * Per-feature commands register separately from their own components — this
 * hook only owns the three shell-scoped ones.
 */
export function useVoiceCommands({ setCollapsed }: VoiceCommandBridge): void {
  useEffect(() => {
    const unregs = [
      registerUICommand('refresh_page', () => {
        window.location.reload();
        return { ok: true, message: 'Refreshing.' };
      }),
      registerUICommand('toggle_sidebar', ({ action }) => {
        setCollapsed((prev) => {
          if (action === 'open')  return false;
          if (action === 'close') return true;
          return !prev;
        });
        return { ok: true, message: 'Sidebar toggled.' };
      }),
      registerUICommand('scroll_top', () => {
        const el = document.getElementById('main-content');
        (el ?? window).scrollTo({ top: 0, behavior: 'smooth' });
        return { ok: true, message: 'Scrolled to top.' };
      }),
    ];
    return () => { unregs.forEach((u) => u()); };
  }, [setCollapsed]);
}

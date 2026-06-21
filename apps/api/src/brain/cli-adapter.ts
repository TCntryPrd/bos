/**
 * cli-adapter.ts: BOS Brain CLI adapter.
 *
 * Pre-refactor (through 2026-05) this module spawned `claude -p`
 * directly inside boss_api and ran an ensureSession() tmux flow
 * that assumed tmux was installed in the container. Both were §2.2
 * violations of the BOS handoff v2.1 ("rascals act on host,
 * containers serve/receive").
 *
 * Post-refactor (2026-05-14): the legitimate persistent brain tmux
 * session `boss-brain-claude` runs on host, started outside this
 * codebase and surviving container restarts. The previous in-container
 * spawn paths were unused by any route and have been removed. If a
 * future caller needs brain-style CLI access from inside the API, do
 * it via apps/api/src/agents/host-bridge.ts (callBridge / SSH to host).
 *
 * Only `autoStartBrainSession` is kept (called from index.ts on boot)
 * and is now a no-op.
 */

export interface CLIBrainConfig {
  provider: 'claude' | 'codex' | 'gemini';
  mode?: 'print' | 'session';
  sessionName?: string;
  model?: string;
  systemPrompt?: string;
  workingDir?: string;
  timeout?: number;
}

export interface CLIBrainResponse {
  content: string;
  provider: string;
  mode: string;
  durationMs: number;
}

/**
 * Boot-time hook called from src/index.ts. The host brain tmux is
 * managed by the host (started manually or via a host-level systemd
 * unit), so the container has nothing to do here.
 */
export function autoStartBrainSession(): void {
  console.log('[cli-brain] Host-managed brain tmux; no in-container action.');
}

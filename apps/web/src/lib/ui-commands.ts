/**
 * UI Command Registry — voice-addressable actions on the current page.
 *
 * Pages/components register named callbacks here. When the brain emits
 * an SSE `event: ui_command`, VoiceControl dispatches it through this
 * registry. If the target is unknown, the registry returns a descriptive
 * error that is spoken back.
 *
 * Design notes:
 * - Singleton module-level registry (one live UI at a time — single-user app).
 * - Targets are lowercase_snake_case to match the brain's expected format.
 * - Callbacks receive `{ action, args }` so a single target can dispatch
 *   on the intended action (e.g. a "sidebar" target can handle both "open"
 *   and "close").
 * - `help` is a reserved target that returns the current registry listing.
 *
 * Phase V.3 / v1.2.1: this framework ships with 3 baseline commands wired
 * in Layout.tsx (refresh_page, toggle_sidebar, scroll_top). Per-feature
 * commands (Kanban, Miro, Airtable flows, etc.) plug in as those features
 * land.
 */

export interface UICommandPayload {
  action: string;
  target: string;
  args?: Record<string, unknown>;
}

export interface UICommandResult {
  ok: boolean;
  message: string;
}

export type UICommandHandler = (ctx: {
  action: string;
  args: Record<string, unknown>;
}) => UICommandResult | Promise<UICommandResult>;

const registry = new Map<string, UICommandHandler>();

export function registerUICommand(target: string, handler: UICommandHandler): () => void {
  registry.set(target, handler);
  return () => {
    // Only unregister if still mapped to this exact handler (guards against
    // re-register races in StrictMode double-mount scenarios).
    if (registry.get(target) === handler) registry.delete(target);
  };
}

export function listRegisteredTargets(): string[] {
  return Array.from(registry.keys()).sort();
}

export async function dispatchUICommand(payload: UICommandPayload): Promise<UICommandResult> {
  const target = (payload.target || '').trim();
  const action = payload.action || 'custom';
  const args = payload.args && typeof payload.args === 'object' ? payload.args : {};

  if (!target) {
    return { ok: false, message: 'No target was provided for that UI command.' };
  }

  if (target === 'help') {
    const list = listRegisteredTargets();
    if (list.length === 0) {
      return { ok: true, message: 'No UI commands are registered on this page.' };
    }
    return { ok: true, message: `Registered targets: ${list.join(', ')}.` };
  }

  const handler = registry.get(target);
  if (!handler) {
    const list = listRegisteredTargets();
    const hint = list.length ? ` Registered: ${list.join(', ')}.` : '';
    return {
      ok: false,
      message: `I don't know how to do "${action} ${target}" on this page.${hint}`,
    };
  }

  try {
    return await handler({ action, args });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Command "${target}" failed: ${msg}` };
  }
}

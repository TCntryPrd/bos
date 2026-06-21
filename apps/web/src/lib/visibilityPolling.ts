import { useEffect } from 'react';

/**
 * useVisibilityAwarePolling — kicks `tick` once on mount, then on a
 * setInterval. When the tab becomes hidden, intervals still fire but
 * the callback skips the work; when the tab returns to visible, the
 * callback fires immediately. This pauses background traffic without
 * dropping freshness when the user comes back.
 *
 * The callback should be referentially stable across re-renders that
 * shouldn't restart the interval. Pass it from a `useCallback` if it
 * captures props.
 */
export function useVisibilityAwarePolling(
  tick: () => void,
  intervalMs: number,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const run = () => { if (!cancelled && !document.hidden) tick(); };
    run();
    const id = window.setInterval(run, intervalMs);
    const onVis = () => { if (!cancelled && !document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [tick, intervalMs, active]);
}

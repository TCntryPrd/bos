/**
 * Generic data-fetching hook with loading, error, and refresh state.
 * Falls back to mock data when the API is unreachable in dev.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export type ApiStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseApiState<T> {
  data: T | null;
  status: ApiStatus;
  error: string | null;
  refresh: () => void;
  isLoading: boolean;
}

interface UseApiOptions<T> {
  /** If provided, poll at this interval (ms). */
  pollInterval?: number;
  /** Fallback data to use when the API call fails (e.g. mock data in dev). */
  fallback?: T;
  /** If false, skip the fetch entirely. Default: true. */
  enabled?: boolean;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  options: UseApiOptions<T> = {},
): UseApiState<T> {
  const { pollInterval, fallback, enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<ApiStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Stable refs so callbacks don't go stale
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const dataRef = useRef(data);
  dataRef.current = data;

  const fetchData = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await fetcherRef.current();
      setData(result);
      setStatus('success');
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setStatus('error');
      if (fallbackRef.current !== undefined && dataRef.current === null) {
        setData(fallbackRef.current);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void fetchData();

    if (!pollInterval) return;
    const id = setInterval(() => { void fetchData(); }, pollInterval);
    return () => clearInterval(id);
  }, [enabled, fetchData, pollInterval]);

  return {
    data,
    status,
    error,
    refresh: fetchData,
    isLoading: status === 'loading',
  };
}

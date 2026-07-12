import { useCallback, useEffect, useRef, useState } from 'react';

export interface CooMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useThreadMessages(threadId: string | null) {
  const [messages, setMessages] = useState<CooMessage[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);

  const load = useCallback(async (id: string, guardEmpty = false) => {
    // Skip if currently sending (avoids clobbering optimistic UI mid-stream)
    if (sendingRef.current) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`api/coo/threads/${id}/messages`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`messages ${res.status}`);
      const fresh = await res.json() as CooMessage[];

      // Guard: never replace non-empty local state with empty response (DB race)
      setMessages((prev) => {
        if (guardEmpty && prev.length > 0 && fresh.length === 0) return prev;
        // Also guard against receiving fewer messages than we have (stale response)
        if (guardEmpty && fresh.length < prev.length) return prev;
        return fresh;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    // Initial load without guard (allow empty to load on first mount)
    void load(threadId, false);

    // Poll every 10s to pick up messages from other sessions (e.g. CC chat)
    // Use guard on polls to prevent race conditions
    const interval = setInterval(() => load(threadId, true), 10_000);
    return () => clearInterval(interval);
  }, [threadId, load]);

  const append = useCallback((m: CooMessage) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const updateLast = useCallback((mut: (m: CooMessage) => CooMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      next[next.length - 1] = mut(next[next.length - 1]);
      return next;
    });
  }, []);

  const reload = useCallback(() => {
    if (threadId) void load(threadId, true);
  }, [threadId, load]);

  const setSending = useCallback((sending: boolean) => {
    sendingRef.current = sending;
  }, []);

  return { messages, isLoading, error, append, updateLast, reload, setSending };
}

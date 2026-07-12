import { useCallback, useEffect, useState } from 'react';

export interface CooThread {
  id: string;
  name: string;
  workspace_dir: string;
  created_at: string;
  updated_at: string;
  last_message_preview: string | null;
}

export interface CooWorkspace {
  label: string;
  path: string;
  kind: 'boss-dev' | 'rascal' | 'outsider';
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useCooThreads() {
  const [threads, setThreads] = useState<CooThread[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('api/coo/threads', { headers: authHeaders() });
      if (!res.ok) throw new Error(`threads list ${res.status}`);
      setThreads(await res.json() as CooThread[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async (name: string, workspace_dir: string): Promise<CooThread> => {
    const res = await fetch('api/coo/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, workspace_dir }),
    });
    if (!res.ok) throw new Error(`create thread ${res.status}`);
    const t = await res.json() as CooThread;
    setThreads((prev) => [t, ...prev]);
    return t;
  }, []);

  const rename = useCallback(async (id: string, name: string): Promise<void> => {
    const res = await fetch(`api/coo/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`rename thread ${res.status}`);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`api/coo/threads/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`delete thread ${res.status}`);
    setThreads((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { threads, isLoading, error, refresh, create, rename, remove };
}

export async function fetchWorkspaces(): Promise<CooWorkspace[]> {
  const token = localStorage.getItem('boss_token') ?? '';
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch('api/coo/workspaces', { headers });
  if (!res.ok) throw new Error(`workspaces ${res.status}`);
  return await res.json() as CooWorkspace[];
}

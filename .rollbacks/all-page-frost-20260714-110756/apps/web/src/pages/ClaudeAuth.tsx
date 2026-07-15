import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Send, Square, RefreshCw, Terminal } from 'lucide-react';

interface AuthStatus {
  home: string;
  workspace: string;
  claudeDirReady: boolean;
  claudeJsonReady: boolean;
  workspaceReady: boolean;
  activeSessions: number;
}

interface TerminalPayload {
  id: string;
  running: boolean;
  exitCode: number | null;
  error: string | null;
  output: string;
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem('boss_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch('/api/setup' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export function ClaudeAuth() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [session, setSession] = useState<TerminalPayload | null>(null);
  const [input, setInput] = useState('/login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminalRef = useRef<HTMLPreElement | null>(null);

  const terminalText = useMemo(() => {
    if (!session?.output) return 'Terminal is not started.';
    return stripAnsi(session.output);
  }, [session?.output]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<AuthStatus>('/claude-auth/status'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Claude auth status.');
    }
  }, []);

  const pollSession = useCallback(async (id: string) => {
    try {
      setSession(await api<TerminalPayload>(`/claude-auth/sessions/${id}/output`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read terminal output.');
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (!session?.id || !session.running) return;
    const timer = window.setInterval(() => void pollSession(session.id), 700);
    return () => window.clearInterval(timer);
  }, [pollSession, session?.id, session?.running]);

  useEffect(() => {
    const node = terminalRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [terminalText]);

  async function startTerminal() {
    setLoading(true);
    setError(null);
    try {
      const next = await api<TerminalPayload>('/claude-auth/start', { method: 'POST' });
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start Claude terminal.');
    } finally {
      setLoading(false);
    }
  }

  async function sendInput(data = `${input}\n`) {
    if (!session?.id || !session.running) return;
    setError(null);
    try {
      await api(`/claude-auth/sessions/${session.id}/input`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      });
      setInput('');
      await pollSession(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send terminal input.');
    }
  }

  async function stopTerminal() {
    if (!session?.id) return;
    setError(null);
    try {
      await api(`/claude-auth/sessions/${session.id}/stop`, { method: 'POST' });
      setSession(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to stop terminal.');
    }
  }

  const ready = Boolean(status?.claudeDirReady && status?.claudeJsonReady && status?.workspaceReady);

  return (
    <div className="aios-page h-full">
      <div className="aios-page-pad mx-auto flex h-full max-w-6xl flex-col">
        <header className="aios-command-hero mb-5 flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="vs-mono text-[11px] uppercase tracking-[0.22em] text-accent">First-use setup</p>
            <h1 className="mt-1 text-2xl font-semibold text-text-primary">Claude Auth</h1>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary gap-2" onClick={() => void loadStatus()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </button>
            {session?.running ? (
              <button type="button" className="btn-danger gap-2" onClick={() => void stopTerminal()}>
                <Square className="h-4 w-4" aria-hidden />
                Stop
              </button>
            ) : (
              <button type="button" className="btn-primary gap-2" onClick={() => void startTerminal()} disabled={loading || !ready}>
                <Play className="h-4 w-4" aria-hidden />
                {loading ? 'Starting' : 'Start'}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <section className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="aios-stat px-3 py-3">
            <div className="text-xs text-text-muted">Claude home</div>
            <div className="mt-1 truncate font-mono text-sm text-text-primary">{status?.home || '-'}</div>
          </div>
          <div className="aios-stat px-3 py-3">
            <div className="text-xs text-text-muted">Workspace</div>
            <div className="mt-1 truncate font-mono text-sm text-text-primary">{status?.workspace || '-'}</div>
          </div>
          <div className="aios-stat px-3 py-3">
            <div className="text-xs text-text-muted">Mounts</div>
            <div className={`mt-1 text-sm font-medium ${ready ? 'text-success' : 'text-warning'}`}>
              {ready ? 'Ready' : 'Missing path'}
            </div>
          </div>
        </section>

        <section className="aios-workbench flex min-h-0 flex-1 flex-col bg-[#080b10]">
          <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300">
            <Terminal className="h-4 w-4" aria-hidden />
            <span className="font-mono">claude</span>
            {session?.running && <span className="ml-auto text-success">running</span>}
            {session && !session.running && <span className="ml-auto text-warning">closed</span>}
          </div>
          <pre
            ref={terminalRef}
            className="min-h-[420px] flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-5 text-slate-100"
          >
            {terminalText}
          </pre>
          <form
            className="flex gap-2 border-t border-white/10 bg-white/[0.03] p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void sendInput();
            }}
          >
            <input
              className="input font-mono"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Type /login, paste code, or press Enter for the next prompt"
              disabled={!session?.running}
            />
            <button type="submit" className="btn-primary gap-2" disabled={!session?.running}>
              <Send className="h-4 w-4" aria-hidden />
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Loader2, RefreshCw, Sparkles, Zap } from 'lucide-react';

interface HermesStatus {
  cliInstalled: boolean;
  cliVersion: string | null;
  keyPresent: boolean;
  model: string;
  ready: boolean;
}

interface ActivateResult {
  ok: boolean;
  output: string;
  model: string;
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

function markFirstLoginComplete() {
  try {
    const raw = localStorage.getItem('boss_user');
    const user = raw ? JSON.parse(raw) : null;
    const id = user?.id || user?.email || 'default';
    localStorage.setItem(`boss_first_login_brain_setup_complete:${id}`, 'true');
  } catch { /* best effort */ }
  void fetch('/api/auth/complete-wizard', { method: 'POST', headers: authHeader() });
}

export function HermesSetup() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [activating, setActivating] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api<HermesStatus>('/hermes/status');
      setStatus(next);
      if (next.ready) setActivated(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Hermes status.');
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  async function activate() {
    setActivating(true);
    setError(null);
    setOutput(null);
    try {
      const result = await api<ActivateResult>('/hermes/activate', { method: 'POST' });
      setOutput(result.output);
      if (result.ok) {
        setActivated(true);
      } else {
        setError('Hermes did not come online. Check the output below and try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed.');
    } finally {
      setActivating(false);
    }
  }

  const prereqsReady = Boolean(status?.cliInstalled && status?.keyPresent);

  return (
    <div className="aios-page h-full">
      <div className="aios-page-pad mx-auto flex h-full max-w-4xl flex-col">
        <header className="aios-command-hero mb-5 px-4 py-3">
          <p className="vs-mono text-[11px] uppercase tracking-[0.22em] text-accent">First-use setup</p>
          <h1 className="mt-1 text-2xl font-semibold text-text-primary">Hermes Agent</h1>
          <p className="mt-1 text-sm text-text-muted">
            Hermes is your autonomous agent (by Nous Research). It runs on the Gemini key
            you entered during Setup — one click brings it online.
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <section className="mb-5 grid gap-3 sm:grid-cols-3">
          <div className="aios-stat px-3 py-3">
            <div className="text-xs text-text-muted">Hermes Agent</div>
            <div className={`mt-1 text-sm font-medium ${status?.cliInstalled ? 'text-success' : 'text-warning'}`}>
              {status ? (status.cliInstalled ? (status.cliVersion || 'Installed') : 'Not installed') : '-'}
            </div>
          </div>
          <div className="aios-stat px-3 py-3">
            <div className="text-xs text-text-muted">Gemini key</div>
            <div className={`mt-1 text-sm font-medium ${status?.keyPresent ? 'text-success' : 'text-warning'}`}>
              {status ? (status.keyPresent ? 'Loaded from Setup' : 'Missing — add it in Setup') : '-'}
            </div>
          </div>
          <div className="aios-stat px-3 py-3">
            <div className="text-xs text-text-muted">Brain</div>
            <div className="mt-1 truncate font-mono text-sm text-text-primary">{status?.model || '-'}</div>
          </div>
        </section>

        <section className="aios-panel flex flex-col items-center px-6 py-10 text-center">
          {activated ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-success" aria-hidden />
              <h2 className="mt-4 text-xl font-semibold text-text-primary">Hermes is online</h2>
              <p className="mt-1 text-sm text-text-muted">Your Gemini agent is live and ready to work.</p>
              <button
                type="button"
                className="btn-primary mt-6 gap-2"
                onClick={() => { markFirstLoginComplete(); navigate('/'); }}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                Enter your BOS
              </button>
            </>
          ) : (
            <>
              <Zap className="h-12 w-12 text-accent" aria-hidden />
              <h2 className="mt-4 text-xl font-semibold text-text-primary">Bring Hermes online</h2>
              <p className="mt-1 max-w-md text-sm text-text-muted">
                This runs one live round-trip through the Hermes Agent to confirm it
                answers on your key, then marks it ready.
              </p>
              <div className="mt-6 flex items-center gap-3">
                <button type="button" className="btn-secondary gap-2" onClick={() => void loadStatus()} disabled={activating}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn-primary gap-2"
                  onClick={() => void activate()}
                  disabled={activating || !prereqsReady}
                >
                  {activating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Zap className="h-4 w-4" aria-hidden />}
                  {activating ? 'Activating…' : 'Activate Hermes'}
                </button>
              </div>
              {!prereqsReady && status && (
                <p className="mt-3 text-xs text-warning">
                  {!status.cliInstalled
                    ? 'The Hermes Agent is not installed on this BOS yet.'
                    : 'No Gemini key found — enter it in Setup first.'}
                </p>
              )}
            </>
          )}
        </section>

        {output && !activated && (
          <section className="aios-frost-surface--dark mt-4 overflow-hidden rounded-lg border border-border bg-[#080b10]">
            <div className="border-b border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-xs text-slate-300">
              gemini output
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-5 text-slate-100">
              {output}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}

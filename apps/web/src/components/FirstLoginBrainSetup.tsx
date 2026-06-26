import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, KeyRound, X } from 'lucide-react';
import { brainApi, connectorsApi } from '../lib/api';
import type { BrainProvider } from '../types/api';

type Step = 'google' | 'openai' | 'openai-key' | 'claude' | 'claude-key' | 'openrouter' | 'openrouter-key' | 'hermes' | 'done';

interface StoredUser {
  id?: string;
  email?: string;
  role?: string;
}

function readUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem('boss_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setupStorageKey(user: StoredUser | null): string {
  const id = user?.id || user?.email || 'default';
  return `boss_first_login_brain_setup_complete:${id}`;
}

function shouldShowSetup(user: StoredUser | null): boolean {
  if (!user || (user.role !== 'admin' && user.role !== 'owner')) return false;
  try {
    return localStorage.getItem(setupStorageKey(user)) !== 'true';
  } catch {
    return false;
  }
}

function providerLabel(provider: BrainProvider): string {
  if (provider === 'claude-code') return 'Claude CLI';
  if (provider === 'openrouter') return 'OpenRouter';
  return 'Codex CLI';
}

export function FirstLoginBrainSetup() {
  const user = useMemo(readUser, []);
  const navigate = useNavigate();
  const [visible, setVisible] = useState(() => shouldShowSetup(user));
  const [step, setStep] = useState<Step>('google');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const domain = typeof window !== 'undefined' ? window.location.host : '';
  const redirectUri = `${origin}/api/connectors/oauth/google/callback`;

  // Auto-load the OAuth client JSON the operator downloads from Google Cloud.
  async function handleCredFileFL(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setMessage(null);
    try {
      const node = JSON.parse(await file.text());
      const cfg = node.web ?? node.installed ?? node;
      const id = (cfg.client_id ?? '').trim();
      const secret = (cfg.client_secret ?? '').trim();
      if (!id || !secret) {
        setError('That file is missing client_id / client_secret. Download the OAuth client JSON from Google Cloud.');
        return;
      }
      setSaving(true);
      await connectorsApi.configureOAuth('google', id, secret);
      setMessage('Google credentials loaded. Finish setup, then click Connect Google on the Connectors page.');
    } catch {
      setError('Could not read that file. Use the credentials JSON you downloaded from Google.');
    } finally {
      setSaving(false);
    }
  }

  async function requestGoogleAssist() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await connectorsApi.requestOAuthAssist('google', domain, user?.email ?? '', '');
      setMessage('Request sent. Your provider will set up the Google connection and let you know when it is ready.');
    } catch {
      setError('Could not send the request. Try again, or use the guide to do it yourself.');
    } finally {
      setSaving(false);
    }
  }

  if (!visible) return null;

  async function finish() {
    try {
      localStorage.setItem(setupStorageKey(user), 'true');
    } catch {
      // Ignore storage failures; the modal can be dismissed for this page load.
    }
    try {
      const token = localStorage.getItem('boss_token');
      await fetch('/api/auth/complete-wizard', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      // The local marker still prevents a repeated modal on this browser.
    }
    setVisible(false);
  }

  async function saveProvider(provider: BrainProvider) {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('Paste the API key first.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await brainApi.configureProvider(provider, {
        apiKey: trimmed,
        ...(provider === 'openrouter' ? { model: 'google/gemma-4-26b-a4b-it:free' } : {}),
      });
      setApiKey('');
      setMessage(`${providerLabel(provider)} is saved and loaded for this BOS.`);
      setStep(provider === 'openai' ? 'claude' : provider === 'claude-code' ? 'openrouter' : 'hermes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save this API key.');
    } finally {
      setSaving(false);
    }
  }

  const keyForm = (
    provider: BrainProvider,
    label: string,
    placeholder: string,
  ) => (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          {label}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2.5 rounded-lg bg-surface-3 border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent font-mono"
          autoFocus
        />
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          className="btn-secondary flex-1 justify-center"
          onClick={() => {
            setApiKey('');
            setError(null);
            setStep(provider === 'openai' ? 'claude' : provider === 'claude-code' ? 'openrouter' : 'hermes');
          }}
          disabled={saving}
        >
          Skip
        </button>
        <button
          type="button"
          className="btn-primary flex-1 justify-center gap-2"
          onClick={() => void saveProvider(provider)}
          disabled={saving}
        >
          <KeyRound className="w-4 h-4" aria-hidden />
          {saving ? 'Loading...' : 'Load API Key'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden="true" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-login-brain-title"
        className="relative w-full max-w-lg rounded-lg border border-border bg-surface-1 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase text-accent">First login setup</p>
            <h2 id="first-login-brain-title" className="text-lg font-semibold text-text-primary">
              AI provider setup
            </h2>
          </div>
          <button
            type="button"
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-3"
            onClick={() => void finish()}
            aria-label="Close setup"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {message && (
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              {message}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          {step === 'google' && (
            <>
              <p className="text-sm text-text-primary">Connect Google Workspace (optional)</p>
              <p className="text-xs text-text-muted">
                Lets your Email &amp; Calendar agent read your inbox, draft replies, and manage your
                calendar. Your keys stay on this server. About 10 minutes, once.
              </p>
              <a
                className="text-xs text-accent underline inline-block"
                href={`/guides/google-workspace-setup.html?domain=${encodeURIComponent(domain)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open the step-by-step guide
              </a>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] bg-surface-3 border border-border rounded px-2 py-1.5 break-all">
                  {redirectUri}
                </code>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => navigator.clipboard?.writeText(redirectUri)}
                >
                  Copy
                </button>
              </div>
              <label className="btn-secondary w-full justify-center gap-2 cursor-pointer">
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleCredFileFL}
                />
                Upload credentials.json
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="btn-secondary flex-1 justify-center"
                  onClick={() => void requestGoogleAssist()}
                  disabled={saving}
                >
                  Have it set up for me
                </button>
                <button
                  type="button"
                  className="btn-primary flex-1 justify-center"
                  onClick={() => { setMessage(null); setError(null); setStep('openai'); }}
                >
                  Continue
                </button>
              </div>
            </>
          )}

          {step === 'openai' && (
            <>
              <p className="text-sm text-text-primary">Do you have an OpenAI API key?</p>
              <p className="text-xs text-text-muted">Yes loads it for Codex CLI. No moves to the next provider question.</p>
              <div className="flex gap-3">
                <button type="button" className="btn-primary flex-1 justify-center" onClick={() => setStep('openai-key')}>
                  Yes, set up Codex CLI
                </button>
                <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setStep('claude')}>
                  No
                </button>
              </div>
            </>
          )}

          {step === 'openai-key' && keyForm('openai', 'OpenAI API key', 'sk-...')}

          {step === 'claude' && (
            <>
              <p className="text-sm text-text-primary">Do you have Claude API access or a Claude subscription?</p>
              <p className="text-xs text-text-muted">Choose API to load a key here. Choose subscription if Claude CLI will be signed in outside this browser.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button type="button" className="btn-primary justify-center" onClick={() => setStep('claude-key')}>
                  Claude API
                </button>
                <button
                  type="button"
                  className="btn-secondary justify-center"
                  onClick={() => {
                    setVisible(false);
                    navigate('/setup/claude-auth');
                  }}
                >
                  Subscription
                </button>
                <button type="button" className="btn-secondary justify-center" onClick={() => setStep('openrouter')}>
                  No
                </button>
              </div>
            </>
          )}

          {step === 'claude-key' && keyForm('claude-code', 'Claude API key', 'sk-ant-...')}

          {step === 'openrouter' && (
            <>
              <p className="text-sm text-text-primary">Do you have OpenRouter?</p>
              <p className="text-xs text-text-muted">
                If no, sign up and add money or try the community free route. You are still connected to the free Google Gemma 4 model.
              </p>
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn-primary flex-1 justify-center" onClick={() => setStep('openrouter-key')}>
                  Yes, load OpenRouter
                </button>
                <a
                  className="btn-secondary flex-1 justify-center gap-2"
                  href="https://openrouter.ai/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Sign Up
                  <ExternalLink className="w-4 h-4" aria-hidden />
                </a>
                <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setStep('hermes')}>
                  No
                </button>
              </div>
            </>
          )}

          {step === 'openrouter-key' && keyForm('openrouter', 'OpenRouter API key', 'sk-or-v1-...')}

          {step === 'hermes' && (
            <>
              <p className="text-sm text-text-primary">Last step: bring your Hermes agent online.</p>
              <p className="text-xs text-text-muted">
                Hermes is your Gemini-powered agent. It uses the Gemini key from Setup — activation
                takes one click and a few seconds.
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="btn-primary flex-1 justify-center"
                  onClick={() => {
                    setVisible(false);
                    navigate('/setup/hermes');
                  }}
                >
                  Set up Hermes
                </button>
                <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setStep('done')}>
                  Skip
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <p className="text-sm text-text-primary">Provider questions complete.</p>
              <p className="text-xs text-text-muted">
                You are still connected to the free Google Gemma 4 model until you switch to another loaded provider.
              </p>
              <button type="button" className="btn-primary w-full justify-center" onClick={() => void finish()}>
                Close
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

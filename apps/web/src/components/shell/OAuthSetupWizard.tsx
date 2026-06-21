import { useEffect, useState } from 'react';
import { X, ExternalLink, Copy, Check, ShieldAlert, KeyRound } from 'lucide-react';
import { getOAuthGuide, redirectUriFor } from '../../config/oauthProviders';
import { connectorsApi } from '../../lib/api';

interface Props {
  providerId: string;
  open: boolean;
  onClose: () => void;
  /** Hand off to the existing OAuth start flow once creds are saved. */
  onAuthorize: (providerId: string) => void;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-text-muted mb-1">{label}</div>
      <div className="flex items-center gap-2 bg-surface-3 border border-border rounded-md px-2 py-1.5">
        <code className="flex-1 text-[12px] text-text-primary break-all">{value}</code>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-text-muted hover:text-text-primary shrink-0"
        >
          {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

export function OAuthSetupWizard({ providerId, open, onClose, onAuthorize }: Props) {
  const guide = getOAuthGuide(providerId);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setClientId('');
      setClientSecret('');
      setSaved(false);
      setError(null);
    }
  }, [open, providerId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Fail-closed: never render a broken popup for an unknown provider.
  if (!guide) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
        <div className="bg-surface-2 border border-border rounded-xl p-6 max-w-md" onClick={(e) => e.stopPropagation()}>
          <p className="text-text-primary text-sm">A setup guide for “{providerId}” isn’t available yet.</p>
          <button className="btn-secondary mt-4 text-xs" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const redirectUri = redirectUriFor(guide);

  async function save() {
    if (!guide) return;
    setSaving(true);
    setError(null);
    try {
      await connectorsApi.configureOAuthApp(guide.id, clientId.trim(), clientSecret.trim());
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save credentials');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Set up ${guide.name}`}
      onClick={onClose}
    >
      <div
        className="bg-surface-1 border border-border rounded-xl shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-text-primary font-semibold">Connect {guide.name}</h2>
          <button aria-label="Close" onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid md:grid-cols-2 overflow-y-auto">
          {/* Left — create-your-own-app instructions */}
          <div className="p-5 space-y-4 border-b md:border-b-0 md:border-r border-border">
            <p className="text-[13px] text-text-secondary leading-relaxed">
              You’ll create your own {guide.appType} and paste its credentials here. The BOS never ships shared keys —
              your connection stays yours.
            </p>
            <a
              href={guide.devPortalUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary inline-flex text-xs gap-1.5"
            >
              Open {guide.devPortalLabel} <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <ol className="space-y-2 text-[13px] text-text-primary list-decimal list-inside">
              {guide.steps.map((s, i) => (
                <li key={i} className="leading-relaxed">{s}</li>
              ))}
            </ol>
            <CopyField label="Redirect URI (paste this into your app)" value={redirectUri} />
            <CopyField label="Scopes / permissions" value={guide.scopes.join(' ')} />
            {guide.warning && (
              <div className="flex gap-2 text-[12px] text-warning bg-warning/10 border border-warning/30 rounded-md px-3 py-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{guide.warning}</span>
              </div>
            )}
          </div>

          {/* Right — paste credentials, save, authorize */}
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-2 text-text-primary font-medium text-sm">
              <KeyRound className="w-4 h-4" /> Your app credentials
            </div>
            {guide.credentialFields.map((f) => (
              <label key={f.key} className="block">
                <span className="text-[11px] uppercase tracking-wide text-text-muted">{f.label}</span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={f.key === 'clientId' ? clientId : clientSecret}
                  onChange={(e) => (f.key === 'clientId' ? setClientId(e.target.value) : setClientSecret(e.target.value))}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-surface-3 border border-border text-text-primary text-[13px] focus:outline-none focus:border-accent"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            ))}
            {error && <div className="text-[12px] text-danger">{error}</div>}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                disabled={saving || !clientId.trim() || !clientSecret.trim()}
                onClick={save}
                className="btn-secondary text-xs disabled:opacity-40"
              >
                {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save credentials'}
              </button>
              <button
                type="button"
                disabled={!saved}
                onClick={() => onAuthorize(guide.id)}
                className="text-xs px-3 py-2 rounded-md bg-accent text-white font-medium disabled:opacity-40"
              >
                Authorize →
              </button>
            </div>
            <p className="text-[11px] text-text-muted leading-relaxed">
              After saving, “Authorize” sends you to {guide.name} to grant access. Your client secret is stored
              encrypted; the BOS only keeps what you enter here.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

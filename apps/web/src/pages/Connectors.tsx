/**
 * Connectors — the Connections page. Manage all integrations:
 *   • OAuth (Google) — Connect launches the consent flow; you authorize your
 *     own account and BOS stores your tokens.
 *   • API-key (the rest) — click Configure, paste the key (and Base URL for
 *     self-hosted services like n8n / Home Assistant). Saved to your tenant
 *     config so your tools use your key immediately.
 */

import React, { useEffect, useState } from 'react';
import {
  Plug, RefreshCw, ExternalLink, Trash2, CheckCircle2, Loader2, KeyRound,
} from 'lucide-react';
import { Card } from '../components/Card';
import { connectorsApi } from '../lib/api';
import { OAuthSetupWizard } from '../components/shell/OAuthSetupWizard';
import { getOAuthGuide } from '../config/oauthProviders';

interface Integration {
  id: string;
  name: string;
  type: 'oauth' | 'apikey';
  configured: boolean;
  envVar?: string;
  needsBaseUrl?: boolean;
  baseUrl?: string;
}

// Per-connector presentation + where to get the credential.
const META: Record<string, { hue: string; initials: string; keyLabel: string; help: string; helpUrl?: string; extras?: Array<{ field: string; label: string }> }> = {
  google:        { hue: '#4F6DF5', initials: 'G', keyLabel: 'OAuth', help: 'Gmail, Calendar, Drive, Contacts. Connect and authorize your Google account.' },
  linkedin:      { hue: '#0A66C2', initials: 'in', keyLabel: 'OAuth', help: 'Post to LinkedIn and read your profile. Connect and authorize your LinkedIn account.' },
  n8n:           { hue: '#FF6E5A', initials: 'n8', keyLabel: 'API key', help: 'n8n → Settings → API → create an API key. Base URL is your n8n instance.', helpUrl: 'https://docs.n8n.io/api/authentication/' },
  notion:        { hue: '#E8ECF4', initials: 'N', keyLabel: 'Integration token', help: 'Create an internal integration and copy its token.', helpUrl: 'https://www.notion.so/my-integrations' },
  airtable:      { hue: '#FFB86B', initials: 'A', keyLabel: 'Personal access token', help: 'Create a personal access token with the scopes you need.', helpUrl: 'https://airtable.com/create/tokens' },
  slack:         { hue: '#FF5CC8', initials: 'S', keyLabel: 'Bot token (xoxb-)', help: 'From your Slack app → OAuth & Permissions. Add the signing secret too.', helpUrl: 'https://api.slack.com/apps', extras: [{ field: 'signingSecret', label: 'Signing secret' }] },
  telegram:      { hue: '#5CC8FF', initials: 'T', keyLabel: 'Bot token', help: 'Create a bot with @BotFather and paste its token.', helpUrl: 'https://t.me/BotFather', extras: [{ field: 'adminChatId', label: 'Admin chat ID (optional)' }] },
  make:          { hue: '#7C3CFF', initials: 'M', keyLabel: 'API token', help: 'Make → Profile → API → generate a token.', helpUrl: 'https://www.make.com/en/help/apps/connect/connecting-to-the-make-api' },
  stripe:        { hue: '#9D8BFF', initials: 'St', keyLabel: 'Secret key (sk_…)', help: 'Stripe Dashboard → Developers → API keys.', helpUrl: 'https://dashboard.stripe.com/apikeys' },
  nim:           { hue: '#76B900', initials: 'NIM', keyLabel: 'API key', help: 'Unlocks Email v3 triage + deterministic CFO reasoning. Free key at build.nvidia.com.', helpUrl: 'https://build.nvidia.com' },
  unipile:       { hue: '#5C6BC0', initials: 'Up', keyLabel: 'API key', help: 'Unlocks LinkedIn + WhatsApp messaging via Unipile. Base URL = your Unipile DSN.', helpUrl: 'https://www.unipile.com/' },
  'linkedin-gpt':{ hue: '#0A66C2', initials: 'Li', keyLabel: 'Shared secret', help: 'Optional secret for the LinkedIn Custom-GPT action bridge.' },
  homeassistant: { hue: '#20B26B', initials: 'HA', keyLabel: 'Long-lived token', help: 'HA → Profile → Long-lived access tokens. Base URL is your HA instance.', helpUrl: 'https://www.home-assistant.io/docs/authentication/' },
  gemini:        { hue: '#0EA5E9', initials: 'Ge', keyLabel: 'API key', help: 'Get a key from Google AI Studio.', helpUrl: 'https://aistudio.google.com/apikey' },
  github:        { hue: '#E8ECF4', initials: 'GH', keyLabel: 'Personal access token', help: 'GitHub → Settings → Developer settings → tokens.', helpUrl: 'https://github.com/settings/tokens' },
  youtube:       { hue: '#FF5C5C', initials: 'YT', keyLabel: 'API key', help: 'YouTube Data API key (can reuse your Gemini/Google key).', helpUrl: 'https://console.cloud.google.com/apis/credentials' },
  miro:          { hue: '#FFD02F', initials: 'Mi', keyLabel: 'Access token', help: 'Powers the Canvas board surface. Create an access token in your Miro app settings.', helpUrl: 'https://miro.com/app/settings/user-profile/apps' },
};

function StatusPill({ on }: { on: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${on ? 'text-success bg-success/10' : 'text-text-muted bg-surface-3'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-success' : 'bg-text-muted'}`} aria-hidden />
      {on ? 'Connected' : 'Not connected'}
    </span>
  );
}

function ApiKeyForm({ integ, onSaved }: { integ: Integration; onSaved: () => void }) {
  const meta = META[integ.id] ?? { hue: '#718096', initials: '?', keyLabel: 'API key', help: '' };
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(integ.baseUrl ?? '');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!apiKey.trim()) { setErr('Enter the key first.'); return; }
    setSaving(true); setErr(null);
    try {
      await connectorsApi.configureIntegration(integ.id, apiKey.trim(), {
        baseUrl: integ.needsBaseUrl ? baseUrl.trim() : undefined,
        extraKeys: Object.keys(extras).length ? extras : undefined,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-border/40 space-y-2.5">
      <p className="text-[11.5px] text-text-muted">
        {meta.help}{' '}
        {meta.helpUrl && (
          <a href={meta.helpUrl} target="_blank" rel="noopener noreferrer" className="text-accent inline-flex items-center gap-0.5">
            get it <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </p>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={integ.configured ? `${meta.keyLabel} — enter to replace` : meta.keyLabel}
        className="w-full px-3 py-2 rounded-md bg-surface-2/60 border border-border text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60"
        autoComplete="off"
      />
      {integ.needsBaseUrl && (
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="Base URL (e.g. https://your-instance.example.com)"
          className="w-full px-3 py-2 rounded-md bg-surface-2/60 border border-border text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60"
        />
      )}
      {(meta.extras ?? []).map((ex) => (
        <input
          key={ex.field}
          type="password"
          value={extras[ex.field] ?? ''}
          onChange={(e) => setExtras((p) => ({ ...p, [ex.field]: e.target.value }))}
          placeholder={ex.label}
          className="w-full px-3 py-2 rounded-md bg-surface-2/60 border border-border text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60"
          autoComplete="off"
        />
      ))}
      {err && <p className="text-[11.5px] text-danger">{err}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary text-xs gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
          {integ.configured ? 'Update key' : 'Save & connect'}
        </button>
      </div>
    </div>
  );
}

function IntegrationCard({ integ, onConnectOAuth, onChanged }: {
  integ: Integration;
  onConnectOAuth: (id: string) => void;
  onChanged: () => void;
}) {
  const meta = META[integ.id] ?? { hue: '#718096', initials: '?', keyLabel: 'API key', help: '' };
  const [open, setOpen] = useState(false);

  async function disconnect() {
    if (!window.confirm(`Disconnect ${integ.name}? BOS will lose access until you reconnect.`)) return;
    try { await connectorsApi.deleteIntegration(integ.id); onChanged(); } catch { /* surfaced via refresh */ }
  }

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white text-xs font-bold" style={{ background: meta.hue, color: meta.hue === '#E8ECF4' ? '#0a0c12' : '#fff' }}>
          {meta.initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary">{integ.name}</span>
            <StatusPill on={integ.configured} />
            <span className="text-[10px] uppercase tracking-wider text-text-muted">{integ.type === 'oauth' ? 'OAuth' : 'API key'}</span>
          </div>

          {integ.type === 'oauth' ? (
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => onConnectOAuth(integ.id)} className="btn-secondary text-xs gap-1.5">
                {integ.configured ? 'Reconnect' : 'Connect'} <ExternalLink className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11.5px] text-text-muted">{META[integ.id]?.help}</span>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button type="button" onClick={() => setOpen((v) => !v)} className="btn-secondary text-xs gap-1.5">
                <KeyRound className="w-3.5 h-3.5" /> {integ.configured ? 'Update' : 'Configure'}
              </button>
              {integ.configured && (
                <button type="button" onClick={() => void disconnect()} className="btn-ghost text-xs gap-1 text-danger">
                  <Trash2 className="w-3.5 h-3.5" /> Disconnect
                </button>
              )}
            </div>
          )}

          {integ.type === 'apikey' && open && (
            <ApiKeyForm integ={integ} onSaved={() => { setOpen(false); onChanged(); }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function Connectors() {
  const [list, setList] = useState<Integration[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [wizardProvider, setWizardProvider] = useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    connectorsApi.getIntegrations()
      .then((d) => { setList(d); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed to load connections'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function startOAuth(id: string) {
    try {
      // The OAuth connector id IS the provider (google | linkedin | slack | meta | microsoft).
      const { url } = await connectorsApi.getOAuthUrl(id);
      window.location.href = url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start OAuth');
    }
  }

  // Connect opens the create-your-own-app setup wizard when a guide exists
  // (LinkedIn/Meta/Slack/Google); otherwise starts OAuth directly.
  function connectOAuth(id: string) {
    if (getOAuthGuide(id)) setWizardProvider(id);
    else void startOAuth(id);
  }

  const oauth = (list ?? []).filter((i) => i.type === 'oauth');
  const apikeys = (list ?? []).filter((i) => i.type === 'apikey');
  const connectedCount = (list ?? []).filter((i) => i.configured).length;

  return (
    <div className="space-y-6 animate-fade-in p-5 lg:p-6">
      <Card>
        <Card.Header
          title="Connections"
          subtitle={list ? `${connectedCount} of ${list.length} connected — OAuth services authorize your account; API-key services store your key.` : 'Manage your service connections'}
          action={
            <button className="btn-ghost text-xs gap-1.5" onClick={load} aria-label="Refresh connections">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh
            </button>
          }
        />
      </Card>

      {err && <div className="text-[12px] text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2">{err}</div>}

      {loading && !list ? (
        <div className="flex items-center gap-2 text-text-muted text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading connections…</div>
      ) : list && list.length > 0 ? (
        <>
          {oauth.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Sign-in (OAuth)</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {oauth.map((i) => <IntegrationCard key={i.id} integ={i} onConnectOAuth={connectOAuth} onChanged={load} />)}
              </div>
            </section>
          )}
          <section>
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">API key</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {apikeys.map((i) => <IntegrationCard key={i.id} integ={i} onConnectOAuth={connectOAuth} onChanged={load} />)}
            </div>
          </section>
        </>
      ) : (
        <Card><Card.Body>
          <div className="flex flex-col items-center py-8 text-center text-text-muted">
            <Plug className="w-10 h-10 mb-2" />
            <p className="text-sm">No connections available.</p>
          </div>
        </Card.Body></Card>
      )}

      <p className="text-[11.5px] text-text-muted flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 text-success" /> Keys are stored in your workspace config and used by your agents immediately. Disconnect any time.
      </p>

      <OAuthSetupWizard
        providerId={wizardProvider ?? ''}
        open={!!wizardProvider}
        onClose={() => setWizardProvider(null)}
        onAuthorize={(p) => { setWizardProvider(null); void startOAuth(p); }}
      />
    </div>
  );
}

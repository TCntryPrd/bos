/**
 * Settings — tenant config, TTS voice, wake word, notifications.
 */

import React, { useState, useEffect } from 'react';
import {
  Settings as SettingsIcon,
  Save,
  RefreshCw,
  CheckCircle2,
  KeyRound,
  Bell,
  BellOff,
  Mic,
  Volume2,
  Globe,
  Clock,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Card } from '../components/Card';
import { PageLoader } from '../components/LoadingSpinner';
import { useApi } from '../hooks/useApi';
import { settingsApi } from '../lib/api';
import { mockSettings } from '../lib/mock';
import type { TenantSettings, TtsProvider, NotificationChannel } from '../types/api';

const TTS_PROVIDERS: Array<{ id: TtsProvider; label: string; description: string }> = [
  { id: 'elevenlabs', label: 'ElevenLabs', description: 'Most natural voice — cloud API, ~300ms' },
  { id: 'openai-tts', label: 'OpenAI TTS', description: 'High quality — cloud API, ~400ms' },
  { id: 'piper',      label: 'Piper (Local)', description: 'Free, offline, fully private — ~200ms' },
];

const NOTIFICATION_TYPES: Array<{ type: NotificationChannel['type']; label: string; description: string }> = [
  { type: 'slack',  label: 'Slack',          description: 'Send escalations and alerts to a Slack channel' },
  { type: 'voice',  label: 'Voice Announce', description: 'Announce on nearest Voice PE device' },
  { type: 'push',   label: 'Push (Mobile)',  description: 'Push notifications to mobile app' },
  { type: 'email',  label: 'Email',          description: 'Email alerts for critical incidents' },
];

function ToggleSwitch({
  checked,
  onChange,
  id,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
  label: string;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 cursor-pointer select-none">
      <span className="sr-only">{label}</span>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
          checked ? 'bg-accent' : 'bg-surface-4'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
          aria-hidden
        />
      </button>
    </label>
  );
}

export function Settings() {
  const { data: settings, isLoading, refresh } = useApi(
    settingsApi.getSettings,
    { fallback: mockSettings },
  );

  const [form, setForm] = useState<Partial<TenantSettings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorMessage, setTwoFactorMessage] = useState<string | null>(null);
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);

  // Sync form with loaded settings
  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  useEffect(() => {
    const token = localStorage.getItem('boss_token');
    if (!token) return;
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => setTwoFactorEnabled(Boolean(user?.twoFactorEnabled)))
      .catch(() => undefined);
  }, []);

  function updateField<K extends keyof TenantSettings>(key: K, value: TenantSettings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function toggleNotification(type: NotificationChannel['type']) {
    const channels = (form.notificationChannels ?? settings?.notificationChannels ?? []).map(
      (ch) => ch.type === type ? { ...ch, enabled: !ch.enabled } : ch,
    );
    // If type not present, add it
    if (!channels.find((ch) => ch.type === type)) {
      channels.push({ type, enabled: true });
    }
    setForm((prev) => ({ ...prev, notificationChannels: channels }));
    setSaved(false);
  }

  function isNotificationEnabled(type: NotificationChannel['type']): boolean {
    return (form.notificationChannels ?? []).find((ch) => ch.type === type)?.enabled ?? false;
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await settingsApi.updateSettings(form);
      setSaved(true);
      refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function startTwoFactorSetup() {
    setTwoFactorError(null);
    setTwoFactorMessage(null);
    const token = localStorage.getItem('boss_token');
    const res = await fetch('/api/auth/2fa/setup', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setTwoFactorError(data?.error || 'Unable to start two-factor setup.');
      return;
    }
    setTwoFactorSetup(data);
  }

  async function enableTwoFactor() {
    setTwoFactorError(null);
    setTwoFactorMessage(null);
    const token = localStorage.getItem('boss_token');
    const res = await fetch('/api/auth/2fa/enable', {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: twoFactorCode }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setTwoFactorError(data?.error || 'Invalid Authenticator code.');
      return;
    }
    setTwoFactorEnabled(true);
    setTwoFactorSetup(null);
    setTwoFactorCode('');
    setTwoFactorMessage('Google Authenticator is enabled for this login.');
  }

  const merged = { ...settings, ...form } as TenantSettings;

  return (
    <div className="space-y-6 animate-fade-in">
      {isLoading && !settings ? (
        <PageLoader />
      ) : (
        <>
          {/* Tenant Identity */}
          <Card>
            <Card.Header
              title="Tenant Identity"
              subtitle="Deployment name and locale"
            />
            <Card.Body className="space-y-4">
              <div>
                <label htmlFor="tenant-name" className="block text-xs font-medium text-text-secondary mb-1.5">
                  Deployment Name
                </label>
                <input
                  id="tenant-name"
                  className="input max-w-sm"
                  value={merged.name ?? ''}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="e.g. Kevin Starr — Starr & Partners"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="timezone" className="block text-xs font-medium text-text-secondary mb-1.5">
                    <Clock className="w-3 h-3 inline mr-1" aria-hidden />
                    Timezone
                  </label>
                  <input
                    id="timezone"
                    className="input"
                    value={merged.timezone ?? ''}
                    onChange={(e) => updateField('timezone', e.target.value)}
                    placeholder="e.g. America/New_York"
                  />
                </div>
                <div>
                  <label htmlFor="locale" className="block text-xs font-medium text-text-secondary mb-1.5">
                    <Globe className="w-3 h-3 inline mr-1" aria-hidden />
                    Locale
                  </label>
                  <input
                    id="locale"
                    className="input"
                    value={merged.locale ?? ''}
                    onChange={(e) => updateField('locale', e.target.value)}
                    placeholder="e.g. en-US"
                  />
                </div>
              </div>
            </Card.Body>
          </Card>

          <Card>
            <Card.Header
              title="Login Security"
              subtitle="Google Authenticator two-factor login"
            />
            <Card.Body className="space-y-4">
              {twoFactorMessage && (
                <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                  {twoFactorMessage}
                </div>
              )}
              {twoFactorError && (
                <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {twoFactorError}
                </div>
              )}
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {twoFactorEnabled ? 'Authenticator enabled' : 'Authenticator not enabled'}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Returning logins use password plus a 6-digit Google Authenticator code when enabled.
                  </p>
                </div>
                {!twoFactorEnabled && (
                  <button type="button" className="btn-primary gap-2" onClick={startTwoFactorSetup}>
                    <KeyRound className="w-4 h-4" aria-hidden />
                    Set Up 2FA
                  </button>
                )}
              </div>
              {twoFactorSetup && (
                <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4 rounded-lg border border-border bg-surface-3 p-4">
                  <div className="bg-white rounded p-3 w-fit">
                    <QRCodeSVG value={twoFactorSetup.otpauthUrl} size={156} />
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Scan with Google Authenticator</p>
                      <p className="text-xs text-text-muted mt-1">
                        Manual key: <span className="font-mono text-text-secondary">{twoFactorSetup.secret}</span>
                      </p>
                    </div>
                    <div className="flex gap-3 flex-wrap">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={twoFactorCode}
                        onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="123456"
                        className="input max-w-[150px] tracking-[0.25em] text-center font-mono"
                        autoComplete="one-time-code"
                      />
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={enableTwoFactor}
                        disabled={twoFactorCode.length !== 6}
                      >
                        Verify and Enable
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Card.Body>
          </Card>

          {/* Voice Settings */}
          <Card>
            <Card.Header
              title="Voice Settings"
              subtitle="Wake word and TTS voice configuration"
            />
            <Card.Body className="space-y-5">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm font-medium text-text-primary">Voice Enabled</p>
                  <p className="text-xs text-text-muted mt-0.5">Enable voice pipeline and Voice PE device support</p>
                </div>
                <ToggleSwitch
                  id="voice-enabled"
                  checked={merged.voiceEnabled ?? false}
                  onChange={(v) => updateField('voiceEnabled', v)}
                  label="Voice enabled toggle"
                />
              </div>

              <div>
                <label htmlFor="wake-word" className="block text-xs font-medium text-text-secondary mb-1.5">
                  <Mic className="w-3 h-3 inline mr-1" aria-hidden />
                  Wake Word
                </label>
                <input
                  id="wake-word"
                  className="input max-w-xs"
                  value={merged.wakeWord ?? ''}
                  onChange={(e) => updateField('wakeWord', e.target.value)}
                  placeholder="e.g. Hey BOS"
                />
                <p className="text-xs text-text-muted mt-1">
                  Changing requires re-flashing ESPHome firmware on all Voice PE devices.
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">
                  <Volume2 className="w-3 h-3 inline mr-1" aria-hidden />
                  TTS Provider
                </p>
                <div className="space-y-2">
                  {TTS_PROVIDERS.map((provider) => (
                    <label
                      key={provider.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        merged.ttsProvider === provider.id
                          ? 'border-accent/50 bg-accent/5'
                          : 'border-border hover:border-border-strong bg-surface-3'
                      }`}
                    >
                      <input
                        type="radio"
                        name="tts-provider"
                        value={provider.id}
                        checked={merged.ttsProvider === provider.id}
                        onChange={() => updateField('ttsProvider', provider.id)}
                        className="accent-accent"
                        aria-label={provider.label}
                      />
                      <div>
                        <p className="text-sm font-medium text-text-primary">{provider.label}</p>
                        <p className="text-xs text-text-muted">{provider.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {(merged.ttsProvider === 'elevenlabs' || merged.ttsProvider === 'openai-tts') && (
                <div>
                  <label htmlFor="tts-voice-id" className="block text-xs font-medium text-text-secondary mb-1.5">
                    Voice ID
                  </label>
                  <input
                    id="tts-voice-id"
                    className="input max-w-xs"
                    value={merged.ttsVoiceId ?? ''}
                    onChange={(e) => updateField('ttsVoiceId', e.target.value)}
                    placeholder={merged.ttsProvider === 'elevenlabs' ? 'e.g. rachel' : 'e.g. alloy'}
                  />
                </div>
              )}
            </Card.Body>
          </Card>

          {/* Backup Settings */}
          <Card>
            <Card.Header title="Backup Schedule" subtitle="Interval and retention configuration" />
            <Card.Body>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="backup-interval" className="block text-xs font-medium text-text-secondary mb-1.5">
                    Interval (minutes)
                  </label>
                  <input
                    id="backup-interval"
                    type="number"
                    className="input"
                    min={30}
                    max={1440}
                    value={merged.backupIntervalMinutes ?? 60}
                    onChange={(e) => updateField('backupIntervalMinutes', parseInt(e.target.value, 10))}
                  />
                  <p className="text-xs text-text-muted mt-1">Minimum 30 minutes</p>
                </div>
                <div>
                  <label htmlFor="backup-retention" className="block text-xs font-medium text-text-secondary mb-1.5">
                    Retention (days)
                  </label>
                  <input
                    id="backup-retention"
                    type="number"
                    className="input"
                    min={7}
                    max={90}
                    value={merged.backupRetentionDays ?? 30}
                    onChange={(e) => updateField('backupRetentionDays', parseInt(e.target.value, 10))}
                  />
                  <p className="text-xs text-text-muted mt-1">7–90 days. Older backups auto-deleted.</p>
                </div>
              </div>
            </Card.Body>
          </Card>

          {/* System toggles */}
          <Card>
            <Card.Header title="System Modules" subtitle="Enable or disable core BOS modules" />
            <Card.Body className="space-y-4">
              {[
                { key: 'healingEnabled' as const, label: 'Self-Healing Engine', desc: 'Monitor, diagnose, and auto-resolve incidents' },
                { key: 'learningEnabled' as const, label: 'Learning Engine', desc: 'Passive behavioral observation and preference capture' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm font-medium text-text-primary">{label}</p>
                    <p className="text-xs text-text-muted mt-0.5">{desc}</p>
                  </div>
                  <ToggleSwitch
                    id={`toggle-${key}`}
                    checked={merged[key] ?? false}
                    onChange={(v) => updateField(key, v)}
                    label={`${label} toggle`}
                  />
                </div>
              ))}
            </Card.Body>
          </Card>

          {/* Notifications */}
          <Card>
            <Card.Header
              title="Notification Channels"
              subtitle="Where BOS sends escalations and critical alerts"
            />
            <Card.Body className="space-y-3">
              {NOTIFICATION_TYPES.map(({ type, label, description }) => {
                const enabled = isNotificationEnabled(type);
                return (
                  <div key={type} className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-2.5">
                      {enabled ? (
                        <Bell className="w-4 h-4 text-accent flex-shrink-0" aria-hidden />
                      ) : (
                        <BellOff className="w-4 h-4 text-text-muted flex-shrink-0" aria-hidden />
                      )}
                      <div>
                        <p className="text-sm font-medium text-text-primary">{label}</p>
                        <p className="text-xs text-text-muted">{description}</p>
                      </div>
                    </div>
                    <ToggleSwitch
                      id={`notif-${type}`}
                      checked={enabled}
                      onChange={() => toggleNotification(type)}
                      label={`${label} notifications`}
                    />
                  </div>
                );
              })}
            </Card.Body>
          </Card>

          {/* Save bar */}
          <div className="sticky bottom-4 flex justify-center">
            <div className="card bg-surface-2/90 backdrop-blur-sm px-4 py-3 flex items-center justify-center gap-4 shadow-xl">
              {saveError && (
                <p className="text-xs text-danger">{saveError}</p>
              )}
              {saved && (
                <div className="flex items-center gap-1.5 text-xs text-success animate-fade-in">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                  Saved
                </div>
              )}
              <button
                className="btn-ghost text-xs gap-1.5"
                onClick={refresh}
                disabled={saving}
                aria-label="Discard changes and reload settings"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden />
                Discard
              </button>
              <button
                className="btn-primary gap-2"
                onClick={handleSave}
                disabled={saving}
                aria-label="Save settings"
              >
                <Save className="w-4 h-4" aria-hidden />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

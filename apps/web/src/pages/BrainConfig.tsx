/**
 * Brain Config — view current brain, capabilities, switch brain.
 */

import React, { useState } from 'react';
import {
  Brain,
  Check,
  AlertCircle,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { PageLoader } from '../components/LoadingSpinner';
import { useApi } from '../hooks/useApi';
import { brainApi } from '../lib/api';
import { mockBrainConfig } from '../lib/mock';
import { formatRelativeTime } from '../lib/utils';
import type { BrainProvider, BrainCapabilities } from '../types/api';

const PROVIDERS: Array<{
  id: BrainProvider;
  label: string;
  description: string;
  badge?: string;
}> = [
  { id: 'claude-code', label: 'Claude Code', description: 'Anthropic Claude via API — full MCP, code execution, agent spawning.', badge: 'Recommended' },
  { id: 'openai',      label: 'OpenAI / Codex', description: 'GPT-4o or Codex — strong tool calling, broad capability.' },
  { id: 'openrouter',  label: 'OpenRouter', description: 'OpenAI-compatible model routing, defaulting to the free Google Gemma 4 model when configured.' },
  { id: 'gemini',      label: 'Gemini Pro', description: 'Google Gemini — multimodal, large context window.' },
  { id: 'openclaw',    label: 'OpenClaw', description: 'OpenClaw via HTTP endpoint — BOS-native orchestration.' },
  { id: 'custom',      label: 'Custom Agent', description: 'Any OpenAPI-spec endpoint. Provide your own orchestration.' },
];

const CAPABILITY_LABELS: Array<{ key: keyof BrainCapabilities; label: string; description: string }> = [
  { key: 'canChat',           label: 'Chat',            description: 'Basic prompt → response' },
  { key: 'canStream',         label: 'Streaming',       description: 'Streaming responses' },
  { key: 'canUseTools',       label: 'Tool Calling',    description: 'Function / tool calling' },
  { key: 'canAccessMCP',      label: 'MCP Access',      description: 'Native MCP connections' },
  { key: 'canExecuteCode',    label: 'Code Execution',  description: 'Run code autonomously' },
  { key: 'canSpawnAgents',    label: 'Agent Spawning',  description: 'Multi-agent orchestration' },
  { key: 'canMaintainMemory', label: 'Memory',          description: 'Persistent context across sessions' },
  { key: 'canProcessVoice',   label: 'Voice',           description: 'Audio input / output' },
  { key: 'canProcessImages',  label: 'Vision',          description: 'Image analysis' },
  { key: 'canProcessDocuments', label: 'Documents',     description: 'PDF / spreadsheet analysis' },
];

export function BrainConfig() {
  const { data: config, isLoading, refresh } = useApi(
    brainApi.getConfig,
    { fallback: mockBrainConfig },
  );

  const [switching, setSwitching] = useState(false);
  const [selected, setSelected] = useState<BrainProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSwitch() {
    if (!selected || selected === config?.provider) {
      setSwitching(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await brainApi.switchBrain(selected);
      refresh();
      setSwitching(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to switch brain');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {isLoading && !config ? (
        <PageLoader />
      ) : config ? (
        <>
          {/* Current brain */}
          <Card>
            <Card.Header
              title="Active Brain"
              subtitle="The AI engine powering all BOS reasoning and actions"
              action={
                <button
                  className="btn-ghost text-xs gap-1.5"
                  onClick={refresh}
                  aria-label="Refresh brain config"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden />
                  Refresh
                </button>
              }
            />
            <Card.Body>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-accent/10">
                    <Brain className="w-6 h-6 text-accent" aria-hidden />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-text-primary">
                      {PROVIDERS.find((p) => p.id === config.provider)?.label ?? config.provider}
                    </p>
                    {config.model && (
                      <p className="text-sm text-text-muted font-mono mt-0.5">{config.model}</p>
                    )}
                    {config.lastUsed && (
                      <p className="text-xs text-text-muted mt-1">
                        Last used {formatRelativeTime(config.lastUsed)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <StatusBadge status={config.status} />
                  {config.fallbackProvider && (
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <span>Fallback:</span>
                      <span className="font-medium text-text-secondary">
                        {PROVIDERS.find((p) => p.id === config.fallbackProvider)?.label ?? config.fallbackProvider}
                      </span>
                    </div>
                  )}
                  <button
                    className="btn-secondary text-xs"
                    onClick={() => {
                      setSelected(config.provider);
                      setSwitching(true);
                    }}
                    aria-label="Switch to a different brain"
                  >
                    Switch Brain
                    <ChevronRight className="w-3.5 h-3.5" aria-hidden />
                  </button>
                </div>
              </div>
            </Card.Body>
          </Card>

          {/* Capabilities grid */}
          <Card>
            <Card.Header
              title="Capabilities"
              subtitle="What the active brain can do"
            />
            <Card.Body>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {CAPABILITY_LABELS.map(({ key, label, description }) => {
                  const enabled = config.capabilities[key];
                  return (
                    <div
                      key={key}
                      className={`flex items-center gap-3 p-3 rounded-lg border ${
                        enabled ? 'border-success/20 bg-success/5' : 'border-border bg-surface-3'
                      }`}
                    >
                      <span
                        className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                          enabled ? 'bg-success/20' : 'bg-surface-4'
                        }`}
                        aria-hidden
                      >
                        {enabled ? (
                          <Check className="w-3 h-3 text-success" />
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${enabled ? 'text-text-primary' : 'text-text-muted'}`}>
                          {label}
                        </p>
                        <p className="text-xs text-text-muted truncate">{description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card.Body>
          </Card>

          {/* Brain switch panel */}
          {switching && (
            <Card>
              <Card.Header
                title="Switch Brain"
                subtitle="Select a new AI brain. Active sessions will migrate on next request."
              />
              <Card.Body className="space-y-3">
                {saveError && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 border border-danger/30 text-xs text-danger">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden />
                    {saveError}
                  </div>
                )}
                {PROVIDERS.map((provider) => (
                  <label
                    key={provider.id}
                    className={`flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-colors ${
                      selected === provider.id
                        ? 'border-accent/50 bg-accent/5'
                        : 'border-border hover:border-border-strong bg-surface-3'
                    }`}
                  >
                    <input
                      type="radio"
                      name="brain"
                      value={provider.id}
                      checked={selected === provider.id}
                      onChange={() => setSelected(provider.id)}
                      className="mt-0.5 accent-accent"
                      aria-label={provider.label}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-text-primary">{provider.label}</p>
                        {provider.badge && (
                          <span className="text-xs bg-accent/15 text-accent px-1.5 py-0.5 rounded font-medium">
                            {provider.badge}
                          </span>
                        )}
                        {provider.id === config.provider && (
                          <span className="text-xs text-text-muted">(current)</span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">{provider.description}</p>
                    </div>
                  </label>
                ))}

                <div className="flex gap-3 pt-2">
                  <button
                    className="btn-secondary flex-1 justify-center"
                    onClick={() => setSwitching(false)}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-primary flex-1 justify-center"
                    onClick={handleSwitch}
                    disabled={saving || !selected || selected === config.provider}
                    aria-label="Confirm brain switch"
                  >
                    {saving ? 'Switching...' : 'Confirm Switch'}
                  </button>
                </div>
              </Card.Body>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

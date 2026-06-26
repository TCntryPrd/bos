/**
 * Learning — onboarding progress, preferences, behavior patterns, delete controls.
 */

import React, { useState } from 'react';
import {
  BookOpen,
  RefreshCw,
  Trash2,
  TrendingUp,
  CheckCircle2,
  Loader2,
  XCircle,
  Clock,
  BarChart2,
} from 'lucide-react';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { PageLoader } from '../components/LoadingSpinner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useApi } from '../hooks/useApi';
import { learningApi } from '../lib/api';
import {
} from '../lib/mock';
import { formatRelativeTime, confidenceToPercent, capitalize } from '../lib/utils';
import type { LearnedPreference, BehaviorPattern, OnboardingProgress } from '../types/api';

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  complete: CheckCircle2,
  running:  Loader2,
  error:    XCircle,
  pending:  Clock,
};

const SOURCE_STYLES: Record<string, string> = {
  explicit:   'bg-accent/10 text-accent',
  behavioral: 'bg-info/10 text-info',
  onboarding: 'bg-success/10 text-success',
};

function OnboardingRow({ item }: { item: OnboardingProgress }) {
  const Icon = STATUS_ICONS[item.status] ?? Clock;
  return (
    <div className="py-3 border-b border-border/40 last:border-0">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2">
          <Icon
            className={`w-4 h-4 flex-shrink-0 ${
              item.status === 'complete' ? 'text-success' :
              item.status === 'running'  ? 'text-warning animate-spin' :
              item.status === 'error'    ? 'text-danger' :
              'text-text-muted'
            }`}
            aria-hidden
          />
          <span className="text-sm text-text-primary">{item.label}</span>
        </div>
        <StatusBadge status={item.status} size="sm" />
      </div>
      {/* Progress bar */}
      <div className="ml-6">
        <div
          className="w-full h-1 rounded-full bg-surface-3 overflow-hidden"
          role="progressbar"
          aria-valuenow={item.percentComplete}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${item.label} progress: ${item.percentComplete}%`}
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              item.status === 'complete' ? 'bg-success' :
              item.status === 'running'  ? 'bg-warning' :
              item.status === 'error'    ? 'bg-danger' :
              'bg-surface-4'
            }`}
            style={{ width: `${item.percentComplete}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-text-muted">
            {item.itemsProcessed !== undefined && item.totalItems !== undefined
              ? `${item.itemsProcessed.toLocaleString()} / ${item.totalItems.toLocaleString()} items`
              : item.status === 'pending' ? 'Queued'
              : ''}
          </span>
          <span className="text-xs text-text-muted">{item.percentComplete}%</span>
        </div>
      </div>
    </div>
  );
}

function PreferenceRow({
  pref,
  onDelete,
}: {
  pref: LearnedPreference;
  onDelete: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div className="flex items-start justify-between gap-3 py-3 border-b border-border/40 last:border-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-semibold text-text-primary">
              {pref.key.split('_').map(capitalize).join(' ')}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${SOURCE_STYLES[pref.source] ?? ''}`}>
              {pref.source}
            </span>
            <span className="text-xs text-text-muted">{pref.category}</span>
          </div>
          <p className="text-sm text-text-secondary">{pref.value}</p>
          <p className="text-xs text-text-muted mt-1">
            Confidence: <span className="font-medium text-text-secondary">{confidenceToPercent(pref.confidence)}</span>
            {' · '} Updated {formatRelativeTime(pref.updatedAt)}
          </p>
        </div>
        <button
          className="btn-ghost p-1.5 text-text-muted hover:text-danger flex-shrink-0"
          onClick={() => setConfirmOpen(true)}
          aria-label={`Delete preference: ${pref.key}`}
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this preference?"
        description="BOS will no longer apply this rule. If it was learned behaviorally, it may be re-learned over time."
        confirmLabel="Delete"
        onConfirm={() => { setConfirmOpen(false); onDelete(pref.id); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

function PatternRow({
  pattern,
  onDelete,
}: {
  pattern: BehaviorPattern;
  onDelete: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div className="flex items-start justify-between gap-3 py-3 border-b border-border/40 last:border-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-semibold text-text-primary">{pattern.description}</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-text-muted">
              <span className="font-medium text-text-secondary">{pattern.observationCount}</span> observations
            </span>
            <span className="text-xs text-text-muted">
              Confidence: <span className="font-medium text-text-secondary">{confidenceToPercent(pattern.confidence)}</span>
            </span>
            <span className="text-xs text-text-muted">{pattern.category}</span>
            <span className="text-xs text-text-muted">
              Last seen {formatRelativeTime(pattern.lastObserved)}
            </span>
          </div>
          {/* Confidence bar */}
          <div className="mt-2 w-32 h-1 rounded-full bg-surface-3 overflow-hidden" aria-hidden>
            <div
              className="h-full bg-accent rounded-full"
              style={{ width: `${Math.round(pattern.confidence * 100)}%` }}
            />
          </div>
        </div>
        <button
          className="btn-ghost p-1.5 text-text-muted hover:text-danger flex-shrink-0"
          onClick={() => setConfirmOpen(true)}
          aria-label={`Delete pattern: ${pattern.description}`}
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this pattern?"
        description="This behavioral pattern will be removed. BOS may re-learn it through future observations."
        confirmLabel="Delete"
        onConfirm={() => { setConfirmOpen(false); onDelete(pattern.id); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export function Learning() {
  const {
    data: onboarding,
    isLoading: loadingOnboarding,
    refresh: refreshOnboarding,
  } = useApi(learningApi.getOnboardingProgress, { fallback: [] });

  const {
    data: preferences,
    isLoading: loadingPrefs,
    refresh: refreshPrefs,
  } = useApi(learningApi.getPreferences, { fallback: [] });

  const {
    data: patterns,
    isLoading: loadingPatterns,
    refresh: refreshPatterns,
  } = useApi(learningApi.getBehaviorPatterns, { fallback: [] });

  async function handleDeletePref(id: string) {
    try {
      await learningApi.deletePreference(id);
      refreshPrefs();
    } catch { /* handle gracefully */ }
  }

  async function handleDeletePattern(id: string) {
    try {
      await learningApi.deletePattern(id);
      refreshPatterns();
    } catch { /* handle gracefully */ }
  }

  const overallProgress = onboarding
    ? Math.round(
        onboarding.reduce((sum, p) => sum + p.percentComplete, 0) / onboarding.length,
      )
    : 0;

  const activeIngests = onboarding?.filter((p) => p.status === 'running').length ?? 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Onboarding deep dive */}
      <Card>
        <Card.Header
          title="Onboarding Deep Dive"
          subtitle="Historical ingest from all connected accounts"
          action={
            <div className="flex items-center gap-3">
              {activeIngests > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-warning">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                  {activeIngests} running
                </span>
              )}
              <button
                className="btn-ghost text-xs gap-1.5"
                onClick={refreshOnboarding}
                aria-label="Refresh onboarding progress"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden />
                Refresh
              </button>
            </div>
          }
        />
        <Card.Body>
          {/* Overall progress */}
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-text-secondary">Overall Progress</span>
              <span className="text-sm font-semibold text-text-primary">{overallProgress}%</span>
            </div>
            <div
              className="w-full h-2 rounded-full bg-surface-3 overflow-hidden"
              role="progressbar"
              aria-valuenow={overallProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Overall onboarding: ${overallProgress}%`}
            >
              <div
                className="h-full rounded-full bg-accent transition-all duration-700"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>

          {loadingOnboarding && !onboarding ? (
            <PageLoader />
          ) : onboarding ? (
            <div>
              {onboarding.map((item) => (
                <OnboardingRow key={item.platform} item={item} />
              ))}
            </div>
          ) : (
            <EmptyState title="No onboarding data" />
          )}
        </Card.Body>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Preferences */}
        <Card>
          <Card.Header
            title="Learned Preferences"
            subtitle="Explicit rules and high-confidence behavioral preferences"
            action={
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted">
                  {preferences?.length ?? 0} rules
                </span>
              </div>
            }
          />
          <Card.Body className="py-0 px-5">
            {loadingPrefs && !preferences ? (
              <PageLoader />
            ) : preferences && preferences.length > 0 ? (
              preferences.map((pref) => (
                <PreferenceRow key={pref.id} pref={pref} onDelete={handleDeletePref} />
              ))
            ) : (
              <EmptyState
                icon={<BookOpen className="w-8 h-8" />}
                title="No preferences learned yet"
                description="As you interact with BOS and make corrections, preferences will be captured here."
              />
            )}
          </Card.Body>
        </Card>

        {/* Behavior patterns */}
        <Card>
          <Card.Header
            title="Behavior Patterns"
            subtitle="Patterns observed passively from your activity"
            action={
              <span className="text-xs text-text-muted">
                {patterns?.length ?? 0} patterns
              </span>
            }
          />
          <Card.Body className="py-0 px-5">
            {loadingPatterns && !patterns ? (
              <PageLoader />
            ) : patterns && patterns.length > 0 ? (
              patterns.map((pattern) => (
                <PatternRow key={pattern.id} pattern={pattern} onDelete={handleDeletePattern} />
              ))
            ) : (
              <EmptyState
                icon={<BarChart2 className="w-8 h-8" />}
                title="No patterns detected yet"
                description="Patterns emerge after several weeks of BOS observing your workflow."
              />
            )}
          </Card.Body>
        </Card>
      </div>

      {/* Privacy notice */}
      <Card>
        <Card.Body>
          <div className="flex items-start gap-3">
            <TrendingUp className="w-4 h-4 text-text-muted mt-0.5 flex-shrink-0" aria-hidden />
            <div>
              <p className="text-sm font-medium text-text-secondary">Privacy & Data Control</p>
              <p className="text-xs text-text-muted mt-1">
                All learning data stays in your local Postgres database and Weaviate instance.
                Nothing is sent to the AI brain provider beyond the prompt text.
                You can delete any preference or pattern above at any time.
                Deleted explicit preferences stay deleted. Behavioral patterns may re-emerge from future observations.
              </p>
            </div>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}

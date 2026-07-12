/**
 * Onboarding — multi-step setup wizard for white-label BOS installations.
 *
 * Steps:
 *   0. Welcome
 *   1. Create Operator Login + optional admin seats
 *   2. Business Platform (Google Workspace / Microsoft 365)
 *   3. Brain & Integrations
 *   4. Ready — finalize & launch dashboard
 *
 * State is persisted to localStorage throughout so that OAuth redirects and
 * page reloads do not lose progress. All backend writes happen at step 4.
 *
 * Usage:
 *   <Route path="/onboarding" element={<Onboarding />} />
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Zap,
  ExternalLink,
  UserPlus,
  Mail,
  Database,
  MessageSquare,
  Table2,
  Layout,
  HardDrive,
  CreditCard,
  Kanban,
  ListTodo,
  Users,
  Bug,
  Eye,
  EyeOff,
  Loader2,
  Bot,
  Copy,
} from 'lucide-react';
import { cn } from '../lib/utils';
import entranceElevatorScene from '../assets/entrance-elevator-scene.png';

// ─── Constants ────────────────────────────────────────────────────────────────

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-lg bg-surface-3 border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent';

const TOTAL_STEPS = 4; // 0-indexed steps: Welcome(0), Account(1), Platform(2), Brain(3), Ready shown as step 4

const ONBOARDING_SESSION_KEY = 'boss_onboarding_state';

type BrainProvider = 'claude-code' | 'openai' | 'gemini' | 'openclaw' | 'custom';
type OAuthProvider = 'google' | 'microsoft';
type InviteRole = 'user' | 'admin';

interface PendingInvite {
  email: string;
  role: InviteRole;
}

// ─── Session shape ────────────────────────────────────────────────────────────

interface OnboardingSession {
  step: number;
  account?: {
    displayName: string;
    email: string;
    password: string;
  };
  invites?: PendingInvite[];
  platform?: {
    provider: OAuthProvider;
    clientId: string;
    clientSecret: string;
    connected: boolean;
  };
  brain?: {
    provider: BrainProvider;
    credentials: Record<string, string>;
  };
  // JWT is only present after step-4 registration; not stored during onboarding
  token?: string;
}

function readSession(): OnboardingSession {
  try {
    const raw = localStorage.getItem(ONBOARDING_SESSION_KEY);
    return raw ? (JSON.parse(raw) as OnboardingSession) : { step: 0 };
  } catch {
    return { step: 0 };
  }
}

function saveSession(updates: Partial<OnboardingSession>): OnboardingSession {
  const current = readSession();
  const next = { ...current, ...updates };
  localStorage.setItem(ONBOARDING_SESSION_KEY, JSON.stringify(next));
  return next;
}

function clearSession() {
  localStorage.removeItem(ONBOARDING_SESSION_KEY);
}

// ─── BrainOption / Integration types ─────────────────────────────────────────

interface BrainOption {
  id: BrainProvider;
  label: string;
  description: string;
  badge?: string;
}

const BRAIN_OPTIONS: BrainOption[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Full orchestration with MCP connections',
    badge: 'Recommended',
  },
  {
    id: 'openai',
    label: 'OpenAI / GPT-4o',
    description: 'Tool calling and code execution',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: "Google's multimodal AI",
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    description: 'Self-hosted LLM proxy',
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Any OpenAPI-compatible endpoint',
  },
];

interface Integration {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  scope: 'business' | 'personal';
}

const INTEGRATIONS: Integration[] = [
  { id: 'notion', label: 'Notion', description: 'Notes, wikis, and databases', icon: Database, scope: 'business' },
  { id: 'slack', label: 'Slack', description: 'Team messaging', icon: MessageSquare, scope: 'business' },
  { id: 'airtable', label: 'Airtable', description: 'Spreadsheet databases', icon: Table2, scope: 'business' },
  { id: 'miro', label: 'Miro', description: 'Visual collaboration', icon: Layout, scope: 'business' },
  { id: 'dropbox', label: 'Dropbox', description: 'Cloud file storage', icon: HardDrive, scope: 'business' },
  { id: 'stripe', label: 'Stripe', description: 'Payment processing', icon: CreditCard, scope: 'business' },
  { id: 'trello', label: 'Trello', description: 'Project boards', icon: Kanban, scope: 'business' },
  { id: 'asana', label: 'Asana', description: 'Task management', icon: ListTodo, scope: 'business' },
  { id: 'hubspot', label: 'HubSpot', description: 'CRM and marketing', icon: Users, scope: 'business' },
  { id: 'jira', label: 'Jira', description: 'Issue tracking', icon: Bug, scope: 'business' },
  { id: 'gmail-personal', label: 'Personal Gmail', description: 'Personal inbox and contacts', icon: Mail, scope: 'personal' },
  { id: 'personal-calendar', label: 'Personal Calendar', description: 'Appointments and reminders', icon: ListTodo, scope: 'personal' },
  { id: 'personal-drive', label: 'Personal Drive', description: 'Household files and records', icon: HardDrive, scope: 'personal' },
];

// ─── StepIndicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: number }) {
  const labels = ['Welcome', 'Account', 'Platform', 'Brain'];

  return (
    <div
      className="flex items-center justify-center gap-1.5"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={0}
      aria-valuemax={TOTAL_STEPS - 1}
      aria-label={`Step ${current + 1} of ${TOTAL_STEPS}`}
    >
      {labels.map((label, i) => {
        const isComplete = i < current;
        const isCurrent = i === current;
        return (
          <React.Fragment key={i}>
            <div
              className={cn(
                'rounded-full transition-all duration-300 flex items-center justify-center',
                isComplete
                  ? 'w-6 h-6 bg-accent'
                  : isCurrent
                  ? 'w-6 h-6 bg-accent/20 border-2 border-accent'
                  : 'w-2 h-2 bg-surface-4',
              )}
              aria-label={
                isComplete
                  ? `${label} — complete`
                  : isCurrent
                  ? `${label} — current`
                  : label
              }
            >
              {isComplete && <Check className="w-3 h-3 text-white" aria-hidden />}
              {isCurrent && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent block" aria-hidden />
              )}
            </div>
            {i < labels.length - 1 && (
              <div
                className={cn(
                  'h-px w-8 transition-colors duration-300',
                  i < current ? 'bg-accent' : 'bg-surface-4',
                )}
                aria-hidden
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Setup Guide ─────────────────────────────────────────────────────────────

interface GuideAction {
  label: string;
  href?: string;
  copy?: string;
}

interface GuideState {
  title: string;
  message: string;
  checklist: string[];
  actions?: GuideAction[];
  note?: string;
}

function getOnboardingGuide(step: number, session: OnboardingSession): GuideState {
  const origin = window.location.origin;
  const provider = session.platform?.provider ?? 'google';
  const redirectUri = `${origin}/api/connectors/oauth/${provider}/callback`;

  if (step === 0) {
    return {
      title: 'I will walk you through it',
      message: 'Start here. I will keep the next click, paste target, and handoff visible while you set up the tenant operator login, business command center, and optional personal assistant layer.',
      checklist: [
        'Click Begin Setup.',
        'Keep this browser tab open through the whole run.',
        'Use the passkey link from your email if the page asks for it.',
        'Start with the business command center; personal assistant connectors can be added now or after login.',
      ],
    };
  }

  if (step === 1) {
    return {
      title: 'Create the operator login',
      message: 'First we create the one owner/operator login for this tenant. It controls the business dashboard and any personal assistant access you choose to connect.',
      checklist: [
        'Enter your display name.',
        'Use the email from the onboarding link.',
        'Create and confirm a password.',
        'Click Save & Continue, then add only the admin seats you want active now.',
      ],
      note: 'Each tenant runs from one operator login plus the approved admin accounts. Business, customer, Google, Slack, CRM, and personal assistant accounts are managed through Connectors after launch.',
    };
  }

  if (step === 2) {
    return {
      title: 'Connect Google Workspace',
      message: 'Now create a Google OAuth web app, paste this redirect URI into Google, then paste the client ID and secret back here.',
      checklist: [
        'Click Google Workspace on this page.',
        'Open Google Cloud Console and create OAuth credentials for a Web application.',
        'Copy the authorized redirect URI from this page into Google.',
        "Copy Google's client ID and client secret back into the fields here.",
        'Click Save & Connect, accept the Google permission screen, and return here.',
      ],
      actions: [
        { label: 'Open Google Console', href: 'https://console.cloud.google.com/apis/credentials' },
        { label: 'Copy Redirect URI', copy: redirectUri },
      ],
      note: 'For the remaining 100-200 managed Google accounts, finish this first run and repeat from Connectors after login.',
    };
  }

  if (step === 3) {
    return {
      title: 'Paste the AI key',
      message: 'Choose the AI provider you want to power the install, create or copy that provider key, then paste it into the credential field.',
      checklist: [
        'Select Claude Code, OpenAI / GPT-4o, or Gemini.',
        'Open the matching provider console and create or copy an API key.',
        'Paste the key here and click Save Brain Config.',
        'Skip the disabled tool cards for now; Slack is connected after launch from the dashboard/admin connector screens.',
      ],
      actions: [
        { label: 'Open Anthropic Console', href: 'https://console.anthropic.com/settings/keys' },
        { label: 'Open OpenAI Keys', href: 'https://platform.openai.com/api-keys' },
        { label: 'Open AI Studio', href: 'https://aistudio.google.com/app/apikey' },
      ],
      note: 'Slack OAuth is not part of this wizard yet; the app already has those areas, but they need the next wiring pass to become guided onboarding steps.',
    };
  }

  return {
    title: 'Launch and verify',
    message: 'This final click creates the tenant operator login, stores the brain config, and drops you into the command dashboard.',
    checklist: [
      'Review the summary.',
      'Click Launch Dashboard.',
      'Log in with the operator/admin login you just created if prompted.',
      'Next pass: guided Slack OAuth, repeat Google account linking, and personal assistant connector setup.',
    ],
  };
}

function OnboardingGuide({ step, session }: { step: number; session: OnboardingSession }) {
  const guide = getOnboardingGuide(step, session);

  async function handleCopy(value: string) {
    await navigator.clipboard.writeText(value);
  }

  return (
    <aside className="aios-panel p-5 lg:sticky lg:top-8">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10">
          <Bot className="h-5 w-5 text-accent" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Setup guide</p>
          <h2 className="mt-1 text-lg font-bold text-text-primary">{guide.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{guide.message}</p>
        </div>
      </div>

      <ol className="mt-5 space-y-3" aria-label="Current setup walkthrough">
        {guide.checklist.map((item, index) => (
          <li key={item} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-4 text-[11px] font-semibold text-text-primary">
              {index + 1}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ol>

      {guide.actions && guide.actions.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {guide.actions.map((action) => (
            action.href ? (
              <a
                key={action.label}
                href={action.href}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary gap-2 px-3 py-2 text-xs font-semibold"
              >
                {action.label}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : (
              <button
                key={action.label}
                type="button"
                className="btn-secondary gap-2 px-3 py-2 text-xs font-semibold"
                onClick={() => void handleCopy(action.copy ?? '')}
              >
                {action.label}
                <Copy className="h-3.5 w-3.5" aria-hidden />
              </button>
            )
          ))}
        </div>
      )}

      {guide.note && (
        <p className="mt-5 rounded-lg border border-border bg-surface-4 px-3 py-2 text-xs leading-relaxed text-text-muted">
          {guide.note}
        </p>
      )}
    </aside>
  );
}

// ─── InlineError ──────────────────────────────────────────────────────────────

function InlineError({ message, id }: { message: string; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-danger mt-1">
      {message}
    </p>
  );
}

function ApiError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-xs text-danger"
    >
      {message}
    </div>
  );
}

// ─── PasswordInput ────────────────────────────────────────────────────────────

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  hasError,
  autoComplete,
  autoFocus,
  'aria-describedby': ariaDescribedby,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hasError?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  'aria-describedby'?: string;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          INPUT_CLASS,
          'pr-10',
          hasError ? 'border-danger focus:ring-danger/50 focus:border-danger' : '',
        )}
        aria-describedby={ariaDescribedby}
        aria-invalid={hasError}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 px-3 flex items-center text-text-muted hover:text-text-secondary transition-colors"
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

// ─── Step 0: Welcome ──────────────────────────────────────────────────────────

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center py-10 space-y-6">
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-accent/10 mx-auto">
        <Zap className="w-10 h-10 text-accent" aria-hidden />
      </div>
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">
          Welcome to BOS
        </h1>
        <p className="text-base text-text-secondary max-w-sm mx-auto leading-relaxed">
          A command center for your business and a personal assistant layer for the work around it. Let&apos;s get you set up in 3 steps.
        </p>
      </div>
      <div className="pt-4">
        <button
          className="btn-primary gap-2 px-8 py-3 text-sm font-semibold"
          onClick={onNext}
          autoFocus
        >
          Begin Setup
          <ArrowRight className="w-4 h-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── Step 1: Account Setup ────────────────────────────────────────────────────
// Does NOT call the backend. Saves account info + invites to localStorage only.
// The actual registration happens at step 4 (StepReady).

function StepAccount({
  initialSession,
  onNext,
}: {
  initialSession: OnboardingSession;
  onNext: () => void;
}) {
  // Pre-populate from session if returning (e.g. after a reload)
  const [displayName, setDisplayName] = useState(initialSession.account?.displayName ?? '');
  const [email, setEmail] = useState(initialSession.account?.email ?? '');
  const [password, setPassword] = useState(initialSession.account?.password ?? '');
  const [confirmPassword, setConfirmPassword] = useState(initialSession.account?.password ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Invite state
  const [inviteEmail, setInviteEmail] = useState('');
  const inviteRole: InviteRole = 'admin';
  const [inviteError, setInviteError] = useState('');
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>(
    initialSession.invites ?? [],
  );

  // If the session already has account data consider the form already "saved"
  const [saved, setSaved] = useState(!!initialSession.account?.displayName);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!displayName.trim()) next.displayName = 'Display name is required.';
    if (!email.trim()) next.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Password is required.';
    else if (password.length < 8) next.password = 'Password must be at least 8 characters.';
    if (!confirmPassword) next.confirmPassword = 'Please confirm your password.';
    else if (password !== confirmPassword) next.confirmPassword = 'Passwords do not match.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    saveSession({
      account: {
        displayName: displayName.trim(),
        email: email.trim(),
        password,
      },
      invites: pendingInvites,
    });
    setSaved(true);
  }

  function handleAddInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError('');
    if (!inviteEmail.trim()) {
      setInviteError('Email is required to add an invite.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())) {
      setInviteError('Enter a valid email address.');
      return;
    }
    const updated = [...pendingInvites, { email: inviteEmail.trim(), role: inviteRole }];
    setPendingInvites(updated);
    saveSession({ invites: updated });
    setInviteEmail('');
  }

  function handleNext() {
    // Persist latest invite list before advancing
    saveSession({ invites: pendingInvites, step: 2 });
    onNext();
  }

  if (!saved) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold text-text-primary mb-1">Create Operator Login</h2>
          <p className="text-sm text-text-muted">
            This is the primary tenant login. Managed customer and service accounts are connected after launch.
          </p>
        </div>

        <form
          id="register-form"
          onSubmit={handleSave}
          noValidate
          className="space-y-4"
          aria-label="Account registration form"
        >
          <div className="space-y-1.5">
            <label htmlFor="reg-name" className="block text-xs font-medium text-text-secondary">
              Display Name
            </label>
            <input
              id="reg-name"
              type="text"
              autoComplete="name"
              autoFocus
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className={cn(
                INPUT_CLASS,
                fieldErrors.displayName ? 'border-danger focus:ring-danger/50 focus:border-danger' : '',
              )}
              aria-describedby={fieldErrors.displayName ? 'reg-name-error' : undefined}
              aria-invalid={!!fieldErrors.displayName}
            />
            <InlineError id="reg-name-error" message={fieldErrors.displayName ?? ''} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="reg-email" className="block text-xs font-medium text-text-secondary">
              Email
            </label>
            <input
              id="reg-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={cn(
                INPUT_CLASS,
                fieldErrors.email ? 'border-danger focus:ring-danger/50 focus:border-danger' : '',
              )}
              aria-describedby={fieldErrors.email ? 'reg-email-error' : undefined}
              aria-invalid={!!fieldErrors.email}
            />
            <InlineError id="reg-email-error" message={fieldErrors.email ?? ''} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="reg-password" className="block text-xs font-medium text-text-secondary">
              Password
            </label>
            <PasswordInput
              id="reg-password"
              value={password}
              onChange={setPassword}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
              hasError={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? 'reg-password-error' : undefined}
            />
            <InlineError id="reg-password-error" message={fieldErrors.password ?? ''} />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="reg-confirm"
              className="block text-xs font-medium text-text-secondary"
            >
              Confirm Password
            </label>
            <PasswordInput
              id="reg-confirm"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Repeat your password"
              autoComplete="new-password"
              hasError={!!fieldErrors.confirmPassword}
              aria-describedby={fieldErrors.confirmPassword ? 'reg-confirm-error' : undefined}
            />
            <InlineError id="reg-confirm-error" message={fieldErrors.confirmPassword ?? ''} />
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="btn-primary gap-2 px-6 py-2.5 text-sm font-semibold"
            >
              Save & Continue
              <ArrowRight className="w-4 h-4" aria-hidden />
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Post-save: invite users section
  return (
    <div className="space-y-6">
      {/* Success banner */}
      <div className="flex items-start gap-3 rounded-lg bg-success/10 border border-success/30 px-4 py-3">
        <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-success">Account details saved</p>
          <p className="text-xs text-text-muted mt-0.5">
            Signed in as <span className="text-text-secondary">{displayName}</span> ({email})
          </p>
        </div>
      </div>

      {/* Admin seats section */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-accent" aria-hidden />
            Add Admin Seats
          </h3>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            Add only the approved admin accounts for this tenant. Business, customer, and personal
            assistant accounts are connected later under Connectors, not invited as app users.
          </p>
        </div>

        <form
          onSubmit={handleAddInvite}
          noValidate
          className="space-y-3"
          aria-label="Invite admin form"
        >
          <ApiError message={inviteError} />

          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <label
                htmlFor="invite-email"
                className="block text-xs font-medium text-text-secondary"
              >
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@example.com"
                className={cn(
                  INPUT_CLASS,
                  inviteError ? 'border-danger focus:ring-danger/50 focus:border-danger' : '',
                )}
                aria-invalid={!!inviteError}
              />
            </div>

            <div className="space-y-1">
              <span className="block text-xs font-medium text-text-secondary">Role</span>
              <div className="rounded-lg bg-surface-3 border border-border px-3 py-2.5 text-sm text-text-primary">
                Admin
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="btn-secondary gap-2 px-4 py-2 text-sm font-medium"
            aria-label="Add invite to list"
          >
            <Mail className="w-4 h-4" aria-hidden />
            Add Admin
          </button>
        </form>

        {/* Pending invites list */}
        {pendingInvites.length > 0 && (
          <ul className="space-y-2" aria-label="Pending invites">
            {pendingInvites.map((inv, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded-lg bg-surface-3 border border-border px-3 py-2"
              >
                <span className="text-sm text-text-primary">{inv.email}</span>
                <span className="text-xs text-text-muted capitalize bg-surface-4 px-2 py-0.5 rounded-full">
                  {inv.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          className="btn-ghost px-4 py-2 text-sm"
          onClick={handleNext}
        >
          Skip
        </button>
        <button
          className="btn-primary gap-2 px-6 py-2.5 text-sm font-semibold"
          onClick={handleNext}
        >
          Next
          <ArrowRight className="w-4 h-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Business Platform ─────────────────────────────────────────────────
// OAuth configure + start still need to hit the API (Google needs real server
// interaction). BUT clientId/clientSecret are saved to localStorage BEFORE
// calling the API so they survive the redirect. On return the component detects
// platform.connected = true from session and shows the success state.

function StepPlatform({
  initialSession,
  onNext,
  onSkip,
}: {
  initialSession: OnboardingSession;
  onNext: () => void;
  onSkip: () => void;
}) {
  // Restore from session
  const [selected, setSelected] = useState<OAuthProvider | null>(
    initialSession.platform?.provider ?? null,
  );
  const [clientId, setClientId] = useState(initialSession.platform?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState(initialSession.platform?.clientSecret ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [connected, setConnected] = useState<{ provider: OAuthProvider; email?: string } | null>(
    initialSession.platform?.connected && initialSession.platform?.provider
      ? { provider: initialSession.platform.provider }
      : null,
  );

  const PROVIDERS: {
    id: OAuthProvider;
    label: string;
    description: string;
    consoleLabel: string;
    consoleUrl: string;
    brandClass: string;
  }[] = [
    {
      id: 'google',
      label: 'Google Workspace',
      description: 'Gmail, Calendar, Drive, Contacts, Tasks',
      consoleLabel: 'Google Cloud Console',
      consoleUrl: 'https://console.cloud.google.com',
      brandClass: 'text-blue-400',
    },
  ];

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!clientId.trim()) next.clientId = 'Client ID is required.';
    if (!clientSecret.trim()) next.clientSecret = 'Client Secret is required.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setApiError('');
    if (!selected || !validate()) return;

    // Save credentials to session BEFORE calling API so they survive an OAuth redirect
    saveSession({
      platform: {
        provider: selected,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        connected: false,
      },
    });

    setSubmitting(true);
    try {
      // Save credentials server-side (needed for the OAuth callback to work)
      const configRes = await fetch('api/connectors/oauth/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selected,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      const configData = await configRes.json().catch(() => ({}));

      if (!configRes.ok) {
        setApiError(
          configData?.message ?? configData?.error ?? `Configuration failed (${configRes.status}).`,
        );
        return;
      }

      // Start OAuth flow — this will redirect the browser to Google/Microsoft
      const startRes = await fetch(`api/connectors/oauth/${selected}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services: ['mail', 'calendar', 'tasks', 'drive', 'contacts'],
        }),
      });

      const startData = await startRes.json().catch(() => ({}));

      if (!startRes.ok) {
        setApiError(
          startData?.message ?? startData?.error ?? `OAuth start failed (${startRes.status}).`,
        );
        return;
      }

      const oauthUrl: string = startData.url ?? startData.authUrl ?? startData.redirect_url ?? '';
      if (oauthUrl) {
        // Browser will redirect; session data already written above
        window.location.href = oauthUrl;
      } else {
        // No redirect URL returned — treat as immediate success
        const updated = saveSession({
          platform: {
            provider: selected,
            clientId: clientId.trim(),
            clientSecret: clientSecret.trim(),
            connected: true,
          },
        });
        setConnected({ provider: selected });
        // Persist step advancement
        saveSession({ step: 3, platform: updated.platform });
      }
    } catch {
      setApiError('Network error — could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const activeProvider = selected ? PROVIDERS.find((p) => p.id === selected) : null;

  function handleNext() {
    saveSession({ step: 3 });
    onNext();
  }

  function handleSkip() {
    saveSession({ step: 3 });
    onSkip();
  }

  if (connected) {
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-3 rounded-lg bg-success/10 border border-success/30 px-4 py-3">
          <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-success">
              {connected.provider === 'google' ? 'Google Workspace' : 'Microsoft 365'} connected
            </p>
            {connected.email && (
              <p className="text-xs text-text-muted mt-0.5">{connected.email}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            className="btn-primary gap-2 px-6 py-2.5 text-sm font-semibold"
            onClick={handleNext}
          >
            Next
            <ArrowRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-text-primary mb-1">Connect Your Business Suite</h2>
        <p className="text-sm text-text-muted">
          Link the company workspace first so the dashboard can organize mail, calendar, files, and operating context for any business.
        </p>
      </div>

      {/* Provider selection */}
      <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Business platform">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={selected === p.id}
            onClick={() => {
              setSelected(p.id);
              setClientId('');
              setClientSecret('');
              setFieldErrors({});
              setApiError('');
            }}
            className={cn(
              'text-left rounded-xl border p-4 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent/50',
              selected === p.id
                ? 'border-accent bg-accent/5'
                : 'border-border bg-surface-3 hover:border-border/80 hover:bg-surface-4',
            )}
          >
            <p className={cn('text-sm font-semibold', p.brandClass)}>{p.label}</p>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">{p.description}</p>
          </button>
        ))}
      </div>

      {/* Expanded credential form */}
      {selected && activeProvider && (
        <div className="rounded-xl border border-border bg-surface-3 p-5 space-y-4 animate-fade-in">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Provide Your OAuth Credentials
            </h3>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">
              Create a <strong>Web application</strong> OAuth app in{' '}
              <a
                href={activeProvider.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-0.5"
              >
                {activeProvider.consoleLabel}
                <ExternalLink className="w-3 h-3" aria-hidden />
              </a>{' '}
              and enter the credentials here. Choose &quot;Web application&quot; as the
              application type (not Desktop). This keeps your data under your control.
            </p>

            {/* Redirect URI — admin needs to add this in their OAuth console */}
            <div className="mt-3 p-3 rounded-lg bg-surface-4 border border-border/50">
              <p className="text-xs font-medium text-text-secondary mb-1.5">
                Authorized redirect URI <span className="text-text-muted">(add this in your OAuth app settings)</span>
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs text-accent bg-surface-3 px-2.5 py-1.5 rounded border border-border/50 break-all select-all">
                  {`${window.location.origin}/boss/api/connectors/oauth/${selected}/callback`}
                </code>
                <button
                  type="button"
                  className="btn-ghost text-xs px-2 py-1.5 flex-shrink-0"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `${window.location.origin}/boss/api/connectors/oauth/${selected}/callback`,
                    );
                  }}
                  aria-label="Copy redirect URI"
                >
                  Copy
                </button>
              </div>
            </div>
          </div>

          <form onSubmit={handleConnect} noValidate className="space-y-4" id="oauth-form">
            <ApiError message={apiError} />

            <div className="space-y-1.5">
              <label
                htmlFor="oauth-client-id"
                className="block text-xs font-medium text-text-secondary"
              >
                Client ID
              </label>
              <input
                id="oauth-client-id"
                type="text"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="your-client-id.apps.googleusercontent.com"
                className={cn(
                  INPUT_CLASS,
                  fieldErrors.clientId
                    ? 'border-danger focus:ring-danger/50 focus:border-danger'
                    : '',
                )}
                aria-describedby={fieldErrors.clientId ? 'oauth-client-id-error' : undefined}
                aria-invalid={!!fieldErrors.clientId}
              />
              <InlineError id="oauth-client-id-error" message={fieldErrors.clientId ?? ''} />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="oauth-client-secret"
                className="block text-xs font-medium text-text-secondary"
              >
                Client Secret
              </label>
              <PasswordInput
                id="oauth-client-secret"
                value={clientSecret}
                onChange={setClientSecret}
                placeholder="Your client secret"
                autoComplete="off"
                hasError={!!fieldErrors.clientSecret}
                aria-describedby={
                  fieldErrors.clientSecret ? 'oauth-client-secret-error' : undefined
                }
              />
              <InlineError
                id="oauth-client-secret-error"
                message={fieldErrors.clientSecret ?? ''}
              />
            </div>
          </form>

          <div className="flex justify-end">
            <button
              type="submit"
              form="oauth-form"
              className="btn-primary gap-2 px-5 py-2.5 text-sm font-semibold"
              disabled={submitting}
              aria-disabled={submitting}
            >
              {submitting ? 'Connecting…' : 'Save & Connect'}
              {!submitting && <ArrowRight className="w-4 h-4" aria-hidden />}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button className="btn-ghost px-4 py-2 text-sm" onClick={handleSkip}>
          Skip for now
        </button>
        <button
          className="btn-primary gap-2 px-6 py-2.5 text-sm font-semibold"
          onClick={handleNext}
          disabled={!!selected && !connected}
        >
          Next
          <ArrowRight className="w-4 h-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Brain & Integrations ─────────────────────────────────────────────
// Does NOT call the backend. Saves provider + credentials to localStorage only.
// The actual brain configuration happens at step 4 (StepReady).

function StepBrain({
  initialSession,
  onNext,
}: {
  initialSession: OnboardingSession;
  onNext: () => void;
}) {
  const [selectedBrain, setSelectedBrain] = useState<BrainProvider | null>(
    initialSession.brain?.provider ?? null,
  );
  const [credentials, setCredentials] = useState<Record<string, string>>(
    initialSession.brain?.credentials ?? {},
  );
  const [brainError, setBrainError] = useState('');
  const [brainSaved, setBrainSaved] = useState(!!initialSession.brain?.provider);

  function setCredential(key: string, value: string) {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  }

  function validateBrain(): boolean {
    if (!selectedBrain) {
      setBrainError('Please select an AI brain.');
      return false;
    }
    if (selectedBrain === 'claude-code' && !credentials.apiKey?.trim()) {
      setBrainError('Claude API key or subscription token is required.');
      return false;
    }
    if (selectedBrain === 'openai' && !credentials.apiKey?.trim()) {
      setBrainError('API Key is required.');
      return false;
    }
    if (selectedBrain === 'gemini' && !credentials.apiKey?.trim()) {
      setBrainError('API Key is required.');
      return false;
    }
    if (selectedBrain === 'openclaw' && !credentials.baseUrl?.trim()) {
      setBrainError('Base URL is required.');
      return false;
    }
    if (selectedBrain === 'custom' && !credentials.endpointUrl?.trim()) {
      setBrainError('Endpoint URL is required.');
      return false;
    }
    setBrainError('');
    return true;
  }

  function handleSaveBrain(e: React.FormEvent) {
    e.preventDefault();
    if (!validateBrain() || !selectedBrain) return;
    saveSession({
      brain: { provider: selectedBrain, credentials },
    });
    setBrainSaved(true);
  }

  function handleNext() {
    saveSession({ step: 4 });
    onNext();
  }

  function handleSkip() {
    saveSession({ step: 4 });
    onNext();
  }

  return (
    <div className="space-y-8">
      {/* Brain selection */}
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary mb-1">Configure Your AI Brain</h2>
          <p className="text-sm text-text-muted">
            Choose the AI provider that will power business orchestration and personal assistant workflows.
          </p>
        </div>

        <div className="space-y-2" role="radiogroup" aria-label="AI brain provider">
          {BRAIN_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              role="radio"
              aria-checked={selectedBrain === opt.id}
              onClick={() => {
                setSelectedBrain(opt.id);
                setCredentials({});
                setBrainError('');
                setBrainSaved(false);
              }}
              className={cn(
                'w-full text-left rounded-xl border p-4 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent/50 flex items-center gap-4',
                selectedBrain === opt.id
                  ? 'border-accent bg-accent/5'
                  : 'border-border bg-surface-3 hover:border-border/80 hover:bg-surface-4',
              )}
            >
              <div
                className={cn(
                  'flex-shrink-0 w-8 h-8 rounded-full border-2 flex items-center justify-center transition-colors',
                  selectedBrain === opt.id ? 'border-accent bg-accent' : 'border-border',
                )}
                aria-hidden
              >
                {selectedBrain === opt.id && (
                  <Check className="w-4 h-4 text-white" aria-hidden />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-text-primary">{opt.label}</span>
                  {opt.badge && (
                    <span className="text-xs font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-full">
                      {opt.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">{opt.description}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Credential form */}
        {selectedBrain && !brainSaved && (
          <div className="rounded-xl border border-border bg-surface-3 p-5 animate-fade-in">
            <form
              id="brain-form"
              onSubmit={handleSaveBrain}
              noValidate
              className="space-y-4"
              aria-label="Brain credentials form"
            >
              {brainError && <ApiError message={brainError} />}

              {selectedBrain === 'claude-code' && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="brain-token"
                    className="block text-xs font-medium text-text-secondary"
                  >
                    API Key or Subscription Token
                  </label>
                  <PasswordInput
                    id="brain-token"
                    value={credentials.apiKey ?? ''}
                    onChange={(v) => setCredential('apiKey', v)}
                    placeholder="Your Claude API key or subscription token"
                    autoComplete="off"
                  />
                </div>
              )}

              {(selectedBrain === 'openai' || selectedBrain === 'gemini') && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="brain-apikey"
                    className="block text-xs font-medium text-text-secondary"
                  >
                    API Key
                  </label>
                  <PasswordInput
                    id="brain-apikey"
                    value={credentials.apiKey ?? ''}
                    onChange={(v) => setCredential('apiKey', v)}
                    placeholder={selectedBrain === 'openai' ? 'sk-...' : 'Your Gemini API key'}
                    autoComplete="off"
                  />
                </div>
              )}

              {selectedBrain === 'openclaw' && (
                <>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="brain-baseurl"
                      className="block text-xs font-medium text-text-secondary"
                    >
                      Base URL
                    </label>
                    <input
                      id="brain-baseurl"
                      type="text"
                      value={credentials.baseUrl ?? ''}
                      onChange={(e) => setCredential('baseUrl', e.target.value)}
                      placeholder="https://your-openclaw-instance.com"
                      className={INPUT_CLASS}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="brain-openclaw-key"
                      className="block text-xs font-medium text-text-secondary"
                    >
                      API Key
                    </label>
                    <PasswordInput
                      id="brain-openclaw-key"
                      value={credentials.apiKey ?? ''}
                      onChange={(v) => setCredential('apiKey', v)}
                      placeholder="Your OpenClaw API key"
                      autoComplete="off"
                    />
                  </div>
                </>
              )}

              {selectedBrain === 'custom' && (
                <>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="brain-endpoint"
                      className="block text-xs font-medium text-text-secondary"
                    >
                      Endpoint URL
                    </label>
                    <input
                      id="brain-endpoint"
                      type="text"
                      value={credentials.endpointUrl ?? ''}
                      onChange={(e) => setCredential('endpointUrl', e.target.value)}
                      placeholder="https://api.your-endpoint.com/v1"
                      className={INPUT_CLASS}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="brain-custom-key"
                      className="block text-xs font-medium text-text-secondary"
                    >
                      API Key
                    </label>
                    <PasswordInput
                      id="brain-custom-key"
                      value={credentials.apiKey ?? ''}
                      onChange={(v) => setCredential('apiKey', v)}
                      placeholder="Your API key"
                      autoComplete="off"
                    />
                  </div>
                </>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  form="brain-form"
                  className="btn-primary gap-2 px-5 py-2.5 text-sm font-semibold"
                >
                  Save Brain Config
                  <Check className="w-4 h-4" aria-hidden />
                </button>
              </div>
            </form>
          </div>
        )}

        {brainSaved && (
          <div className="flex items-center gap-2 text-sm text-success rounded-lg bg-success/10 border border-success/30 px-4 py-3">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden />
            Brain configuration saved.
          </div>
        )}
      </div>

      {/* Integrations grid */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Connect Business and Personal Tools</h3>
          <p className="text-xs text-text-muted mt-1">
            Optional - connect commonly used company systems and personal assistant sources now, or add them later from Settings.
          </p>
        </div>

        <ul
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          aria-label="Available integrations"
        >
          {INTEGRATIONS.map((intg) => {
            const Icon = intg.icon;
            return (
              <li key={intg.id}>
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-3 p-3">
                  <div
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-4 flex items-center justify-center"
                    aria-hidden
                  >
                    <Icon className="w-4 h-4 text-text-muted" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-text-primary">{intg.label}</p>
                      <span className="rounded-full bg-surface-4 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                        {intg.scope}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted truncate">{intg.description}</p>
                  </div>
                  <button
                    className="btn-ghost px-2.5 py-1 text-xs opacity-50 cursor-not-allowed"
                    disabled
                    aria-disabled="true"
                    title="Coming soon"
                    aria-label={`Connect ${intg.label} — coming soon`}
                  >
                    Connect
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          className="btn-ghost px-4 py-2 text-sm"
          onClick={handleSkip}
        >
          Skip
        </button>
        <button
          className="btn-primary gap-2 px-6 py-2.5 text-sm font-semibold"
          onClick={handleNext}
        >
          Continue to Summary
          <ArrowRight className="w-4 h-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Ready — finalize all backend writes ──────────────────────────────
// This is the only place API calls are made (except the OAuth configure/start
// which must happen in step 2 because Google requires a server redirect).
//
// Sequence:
//   1. POST /api/auth/register  → get JWT
//   2. POST /api/auth/invite    → for each pending invite (with JWT)
//   3. POST /api/brain/configure → store brain config (with JWT)
//   4. Set boss_onboarding_complete in localStorage
//   5. Clear localStorage
//   6. Navigate to /

type FinalizeStatus = 'idle' | 'running' | 'done' | 'error';

interface FinalizeStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

function StepReady({
  session,
  onLaunch,
}: {
  session: OnboardingSession;
  onLaunch: (jwt: string) => void;
}) {
  const { account, invites = [], brain, platform } = session;

  const brainLabel = brain
    ? BRAIN_OPTIONS.find((b) => b.id === brain.provider)?.label ?? brain.provider
    : null;

  const summaryItems = [
    account
      ? { label: 'Operator login', value: `${account.displayName} (${account.email})` }
      : null,
    platform?.connected
      ? {
          label: 'Business platform',
          value: platform.provider === 'google' ? 'Google Workspace' : 'Microsoft 365',
        }
      : null,
    brainLabel ? { label: 'AI brain', value: brainLabel } : null,
    invites.length > 0 ? { label: 'Pending invites', value: `${invites.length}` } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  const [status, setStatus] = useState<FinalizeStatus>('idle');
  const [steps, setSteps] = useState<FinalizeStep[]>([]);
  const [fatalError, setFatalError] = useState('');

  function updateStep(key: string, patch: Partial<FinalizeStep>) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  const handleFinalize = useCallback(async () => {
    if (!account) {
      setFatalError('Account information is missing. Please go back to step 1.');
      return;
    }

    // Build step list dynamically based on what was configured
    const initialSteps: FinalizeStep[] = [
      { key: 'register', label: 'Creating account…', status: 'pending' },
      ...(invites.length > 0
        ? [{ key: 'invites', label: `Sending ${invites.length} invite${invites.length > 1 ? 's' : ''}…`, status: 'pending' as const }]
        : []),
      ...(brain
        ? [{ key: 'brain', label: 'Configuring AI brain…', status: 'pending' as const }]
        : []),
    ];

    setSteps(initialSteps);
    setStatus('running');
    setFatalError('');

    // ── 1. Register ──────────────────────────────────────────────────────────
    updateStep('register', { status: 'running' });
    let jwt = '';
    try {
      const res = await fetch('api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: account.displayName,
          email: account.email,
          password: account.password,
          role: 'admin',
          passkey: localStorage.getItem("boss_onboarding_passkey") || "",
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data?.message ?? data?.error ?? `Registration failed (${res.status}).`;
        updateStep('register', { status: 'error', error: msg });
        setStatus('error');
        return;
      }

      jwt = data.accessToken ?? data.token ?? '';
      localStorage.setItem('boss_token', jwt);
      // Store user info for role-based UI
      if (data.id || data.email) {
        localStorage.setItem('boss_user', JSON.stringify({
          id: data.id,
          email: data.email,
          displayName: data.displayName ?? data.email,
          role: data.role ?? 'admin',
          tenantId: data.tenantId,
        }));
      }
      updateStep('register', { status: 'done', label: 'Account created' });
    } catch {
      updateStep('register', { status: 'error', error: 'Network error — could not reach the server.' });
      setStatus('error');
      return;
    }

    // ── 2. Invites ───────────────────────────────────────────────────────────
    if (invites.length > 0) {
      updateStep('invites', { status: 'running' });
      const failures: string[] = [];

      for (const inv of invites) {
        try {
          const res = await fetch('api/auth/invite', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({ email: inv.email, role: inv.role }),
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            failures.push(`${inv.email}: ${data?.message ?? data?.error ?? res.status}`);
          }
        } catch {
          failures.push(`${inv.email}: network error`);
        }
      }

      if (failures.length > 0) {
        updateStep('invites', {
          status: 'error',
          label: `${invites.length - failures.length} of ${invites.length} invites sent`,
          error: `Failed: ${failures.join('; ')}`,
        });
        // Non-fatal — continue
      } else {
        updateStep('invites', { status: 'done', label: `${invites.length} invite${invites.length > 1 ? 's' : ''} sent` });
      }
    }

    // ── 3. Brain ─────────────────────────────────────────────────────────────
    if (brain) {
      updateStep('brain', { status: 'running' });
      try {
        const res = await fetch('api/brain/configure', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ provider: brain.provider, credentials: brain.credentials }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const msg = data?.message ?? data?.error ?? `Brain config failed (${res.status}).`;
          updateStep('brain', { status: 'error', error: msg });
          // Non-fatal — continue to done
        } else {
          updateStep('brain', { status: 'done', label: 'AI brain configured' });
        }
      } catch {
        updateStep('brain', { status: 'error', error: 'Network error configuring brain.' });
        // Non-fatal — continue to done
      }
    }

    setStatus('done');
    onLaunch(jwt);
  }, [account, invites, brain, onLaunch]);

  if (status === 'idle') {
    return (
      <div className="text-center py-10 space-y-8">
        <div className="space-y-4">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-success/10 mx-auto">
            <CheckCircle2 className="w-10 h-10 text-success" aria-hidden />
          </div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">
            Ready to launch!
          </h1>
          <p className="text-base text-text-secondary max-w-sm mx-auto leading-relaxed">
            Here&apos;s what will be configured when you click Launch:
          </p>
        </div>

        {summaryItems.length > 0 && (
          <ul className="inline-flex flex-col gap-2 text-left" aria-label="Configuration summary">
            {summaryItems.map((item) => (
              <li key={item.label} className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4 text-success shrink-0" aria-hidden />
                <span className="text-sm text-text-secondary">
                  <span className="text-text-primary font-medium">{item.label}:</span>{' '}
                  {item.value}
                </span>
              </li>
            ))}
          </ul>
        )}

        {fatalError && <ApiError message={fatalError} />}

        <div>
          <button
            className="btn-primary gap-2 px-8 py-3 text-sm font-semibold"
            onClick={handleFinalize}
            autoFocus
          >
            Launch Dashboard
            <ArrowRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  // Running / error / done states all show the progress list
  return (
    <div className="py-10 space-y-8">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-accent/10 mx-auto">
          {status === 'running' ? (
            <Loader2 className="w-10 h-10 text-accent animate-spin" aria-hidden />
          ) : status === 'done' ? (
            <CheckCircle2 className="w-10 h-10 text-success" aria-hidden />
          ) : (
            <Zap className="w-10 h-10 text-accent" aria-hidden />
          )}
        </div>
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">
          {status === 'running'
            ? 'Setting up your BOS...'
            : status === 'done'
            ? "You're all set!"
            : 'Setup incomplete'}
        </h1>
      </div>

      <ul className="space-y-3 max-w-sm mx-auto" aria-label="Setup progress" aria-live="polite">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">
              {s.status === 'running' && (
                <Loader2 className="w-4 h-4 text-accent animate-spin" aria-label="In progress" />
              )}
              {s.status === 'done' && (
                <CheckCircle2 className="w-4 h-4 text-success" aria-label="Done" />
              )}
              {s.status === 'error' && (
                <span
                  className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-warning/20 text-warning text-xs font-bold"
                  aria-label="Warning"
                >
                  !
                </span>
              )}
              {s.status === 'pending' && (
                <span className="inline-block w-4 h-4 rounded-full border-2 border-border" aria-label="Pending" />
              )}
            </span>
            <div>
              <p
                className={cn(
                  'text-sm',
                  s.status === 'done'
                    ? 'text-text-primary font-medium'
                    : s.status === 'error'
                    ? 'text-warning font-medium'
                    : s.status === 'running'
                    ? 'text-text-primary'
                    : 'text-text-muted',
                )}
              >
                {s.label}
              </p>
              {s.error && (
                <p className="text-xs text-warning mt-0.5">{s.error}</p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {status === 'error' && (
        <div className="text-center space-y-3">
          <p className="text-sm text-text-muted">
            Some steps failed. Your progress is saved — you can retry.
          </p>
          <button
            className="btn-primary gap-2 px-6 py-2.5 text-sm font-semibold"
            onClick={handleFinalize}
          >
            Retry
            <ArrowRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Onboarding component ────────────────────────────────────────────────

export function Onboarding() {
  const navigate = useNavigate();

  // Initialize from localStorage on first render
  const [session, setSessionState] = useState<OnboardingSession>(() => {
    const initial = readSession();

    // Handle OAuth redirect return: check for oauth=success in hash query params
    // e.g. #/onboarding?oauth=success
    const hashSearch = window.location.hash.split('?')[1] ?? '';
    const hashParams = new URLSearchParams(hashSearch);
    const urlPasskey = hashParams.get('passkey');
    if (urlPasskey) localStorage.setItem('boss_onboarding_passkey', urlPasskey);
    if (hashParams.get('oauth') === 'success') {
      // Mark platform as connected and advance to step 3
      const platform = initial.platform
        ? { ...initial.platform, connected: true }
        : initial.platform;
      const updated = saveSession({ ...initial, platform, step: 3 });
      // Clean the URL hash so a refresh doesn't re-trigger this branch
      window.location.hash = '#/onboarding';
      return updated;
    }

    return initial;
  });

  const [step, setStep] = useState(session.step);

  // Keep local step and session in sync when we advance
  function advance(nextStep: number, updates: Partial<OnboardingSession> = {}) {
    const next = saveSession({ ...updates, step: nextStep });
    setSessionState(next);
    setStep(nextStep);
  }

  const handleWelcomeNext = useCallback(() => {
    advance(1);
  }, []);

  const handleAccountNext = useCallback(() => {
    // Session was already written by StepAccount's handlers; just advance
    const refreshed = readSession();
    setSessionState(refreshed);
    setStep(2);
    saveSession({ step: 2 });
  }, []);

  const handlePlatformNext = useCallback(() => {
    const refreshed = readSession();
    setSessionState(refreshed);
    setStep(3);
    saveSession({ step: 3 });
  }, []);

  const handlePlatformSkip = useCallback(() => {
    setStep(3);
    saveSession({ step: 3 });
  }, []);

  const handleBrainNext = useCallback(() => {
    const refreshed = readSession();
    setSessionState(refreshed);
    setStep(4);
    saveSession({ step: 4 });
  }, []);

  const handleLaunch = useCallback(
    (jwt: string) => {
      // jwt was written to localStorage by StepReady; clean up session
      localStorage.setItem('boss_onboarding_complete', 'true');
      if (jwt) localStorage.setItem('boss_token', jwt);
      clearSession();
      // Setup ends INSIDE the product: straight to the dashboard, already
      // authenticated — the first-login sequence starts immediately there.
      navigate('/');
    },
    [navigate],
  );

  // Re-read session whenever step changes (StepPlatform writes to session on OAuth return)
  useEffect(() => {
    setSessionState(readSession());
  }, [step]);

  // Show step indicator only for steps 1-3 (not welcome or ready)
  const showIndicator = step >= 1 && step <= 3;
  const indicatorStep = step <= 3 ? step : 3;

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden bg-[#030711] p-4 sm:p-8"
      aria-label="BOS onboarding"
    >
      <img
        src={entranceElevatorScene}
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-70"
        style={{ filter: 'brightness(0.74) saturate(1.05) contrast(1.03)' }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(3,7,17,0.88),rgba(6,16,36,0.46),rgba(3,7,17,0.78))]" aria-hidden="true" />
      <div className="aios-atmosphere-grid absolute inset-0" aria-hidden="true" />
      <div className="relative w-full max-w-6xl space-y-8">
        {/* Logo / wordmark */}
        <div className="text-center">
          <span className="text-lg font-bold tracking-tight text-text-primary">
            BOS <span className="text-accent">Command Center</span>
          </span>
        </div>

        {/* Step indicator */}
        {step < 4 && (
          <div className="flex flex-col items-center gap-2">
            <StepIndicator current={indicatorStep} />
            {showIndicator && (
              <p className="text-xs text-text-muted">
                {step === 1 && 'Step 1 of 3 — Account'}
                {step === 2 && 'Step 2 of 3 — Business Platform'}
                {step === 3 && 'Step 3 of 3 — Brain & Integrations'}
              </p>
            )}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          {/* Step content with fade-in animation */}
          <div
            key={step}
            className="aios-panel animate-fade-in p-6 sm:p-8"
          >
            {step === 0 && <StepWelcome onNext={handleWelcomeNext} />}

            {step === 1 && (
              <StepAccount
                initialSession={session}
                onNext={handleAccountNext}
              />
            )}

            {step === 2 && (
              <StepPlatform
                initialSession={session}
                onNext={handlePlatformNext}
                onSkip={handlePlatformSkip}
              />
            )}

            {step === 3 && (
              <StepBrain
                initialSession={session}
                onNext={handleBrainNext}
              />
            )}

            {step === 4 && (
              <StepReady
                session={session}
                onLaunch={handleLaunch}
              />
            )}
          </div>

          <OnboardingGuide step={step} session={session} />
        </div>
      </div>
    </div>
  );
}

export default Onboarding;

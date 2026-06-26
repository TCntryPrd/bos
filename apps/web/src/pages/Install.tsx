/**
 * Public install page for white-label tenant provisioning
 * URL: /install
 *
 * Collects basic info and creates a new tenant + admin user
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface InstallFormData {
  fullName: string;
  businessName: string;
  userName: string;
  email: string;
  password: string;
  confirmPassword: string;
  openrouterApiKey: string;
  createOpenrouterForMe: boolean;
  plannedUse: string;
  acceptTerms: boolean;
}

const INITIAL_FORM: InstallFormData = {
  fullName: '',
  businessName: '',
  userName: '',
  email: '',
  password: '',
  confirmPassword: '',
  openrouterApiKey: '',
  createOpenrouterForMe: false,
  plannedUse: '',
  acceptTerms: false,
};

export function Install() {
  const navigate = useNavigate();
  const [form, setForm] = useState<InstallFormData>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof InstallFormData, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof InstallFormData, string>> = {};

    if (!form.fullName.trim()) newErrors.fullName = 'Full name is required';
    if (!form.businessName.trim()) newErrors.businessName = 'Business name is required';

    if (!form.userName.trim()) {
      newErrors.userName = 'User name is required';
    } else if (!/^[a-z]{2,24}$/.test(form.userName)) {
      newErrors.userName = 'User name must be 2-24 lowercase letters';
    }

    if (!form.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      newErrors.email = 'Invalid email format';
    }

    if (!form.password) {
      newErrors.password = 'Password is required';
    } else if (form.password.length < 12) {
      newErrors.password = 'Password must be at least 12 characters';
    }

    if (form.password !== form.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    if (!form.acceptTerms) {
      newErrors.acceptTerms = 'You must accept the terms to continue';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validate()) return;

    setSubmitting(true);

    try {
      const response = await fetch('/api/admin/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName,
          businessName: form.businessName,
          userName: form.userName,
          email: form.email,
          password: form.password,
          openrouterApiKey: form.openrouterApiKey || undefined,
          createOpenrouterForMe: form.createOpenrouterForMe,
          plannedUse: form.plannedUse || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Installation failed');
      }

      const data = await response.json();

      // Store auth token
      if (data.authToken) {
        localStorage.setItem('boss_token', data.authToken);
      }

      // Redirect to onboarding
      navigate(data.onboardingUrl || '/onboarding');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Installation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const updateField = <K extends keyof InstallFormData>(
    field: K,
    value: InstallFormData[K]
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field when user types
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0c12] via-[#0f1119] to-[#1a1d2e] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-[#b56cff] to-[#5cc8ff] bg-clip-text text-transparent mb-2">
            Welcome to BOS
          </h1>
          <p className="text-text-muted text-sm">
            Your autonomous AI operating system. Let's get you set up.
          </p>
        </div>

        {/* Form Card */}
        <div className="bg-surface/40 backdrop-blur-xl border border-border rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Personal Info */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <span className="text-accent">1.</span> About You
              </h2>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Full Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.fullName}
                  onChange={(e) => updateField('fullName', e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors"
                  placeholder="Kevin D. Caine"
                />
                {errors.fullName && <p className="text-red-400 text-xs mt-1">{errors.fullName}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Business Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.businessName}
                  onChange={(e) => updateField('businessName', e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors"
                  placeholder="D. Caine Solutions"
                />
                {errors.businessName && <p className="text-red-400 text-xs mt-1">{errors.businessName}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Planned Use <span className="text-text-muted text-xs">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={form.plannedUse}
                  onChange={(e) => updateField('plannedUse', e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors"
                  placeholder="Marketing automation, customer support..."
                />
              </div>
            </div>

            {/* AIOS Identity */}
            <div className="space-y-4 pt-4 border-t border-border/50">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <span className="text-accent">2.</span> Your BOS Identity
              </h2>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  What should your BOS call you? <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.userName}
                  onChange={(e) => updateField('userName', e.target.value.toLowerCase())}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors font-mono"
                  placeholder="kevin"
                />
                <p className="text-xs text-text-muted mt-1">2-24 lowercase letters (e.g., "kevin", "boss", "chief")</p>
                {errors.userName && <p className="text-red-400 text-xs mt-1">{errors.userName}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Email <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors"
                  placeholder="your@email.com"
                />
                {errors.email && <p className="text-red-400 text-xs mt-1">{errors.email}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Password <span className="text-red-400">*</span>
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors"
                  placeholder="Min 12 characters"
                />
                {errors.password && <p className="text-red-400 text-xs mt-1">{errors.password}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Confirm Password <span className="text-red-400">*</span>
                </label>
                <input
                  type="password"
                  value={form.confirmPassword}
                  onChange={(e) => updateField('confirmPassword', e.target.value)}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors"
                />
                {errors.confirmPassword && <p className="text-red-400 text-xs mt-1">{errors.confirmPassword}</p>}
              </div>
            </div>

            {/* API Keys */}
            <div className="space-y-4 pt-4 border-t border-border/50">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <span className="text-accent">3.</span> AI Model Access
              </h2>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  OpenRouter API Key <span className="text-text-muted text-xs">(Optional)</span>
                </label>
                <input
                  type="text"
                  value={form.openrouterApiKey}
                  onChange={(e) => updateField('openrouterApiKey', e.target.value)}
                  disabled={form.createOpenrouterForMe}
                  className="w-full px-4 py-2.5 bg-surface-2/60 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 transition-colors font-mono text-sm disabled:opacity-50"
                  placeholder="sk-or-v1-..."
                />
                <p className="text-xs text-text-muted mt-1">
                  If you have an OpenRouter account, paste your API key here
                </p>
              </div>

              <div className="flex items-center gap-3 p-4 bg-surface-2/30 rounded-lg border border-border/50">
                <input
                  type="checkbox"
                  id="createOpenrouter"
                  checked={form.createOpenrouterForMe}
                  onChange={(e) => updateField('createOpenrouterForMe', e.target.checked)}
                  className="w-4 h-4 accent-accent"
                />
                <label htmlFor="createOpenrouter" className="text-sm text-text-primary cursor-pointer flex-1">
                  Create an OpenRouter account for me (free tier available)
                </label>
              </div>
            </div>

            {/* Terms */}
            <div className="pt-4 border-t border-border/50">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="terms"
                  checked={form.acceptTerms}
                  onChange={(e) => updateField('acceptTerms', e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-accent"
                />
                <label htmlFor="terms" className="text-sm text-text-primary cursor-pointer flex-1">
                  I accept the{' '}
                  <a href="/terms" className="text-accent hover:underline" target="_blank">
                    Terms of Service
                  </a>{' '}
                  and{' '}
                  <a href="/privacy" className="text-accent hover:underline" target="_blank">
                    Privacy Policy
                  </a>
                </label>
              </div>
              {errors.acceptTerms && <p className="text-red-400 text-xs mt-2">{errors.acceptTerms}</p>}
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3.5 rounded-lg font-semibold text-[#0a0c12] disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-accent/20"
              style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
            >
              {submitting ? 'Setting up your BOS...' : 'Create My BOS →'}
            </button>

            <p className="text-center text-xs text-text-muted">
              Already have an account?{' '}
              <a href="/login" className="text-accent hover:underline">
                Sign in
              </a>
            </p>
          </form>
        </div>

        {/* Footer */}
        <div className="text-center mt-6 text-xs text-text-muted">
          <p>Powered by BOS • Self-hosted AI automation</p>
        </div>
      </div>
    </div>
  );
}

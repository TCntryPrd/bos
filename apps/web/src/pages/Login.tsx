/**
 * Login — credential-based authentication for returning users.
 *
 * Shows a "Set up BOS" link below the form when onboarding has not
 * been completed yet (boss_onboarding_complete !== 'true').
 */

import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { cn } from '../lib/utils';
import { BossMark } from '../components/shell/BossLogo';

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-lg bg-surface-3 border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent';

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onboardingComplete = localStorage.getItem('boss_onboarding_complete') === 'true';

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(totpCode ? { totpCode: totpCode.trim() } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.requires2fa) {
          setNeeds2fa(true);
          setError('Enter the 6-digit code from Google Authenticator');
          setSubmitting(false);
          return;
        }
        setError(data.message || 'Login failed');
        setSubmitting(false);
        return;
      }

      // Store token and user info
      localStorage.setItem('boss_token', data.accessToken);
      localStorage.setItem('boss_refresh_token', data.refreshToken || '');
      localStorage.setItem('boss_user', JSON.stringify(data.user));

      const authRedirect = location.state as { from?: { pathname?: string; search?: string } } | null;
      const from = `${authRedirect?.from?.pathname || '/'}${authRedirect?.from?.search || ''}`;
      navigate(from, { replace: true });
    } catch {
      setError('Unable to connect to server');
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-1 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Hero */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            <BossMark scale={2.4} />
          </div>
          <p className="text-sm text-text-muted mt-1">Sign in to your account</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/20 text-sm text-danger">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="login-email" className="block text-xs font-medium text-text-secondary">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={INPUT_CLASS}
              autoComplete="email"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-xs font-medium text-text-secondary">
              Password
            </label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className={cn(INPUT_CLASS, 'pr-10')}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {needs2fa && (
            <div className="space-y-1.5">
              <label htmlFor="login-2fa" className="block text-xs font-medium text-text-secondary">
                Authenticator Code
              </label>
              <input
                id="login-2fa"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className={cn(INPUT_CLASS, 'tracking-[0.3em] text-center font-mono')}
                autoComplete="one-time-code"
                autoFocus
              />
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full gap-2 py-2.5 text-sm font-semibold justify-center"
          >
            {submitting ? (
              'Signing in...'
            ) : (
              <>
                <LogIn className="w-4 h-4" aria-hidden />
                Sign In
              </>
            )}
          </button>
        </form>

        {!onboardingComplete && (
          <div className="mt-6">
            <div className="flex items-center gap-3 text-text-muted text-xs">
              <span className="flex-1 border-t border-border" />
              <span>or</span>
              <span className="flex-1 border-t border-border" />
            </div>
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => navigate('/onboarding')}
                className="text-sm text-accent hover:text-accent/80 transition-colors"
              >
                First time? Set up BOS →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Login;

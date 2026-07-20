/**
 * Login — credential-based authentication for returning users.
 *
 * Two brand treatments (VITE_BRAND):
 *   ir    — Industry Rockstar white-label: entrance scene + glass panel.
 *   plain — clean standard BOS: flat dark surface, no scene.
 * The FrontSwitcher (Executive · Original) lets the user hop between the
 * two front containers from either login.
 */

import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { cn } from '../lib/utils';
import { BossMark } from '../components/shell/BossLogo';
import { isPlainBrand } from '../lib/brand';
import entranceElevatorScene from '../assets/entrance-elevator-scene.png';

const INPUT_CLASS_IR =
  'w-full px-3 py-2.5 rounded-lg bg-white/72 border border-slate-300/70 text-slate-950 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 focus:border-cyan-500';
const INPUT_CLASS_PLAIN =
  'w-full px-3 py-2.5 rounded-lg bg-surface-3 border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent';
const INPUT_CLASS = isPlainBrand ? INPUT_CLASS_PLAIN : INPUT_CLASS_IR;
const LABEL_CLASS = isPlainBrand ? 'block text-xs font-medium text-text-secondary' : 'block text-xs font-medium text-slate-700';
const EYE_CLASS = isPlainBrand
  ? 'absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary'
  : 'absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700';

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

  const formBody = (
    <>
      <form onSubmit={handleLogin} className="space-y-4">
        {error && (
          <div className="p-3 rounded-lg bg-danger/10 border border-danger/20 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="login-email" className={LABEL_CLASS}>Email</label>
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
          <label htmlFor="login-password" className={LABEL_CLASS}>Password</label>
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
              className={EYE_CLASS}
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {needs2fa && (
          <div className="space-y-1.5">
            <label htmlFor="login-2fa" className={LABEL_CLASS}>Authenticator Code</label>
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
          {submitting ? 'Signing in...' : (<><LogIn className="w-4 h-4" aria-hidden />Sign In</>)}
        </button>
      </form>


      {!onboardingComplete && (
        <div className="mt-6">
          <div className={cn('flex items-center gap-3 text-xs', isPlainBrand ? 'text-text-muted' : 'text-slate-500')}>
            <span className={cn('flex-1 border-t', isPlainBrand ? 'border-border' : 'border-slate-300/70')} />
            <span>or</span>
            <span className={cn('flex-1 border-t', isPlainBrand ? 'border-border' : 'border-slate-300/70')} />
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
    </>
  );

  const hero = (subtitle: string, subtitleClass: string) => (
    <div className="text-center mb-8">
      <div className={cn('mb-6', isPlainBrand ? 'flex justify-center' : 'w-full')}>
        <BossMark scale={isPlainBrand ? 2.4 : 1.9} centered={!isPlainBrand} />
      </div>
      <p className={subtitleClass}>{subtitle}</p>
    </div>
  );

  if (isPlainBrand) {
    // Clean standard BOS — flat dark surface, no scene.
    return (
      <div className="min-h-screen bg-surface-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          {hero('Sign in to your account', 'text-sm text-text-muted mt-1')}
          {formBody}
        </div>
      </div>
    );
  }

  // Industry Rockstar white-label — entrance scene + glass panel.
  return (
    <div className="login-entrance-page relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-100 p-4">
      <img
        src={entranceElevatorScene}
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-100"
        style={{ filter: 'brightness(1.12) saturate(1.08) contrast(1.02)' }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.62),rgba(255,255,255,0.16),rgba(15,23,42,0.18))]" aria-hidden="true" />
      <div className="aios-atmosphere-grid absolute inset-0" aria-hidden="true" />
      <div className="login-access-panel relative w-full max-w-sm p-6">
        {hero('Executive access', 'text-sm font-medium text-slate-600 mt-1')}
        {formBody}
      </div>
    </div>
  );
}

export default Login;

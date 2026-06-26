/**
 * SetupWizard — First-Launch Configuration
 *
 * Three-step wizard:
 * 1. Server URL + connection test
 * 2. Authentication (API token or login credentials)
 * 3. Preferences (auto-start, voice, scan paths)
 */

import React, { useState, useCallback } from 'react';

interface SetupWizardProps {
  onComplete: () => void;
}

type Step = 'server' | 'auth' | 'preferences';

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('server');

  // Server step
  const [serverUrl, setServerUrl] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [connectionError, setConnectionError] = useState('');

  // Auth step
  const [authToken, setAuthToken] = useState('');
  const [displayName, setDisplayName] = useState('');

  // Preferences step
  const [autoStart, setAutoStart] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  const testConnection = useCallback(async () => {
    if (!serverUrl.trim()) return;

    setConnectionStatus('testing');
    setConnectionError('');

    try {
      const result = await window.boss.config.testConnection(
        serverUrl.replace(/\/$/, ''),
        authToken || '',
      );

      if (result.ok) {
        setConnectionStatus('success');
      } else {
        setConnectionStatus('error');
        setConnectionError(result.error || 'Connection failed');
      }
    } catch (err: any) {
      setConnectionStatus('error');
      setConnectionError(err.message || 'Connection failed');
    }
  }, [serverUrl, authToken]);

  const handleComplete = useCallback(async () => {
    try {
      await window.boss.config.completeSetup({
        serverUrl: serverUrl.replace(/\/$/, ''),
        authToken,
        displayName: displayName || 'User',
        autoStart,
        voiceEnabled,
      });

      if (autoStart) {
        await window.boss.autostart.enable();
      }

      onComplete();
    } catch (err) {
      console.error('Setup failed:', err);
    }
  }, [serverUrl, authToken, displayName, autoStart, voiceEnabled, onComplete]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-900 p-8">
      <div className="w-full max-w-lg">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">BOS</h1>
          <p className="text-slate-400">Desktop Setup</p>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {(['server', 'auth', 'preferences'] as Step[]).map((s, i) => (
            <React.Fragment key={s}>
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  step === s
                    ? 'bg-blue-600 text-white'
                    : ['server', 'auth', 'preferences'].indexOf(step) > i
                      ? 'bg-blue-800 text-blue-200'
                      : 'bg-slate-700 text-slate-400'
                }`}
              >
                {i + 1}
              </div>
              {i < 2 && (
                <div className={`w-12 h-0.5 ${
                  ['server', 'auth', 'preferences'].indexOf(step) > i
                    ? 'bg-blue-600'
                    : 'bg-slate-700'
                }`} />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Card */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
          {/* Step 1: Server URL */}
          {step === 'server' && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Connect to Server</h2>
              <p className="text-sm text-slate-400 mb-6">
                Enter your BOS server URL. This is where the dashboard and API are hosted.
              </p>

              <label className="block text-sm font-medium text-slate-300 mb-2">
                Server URL
              </label>
              <input
                type="url"
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setConnectionStatus('idle');
                }}
                placeholder="https://your-server.example.com/boss"
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 mb-4"
              />

              <button
                onClick={testConnection}
                disabled={!serverUrl.trim() || connectionStatus === 'testing'}
                className="w-full px-4 py-2 bg-slate-700 text-slate-200 rounded-lg hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-4"
              >
                {connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
              </button>

              {connectionStatus === 'success' && (
                <div className="flex items-center gap-2 p-3 bg-green-900/30 border border-green-800 rounded-lg text-green-400 text-sm mb-4">
                  <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Connected successfully
                </div>
              )}

              {connectionStatus === 'error' && (
                <div className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm mb-4">
                  <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  {connectionError || 'Connection failed'}
                </div>
              )}

              <button
                onClick={() => setStep('auth')}
                disabled={!serverUrl.trim()}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                Next
              </button>
            </div>
          )}

          {/* Step 2: Authentication */}
          {step === 'auth' && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Authentication</h2>
              <p className="text-sm text-slate-400 mb-6">
                Enter your BOS API token to authenticate the desktop app.
              </p>

              <label className="block text-sm font-medium text-slate-300 mb-2">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 mb-4"
              />

              <label className="block text-sm font-medium text-slate-300 mb-2">
                API Token
              </label>
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="paste your BOSS_API_TOKEN here"
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 mb-6 font-mono text-sm"
              />

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('server')}
                  className="flex-1 px-4 py-2 bg-slate-700 text-slate-200 rounded-lg hover:bg-slate-600 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep('preferences')}
                  disabled={!authToken.trim()}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Preferences */}
          {step === 'preferences' && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Preferences</h2>
              <p className="text-sm text-slate-400 mb-6">
                Configure desktop-specific features. You can change these later in settings.
              </p>

              <div className="space-y-4 mb-6">
                {/* Auto-start toggle */}
                <label className="flex items-center justify-between cursor-pointer group">
                  <div>
                    <span className="text-sm font-medium text-slate-200 group-hover:text-white transition-colors">
                      Start with Windows
                    </span>
                    <p className="text-xs text-slate-500">Launch BOS when you log in</p>
                  </div>
                  <div
                    onClick={() => setAutoStart(!autoStart)}
                    className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer ${
                      autoStart ? 'bg-blue-600' : 'bg-slate-600'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                        autoStart ? 'translate-x-5.5 left-0.5' : 'left-0.5'
                      }`}
                      style={{ transform: autoStart ? 'translateX(20px)' : 'translateX(0)' }}
                    />
                  </div>
                </label>

                {/* Voice toggle */}
                <label className="flex items-center justify-between cursor-pointer group">
                  <div>
                    <span className="text-sm font-medium text-slate-200 group-hover:text-white transition-colors">
                      Always-listening voice
                    </span>
                    <p className="text-xs text-slate-500">
                      Enable wake-word detection via microphone
                    </p>
                  </div>
                  <div
                    onClick={() => setVoiceEnabled(!voiceEnabled)}
                    className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer ${
                      voiceEnabled ? 'bg-blue-600' : 'bg-slate-600'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform left-0.5`}
                      style={{ transform: voiceEnabled ? 'translateX(20px)' : 'translateX(0)' }}
                    />
                  </div>
                </label>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('auth')}
                  className="flex-1 px-4 py-2 bg-slate-700 text-slate-200 rounded-lg hover:bg-slate-600 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleComplete}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  Launch BOS
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-slate-600 mt-6">
          Starr & Partners LLC / D. Caine Solutions LLC
        </p>
      </div>
    </div>
  );
}

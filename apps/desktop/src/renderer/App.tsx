/**
 * BOS Desktop — Root Application Component
 *
 * On first launch, shows the SetupWizard to configure server URL and auth.
 * Once configured, embeds the BOS web dashboard via iframe and overlays
 * desktop-specific features: voice indicator, file ingest panel, and
 * a native title bar area.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { SetupWizard } from './components/SetupWizard';
import { FileIngest } from './components/FileIngest';
import { VoiceIndicator } from './components/VoiceIndicator';

type View = 'loading' | 'setup' | 'dashboard';
type Panel = 'none' | 'files' | 'settings';

export function App() {
  const [view, setView] = useState<View>('loading');
  const [serverUrl, setServerUrl] = useState('');
  const [activePanel, setActivePanel] = useState<Panel>('none');
  const [appVersion, setAppVersion] = useState('');

  // Check setup status on mount
  useEffect(() => {
    async function init() {
      try {
        const complete = await window.boss.config.isSetupComplete();
        if (complete) {
          const url = (await window.boss.config.get('serverUrl')) as string;
          setServerUrl(url);
          setView('dashboard');
        } else {
          setView('setup');
        }

        const version = await window.boss.getVersion();
        setAppVersion(version);
      } catch (err) {
        console.error('Init failed:', err);
        setView('setup');
      }
    }
    init();
  }, []);

  // Listen for tray navigation events
  useEffect(() => {
    const removeNav = window.boss.onNavigate((route) => {
      if (route === 'settings') {
        setActivePanel('settings');
      }
    });

    const removeAction = window.boss.onAction((action) => {
      if (action === 'runScan') {
        setActivePanel('files');
      }
    });

    return () => {
      removeNav();
      removeAction();
    };
  }, []);

  const handleSetupComplete = useCallback(async () => {
    const url = (await window.boss.config.get('serverUrl')) as string;
    setServerUrl(url);
    setView('dashboard');
  }, []);

  const handleResetSetup = useCallback(async () => {
    await window.boss.config.reset();
    setServerUrl('');
    setView('setup');
  }, []);

  // Loading state
  if (view === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-900">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 border-3 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Loading BOS...</p>
        </div>
      </div>
    );
  }

  // Setup wizard
  if (view === 'setup') {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  // Main dashboard view
  const dashboardUrl = serverUrl.replace(/\/$/, '');

  return (
    <div className="flex flex-col h-screen bg-slate-900 overflow-hidden">
      {/* Title bar area */}
      <header className="flex items-center justify-between px-4 h-10 bg-slate-800 border-b border-slate-700 no-select shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-200">BOS</span>
          {appVersion && (
            <span className="text-xs text-slate-500">v{appVersion}</span>
          )}
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <VoiceIndicator />

          <button
            onClick={() => setActivePanel(activePanel === 'files' ? 'none' : 'files')}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              activePanel === 'files'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
            }`}
            title="File Scanner"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </button>

          <button
            onClick={handleResetSetup}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors"
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Dashboard iframe */}
        <div className="flex-1 relative">
          <iframe
            src={dashboardUrl}
            className="absolute inset-0 w-full h-full border-0"
            title="BOS Dashboard"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="microphone; camera"
          />
        </div>

        {/* Side panel (file ingest / settings) */}
        {activePanel !== 'none' && (
          <div className="w-96 bg-slate-800 border-l border-slate-700 overflow-y-auto shrink-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h2 className="text-sm font-semibold text-slate-200">
                {activePanel === 'files' ? 'File Scanner' : 'Settings'}
              </h2>
              <button
                onClick={() => setActivePanel('none')}
                className="text-slate-400 hover:text-slate-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {activePanel === 'files' && <FileIngest />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * VoiceIndicator — Microphone Status & Always-Listening Toggle
 *
 * Compact indicator that lives in the title bar. Shows:
 * - Idle: gray mic icon
 * - Listening: pulsing blue dot + mic
 * - Processing: animated waveform bars
 * - Error: red mic icon
 *
 * Click to toggle voice on/off. Syncs with system tray status.
 */

import React, { useState, useEffect, useCallback } from 'react';

type Status = 'idle' | 'listening' | 'processing' | 'error';

export function VoiceIndicator() {
  const [status, setStatus] = useState<Status>('idle');
  const [lastTranscription, setLastTranscription] = useState('');
  const [showTranscription, setShowTranscription] = useState(false);

  // Fetch initial status and subscribe to changes
  useEffect(() => {
    async function init() {
      try {
        const voiceStatus = await window.boss.voice.getStatus();
        if (voiceStatus.isProcessing) {
          setStatus('processing');
        } else if (voiceStatus.isListening) {
          setStatus('listening');
        } else {
          setStatus('idle');
        }
      } catch {
        setStatus('idle');
      }
    }
    init();

    const removeStatusListener = window.boss.voice.onStatusChanged((newStatus) => {
      setStatus(newStatus as Status);
      // Sync tray icon
      window.boss.tray.setVoiceStatus(newStatus);
    });

    const removeTranscriptionListener = window.boss.voice.onTranscription((text) => {
      setLastTranscription(text);
      setShowTranscription(true);
      // Auto-hide after 4 seconds
      setTimeout(() => setShowTranscription(false), 4000);
    });

    const removeToggleListener = window.boss.voice.onToggle(() => {
      handleToggle();
    });

    return () => {
      removeStatusListener();
      removeTranscriptionListener();
      removeToggleListener();
    };
  }, []);

  const handleToggle = useCallback(async () => {
    try {
      const isNowListening = await window.boss.voice.toggle();
      setStatus(isNowListening ? 'listening' : 'idle');
      window.boss.tray.setVoiceStatus(isNowListening ? 'listening' : 'idle');
    } catch {
      setStatus('error');
    }
  }, []);

  return (
    <div className="relative flex items-center">
      {/* Transcription popup */}
      {showTranscription && lastTranscription && (
        <div className="absolute right-0 top-full mt-2 z-50 max-w-64 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg shadow-xl text-xs text-slate-200 whitespace-nowrap overflow-hidden text-ellipsis">
          <span className="text-slate-500 mr-1">Heard:</span>
          {lastTranscription}
        </div>
      )}

      {/* Voice toggle button */}
      <button
        onClick={handleToggle}
        className={`relative flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
          status === 'listening'
            ? 'text-blue-400 hover:bg-blue-900/30'
            : status === 'processing'
              ? 'text-amber-400 hover:bg-amber-900/30'
              : status === 'error'
                ? 'text-red-400 hover:bg-red-900/30'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700'
        }`}
        title={
          status === 'listening'
            ? 'Voice active - click to stop'
            : status === 'processing'
              ? 'Processing voice command...'
              : status === 'error'
                ? 'Voice error - click to retry'
                : 'Click to start voice'
        }
      >
        {/* Status dot */}
        {status === 'listening' && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-blue-500 rounded-full voice-pulse" />
        )}

        {/* Mic icon or waveform */}
        {status === 'processing' ? (
          <WaveformBars />
        ) : (
          <MicIcon status={status} />
        )}

        {/* Status label */}
        <span className="text-xs hidden sm:inline">
          {status === 'listening' && 'Listening'}
          {status === 'processing' && 'Processing'}
          {status === 'error' && 'Error'}
        </span>
      </button>
    </div>
  );
}

/** Microphone SVG icon */
function MicIcon({ status }: { status: Status }) {
  const isOff = status === 'idle';

  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z"
      />
      {/* Strike-through line when idle */}
      {isOff && (
        <line x1="4" y1="4" x2="20" y2="20" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** Animated waveform bars for processing state */
function WaveformBars() {
  return (
    <div className="flex items-center gap-0.5 h-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="w-0.5 bg-amber-400 rounded-full wave-bar"
          style={{
            animationDelay: `${i * 0.15}s`,
            height: '8px',
          }}
        />
      ))}
    </div>
  );
}

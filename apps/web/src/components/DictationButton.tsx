/**
 * DictationButton — push-to-talk mic for chat inputs.
 *
 * Records mic audio via MediaRecorder, posts to /api/voice/transcribe,
 * and pushes the transcript back to the parent through onTranscript.
 * Designed to be dropped next to any <textarea> (COO ChatPane,
 * RascalWorkspace, Outsiders) so each agent can be talked to instead of
 * typed at.
 *
 * States:
 *   idle        → click to start
 *   recording   → red pulse, click to stop and transcribe
 *   transcribing → spinner while STT round-trips
 *   error       → brief red flash, returns to idle
 */

import React, { useCallback, useRef, useState } from 'react';
import { Mic, Square, Loader2, MicOff } from 'lucide-react';

type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

interface DictationButtonProps {
  /** Called with the final transcript when STT returns. Receiver decides
   *  whether to append, replace, or auto-send. */
  onTranscript: (text: string) => void;
  /** Show a smaller variant for tight chat inputs. Default true. */
  compact?: boolean;
  /** Skip rendering when MediaRecorder unavailable (Safari pre-14, etc). */
  hideIfUnsupported?: boolean;
  /** Optional className for outer button. */
  className?: string;
  /** Optional title override for tooltip. */
  title?: string;
  /** Disable the button (e.g., while sending). */
  disabled?: boolean;
}

const supported =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getUserMedia === 'function' &&
  typeof window.MediaRecorder !== 'undefined';

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function transcribe(audioBlob: Blob): Promise<string> {
  const buf = await audioBlob.arrayBuffer();
  const audio = bufferToBase64(buf);
  const audioFormat = audioBlob.type || 'audio/webm';
  const ext = audioFormat.includes('webm') ? 'webm'
    : audioFormat.includes('ogg') ? 'ogg'
    : audioFormat.includes('mp4') ? 'm4a'
    : audioFormat.includes('wav') ? 'wav'
    : 'audio';
  const res = await fetch('api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ audio, audioFormat, filename: `voice.${ext}` }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Transcribe ${res.status}: ${txt.slice(0, 120)}`);
  }
  const data = await res.json() as { transcript?: string };
  return (data.transcript ?? '').trim();
}

export function DictationButton({
  onTranscript,
  compact = true,
  hideIfUnsupported = true,
  className = '',
  title,
  disabled,
}: DictationButtonProps) {
  const [state, setState] = useState<DictationState>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const stopMicTracks = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      streamRef.current = null;
    }
  };

  const start = useCallback(async () => {
    if (!supported) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Pick a mime type the browser actually supports
      const tryTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      let mimeType = '';
      for (const t of tryTypes) {
        if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(t)) {
          mimeType = t;
          break;
        }
      }
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onerror = (e) => {
        console.warn('[DictationButton] recorder error', e);
        setErrMsg('mic error');
        setState('error');
        setTimeout(() => { setState('idle'); setErrMsg(null); }, 1500);
        stopMicTracks();
      };
      rec.onstop = async () => {
        stopMicTracks();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) {
          setState('idle');
          return;
        }
        setState('transcribing');
        try {
          const text = await transcribe(blob);
          if (text) onTranscript(text);
          setState('idle');
        } catch (err) {
          console.warn('[DictationButton] transcribe failed', err);
          setErrMsg(err instanceof Error ? err.message : 'transcribe failed');
          setState('error');
          setTimeout(() => { setState('idle'); setErrMsg(null); }, 1800);
        }
      };

      rec.start();
      setState('recording');
    } catch (err) {
      console.warn('[DictationButton] mic permission denied', err);
      setErrMsg('mic blocked');
      setState('error');
      setTimeout(() => { setState('idle'); setErrMsg(null); }, 1800);
      stopMicTracks();
    }
  }, [onTranscript]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
  }, []);

  const onClick = () => {
    if (disabled) return;
    if (state === 'idle') void start();
    else if (state === 'recording') stop();
  };

  if (!supported) {
    if (hideIfUnsupported) return null;
    return (
      <button
        type="button"
        disabled
        className={`p-2 rounded-[10px] border border-white/10 opacity-50 ${className}`}
        title="Mic not supported in this browser"
        aria-label="Mic not supported"
      >
        <MicOff className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} aria-hidden />
      </button>
    );
  }

  const size = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const label =
    state === 'idle'        ? (title ?? 'Dictate (push-to-talk)')
    : state === 'recording' ? 'Stop recording'
    : state === 'transcribing' ? 'Transcribing…'
    : (errMsg ?? 'Error');

  const bg =
    state === 'recording'    ? 'bg-red-500/85 border-red-400 text-white animate-pulse'
    : state === 'transcribing' ? 'bg-amber-500/30 border-amber-400/60 text-amber-100'
    : state === 'error'      ? 'bg-red-500/30 border-red-400/60 text-red-100'
    :                          'bg-white/5 hover:bg-white/10 border-white/10 text-text-secondary';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || state === 'transcribing'}
      title={label}
      aria-label={label}
      data-dictation-state={state}
      className={`p-2 rounded-[10px] border transition-colors flex-shrink-0 ${bg} ${className}`}
    >
      {state === 'recording' ? <Square className={size} aria-hidden />
        : state === 'transcribing' ? <Loader2 className={`${size} animate-spin`} aria-hidden />
        : <Mic className={size} aria-hidden />}
    </button>
  );
}

export default DictationButton;

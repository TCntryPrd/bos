/**
 * VoiceControl — always-on conversational voice interface.
 *
 * Mute/unmute toggle. When active, mic stays hot — continuous listening.
 * All speech goes to the brain (no client-side intent matching).
 * Brain decides what to do: answer directly, navigate, route to agent.
 * Response is spoken via TTS, then mic auto-resumes listening.
 *
 * Flow: listening → processing → speaking → listening (loop)
 * Mute toggle controls the entire lifecycle.
 *
 * Placement: embedded in the NavRail footer next to the user tile
 * (v1.5.7+, per the v2 design). The component renders in-flow as a
 * compact mic button; the conversation bubble is anchored relative to
 * the button and floats out of the rail into the main canvas when
 * active. No longer mounts as a fixed-position floating mic.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, MicOff, Loader2, Volume2 } from 'lucide-react';
import { dispatchUICommand, type UICommandPayload } from '../lib/ui-commands';

type VoicePhase = 'listening' | 'processing' | 'speaking';

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition;
    webkitSpeechRecognition: typeof SpeechRecognition;
  }
}

const speechSupported =
  typeof window !== 'undefined' &&
  !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// Idle background music = the user's OWN Spotify (already connected). Voice control
// resumes playback when active and ducks the volume while BOS is processing or
// speaking. Kevin prefers music to silence.
const MUSIC_VOLUME = 55;          // % — idle / listening
const MUSIC_VOLUME_DUCKED = 12;   // % — while BOS processes or speaks

function bearer(): Record<string, string> {
  const t = localStorage.getItem('boss_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}
// Short-lived cache of the Spotify access token (for direct volume control).
let _spfTok: { tok: string; exp: number } | null = null;
async function spotifyToken(): Promise<string | null> {
  if (_spfTok && Date.now() < _spfTok.exp) return _spfTok.tok;
  try {
    const r = await fetch('api/connectors/spotify/token', { headers: bearer() });
    if (!r.ok) return null;
    const d = await r.json() as { accessToken?: string };
    if (!d.accessToken) return null;
    _spfTok = { tok: d.accessToken, exp: Date.now() + 45_000 };
    return d.accessToken;
  } catch { return null; }
}
async function spotifyAction(action: 'play' | 'pause'): Promise<void> {
  try {
    await fetch('api/connectors/spotify/playback', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer() },
      body: JSON.stringify({ action }),
    });
  } catch { /* no active device / not premium — ignore */ }
}
async function spotifyVolume(pct: number): Promise<void> {
  const tok = await spotifyToken();
  if (!tok) return;
  try {
    await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${pct}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${tok}` },
    });
  } catch { /* ignore */ }
}

interface ConversationTurn {
  role: 'user' | 'boss';
  text: string;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function VoiceControl() {
  const navigate = useNavigate();

  // Core state
  const [active, setActive] = useState(false);        // mute/unmute toggle
  const [phase, setPhase] = useState<VoicePhase>('listening');
  const [transcript, setTranscript] = useState('');    // current interim speech
  const [history, setHistory] = useState<ConversationTurn[]>([]);

  // Refs for cleanup
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef(false);                     // mirrors `active` for async closures
  const processingRef = useRef(false);                 // prevents double-processing

  // Keep ref in sync
  useEffect(() => { activeRef.current = active; }, [active]);

  // Background music = the user's Spotify. Voice control may resume playback
  // when explicitly activated and duck volume while BOS is busy, but an
  // inactive voice button must not pause whatever the user is already playing.
  useEffect(() => {
    if (active) {
      void spotifyAction('play');
      void spotifyVolume(phase === 'listening' ? MUSIC_VOLUME : MUSIC_VOLUME_DUCKED);
    }
  }, [active, phase]);

  // --- TTS ---
  // Uses /api/voice/synthesize (edge-tts, free) by default. Falls back to
  // /api/tts/synthesize (Google Wavenet, paid — requires GEMINI/GOOGLE_TTS
  // API key) if edge-tts is unavailable. The edge-tts path returns an
  // audioUrl for <audio src=...>; the fallback returns base64 inline.
  const speak = useCallback(async (text: string): Promise<void> => {
    const token = localStorage.getItem('boss_token') ?? '';
    const clean = stripMarkdown(text).substring(0, 4000);
    if (!clean) return;

    const playUrl = async (src: string) => {
      const audio = new Audio(src);
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => { audioRef.current = null; resolve(); };
        audio.onerror = () => { audioRef.current = null; resolve(); };
        audio.play().catch(() => resolve());
      });
    };

    // Primary: edge-tts (free, docker-local).
    try {
      const res = await fetch('api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: clean }),
      });
      if (res.ok) {
        const data = await res.json() as { audioUrl?: string };
        if (data.audioUrl) {
          await playUrl(data.audioUrl);
          return;
        }
      }
    } catch { /* fall through to paid fallback */ }

    // Fallback: Google Cloud TTS via paid route. Kept for Wavenet-quality
    // when needed, or when edge-tts container is down.
    try {
      const res = await fetch('api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: clean }),
      });
      if (!res.ok) return;
      const data = await res.json();
      await playUrl(`data:audio/mp3;base64,${data.audio}`);
    } catch { /* silent — TTS is non-critical to the conversation loop */ }
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* noop */ }
      audioRef.current = null;
    }
  }, []);

  // --- Brain ---
  const askBrain = useCallback(async (message: string): Promise<{
    reply: string;
    navigate?: string;
    uiCommands: UICommandPayload[];
  }> => {
    const token = localStorage.getItem('boss_token') ?? '';
    const authH: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      // Voice logs to the SHARED "General Discussion" thread — same conversation
      // as the Orb and the COO surface. Resolve it (create if missing), then send
      // through the COO chat path so the turn is persisted + executed by BOS.
      const listRes = await fetch('api/coo/threads', { headers: authH });
      const threads = listRes.ok ? (await listRes.json()) as Array<{ id: string; name: string }> : [];
      let gd = threads.find((t) => t.name === 'General Discussion');
      if (!gd) {
        const createRes = await fetch('api/coo/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authH },
          body: JSON.stringify({ name: 'General Discussion', workspace_dir: '/home/tcntryprd/boss-dev' }),
        });
        gd = await createRes.json() as { id: string; name: string };
      }
      const res = await fetch(`api/coo/threads/${gd!.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ message }),
      });
      if (!res.body) return { reply: 'Got it.', uiCommands: [] };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let reply = '';
      let evt = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            evt = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (evt === 'frame') {
                for (const block of data.message?.content ?? []) {
                  if (block.type === 'text' && block.text) reply += block.text;
                }
              } else if (evt === 'error') reply = `Error: ${data.message || 'Something went wrong'}`;
            } catch { /* skip */ }
            evt = '';
          }
        }
      }
      return { reply: reply || 'Got it.', uiCommands: [] };
    } catch {
      return { reply: "Can't reach BOS right now.", uiCommands: [] };
    }
  }, []);

  // --- Cleanup on mute: tell backend to tear down voice agent sessions ---
  const cleanupVoiceSessions = useCallback(async () => {
    const token = localStorage.getItem('boss_token') ?? '';
    try {
      await fetch('api/voice/sessions/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch { /* best effort */ }
  }, []);

  // --- Recognition loop ---
  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    if (!speechSupported || !activeRef.current) return;
    if (processingRef.current) return;

    stopRecognition();
    setPhase('listening');
    setTranscript('');

    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    recognitionRef.current = rec;

    let finalText = '';
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      // After 2 seconds of silence with accumulated text, process it
      silenceTimer = setTimeout(() => {
        if (finalText.trim() && activeRef.current && !processingRef.current) {
          rec.stop();
        }
      }, 2000);
    };

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      finalText = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interim += event.results[i][0].transcript;
      }
      setTranscript(finalText + interim);
      if (finalText || interim) resetSilenceTimer();
    };

    rec.onend = () => {
      recognitionRef.current = null;
      if (silenceTimer) clearTimeout(silenceTimer);

      // Wake-word gate: only act when addressed to "BOS". Everything else is
      // ignored so the music keeps playing (Kevin prefers music to silence).
      const raw = finalText.trim();
      const wm = raw.match(/\bboss\b[\s,:.!?-]*(.*)/i);
      const text = wm ? (wm[1].trim() || '') : '';
      if (text && activeRef.current && !processingRef.current) {
        processingRef.current = true;
        setPhase('processing');
        setHistory(prev => [...prev.slice(-8), { role: 'user', text }]);
        setTranscript('');

        void (async () => {
          const { reply, navigate: navRoute, uiCommands } = await askBrain(text);
          if (!activeRef.current) { processingRef.current = false; return; }

          // Dispatch any UI commands from the brain. Append failure messages
          // to the spoken reply so the user hears why it didn't work.
          let combinedReply = reply;
          for (const cmd of uiCommands) {
            const res = await dispatchUICommand(cmd);
            if (!res.ok) combinedReply += ` ${res.message}`;
          }

          setHistory(prev => [...prev.slice(-8), { role: 'boss', text: combinedReply }]);

          if (navRoute) navigate(navRoute);

          setPhase('speaking');
          await speak(combinedReply);
          processingRef.current = false;

          // Auto-resume listening after speaking
          if (activeRef.current) startListening();
        })();
      } else if (activeRef.current && !processingRef.current) {
        // No speech detected but still active — restart listening
        setTimeout(() => {
          if (activeRef.current && !processingRef.current) startListening();
        }, 300);
      }
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      recognitionRef.current = null;
      if (silenceTimer) clearTimeout(silenceTimer);
      // 'no-speech' is normal — just restart
      if (e.error === 'no-speech' && activeRef.current && !processingRef.current) {
        setTimeout(() => {
          if (activeRef.current && !processingRef.current) startListening();
        }, 300);
        return;
      }
      // 'aborted' happens on manual stop — ignore
      if (e.error === 'aborted') return;
      // Other errors — log and restart
      console.warn('Voice recognition error:', e.error);
      setTimeout(() => {
        if (activeRef.current && !processingRef.current) startListening();
      }, 1000);
    };

    try { rec.start(); } catch { /* noop */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askBrain, navigate, speak, stopRecognition]);

  // --- Toggle handler ---
  const handleToggle = useCallback(() => {
    if (active) {
      // Muting — tear everything down
      setActive(false);
      stopRecognition();
      stopAudio();
      processingRef.current = false;
      setTranscript('');
      void cleanupVoiceSessions();
    } else {
      // Unmuting — start the conversation loop
      if (!speechSupported) return;
      setActive(true);
      setHistory([]);
      // startListening will be triggered by the useEffect below
    }
  }, [active, stopRecognition, stopAudio, cleanupVoiceSessions]);

  // Start listening when toggled on
  useEffect(() => {
    if (active) {
      startListening();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Cleanup on unmount
  useEffect(() => () => {
    activeRef.current = false;
    stopRecognition();
    stopAudio();
  }, [stopRecognition, stopAudio]);

  // --- Render ---
  const icon = !active
    ? (speechSupported ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />)
    : phase === 'listening' ? <Mic className="w-4 h-4" />
    : phase === 'processing' ? <Loader2 className="w-4 h-4 animate-spin" />
    : <Volume2 className="w-4 h-4" />;

  const buttonColor = !active
    ? 'bg-zinc-700/70 hover:bg-zinc-600'
    : phase === 'listening' ? 'bg-red-500 hover:bg-red-600 animate-pulse shadow-red-500/50'
    : phase === 'processing' ? 'bg-amber-500 hover:bg-amber-600'
    : 'bg-emerald-500 hover:bg-emerald-600';

  // Kevin 2026-06-03: no visible dictate/transcript box — voice is hands-free
  // (listens + speaks). Keep `transcript`/`history` referenced to satisfy lint.
  const showBubble = false && active && (transcript || history.length > 0);

  return (
    <div
      className="relative inline-flex"
      data-testid="voice-control"
    >
      {showBubble && (
        <div
          className="absolute left-full bottom-0 ml-3 w-[320px] max-h-64 overflow-y-auto rounded-xl bg-surface-2 border border-border shadow-lg px-4 py-3 text-sm space-y-1.5 pointer-events-auto z-[60]"
          role="log"
          aria-live="polite"
        >
          {history.slice(-6).map((turn, i) => (
            <div key={i} className={turn.role === 'user' ? 'text-text-secondary' : 'text-text-primary'}>
              <span className="text-xs uppercase tracking-wide text-text-muted mr-2">
                {turn.role === 'user' ? 'You' : 'BOS'}
              </span>
              {turn.text.length > 300 ? turn.text.slice(0, 300) + '\u2026' : turn.text}
            </div>
          ))}
          {transcript && (
            <div className="text-text-secondary italic">
              <span className="text-xs uppercase tracking-wide text-text-muted mr-2">You</span>
              {transcript}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={handleToggle}
        className={`text-white rounded-full w-8 h-8 flex items-center justify-center shadow-md transition-all ${buttonColor}`}
        aria-label={active ? 'Mute voice control' : 'Unmute voice control'}
        title={active ? 'Mute BOS' : 'Talk to BOS'}
      >
        {icon}
      </button>
    </div>
  );
}

export default VoiceControl;

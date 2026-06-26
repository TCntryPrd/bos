/**
 * SpotifyPlayer — persistent now-playing dock (v1.7.17)
 *
 * Acts as a *remote/control surface* for Spotify, not a player. Polls the
 * Web API for live state across all devices, so opening the dock picks up
 * whatever's playing on your phone, laptop, or smart speaker — same as
 * Last.fm. Transport buttons (prev / play-pause / next) hit the active
 * device via /api/connectors/spotify/playback. Switching playlists from
 * the search dropdown calls the same endpoint with `play` + context_uri.
 *
 * No iframe. Minimizing the dock has zero effect on playback because we
 * don't host playback — Spotify does, on the device you were already
 * using. The collapsed glyph keeps polling so the green ring still
 * reflects play state.
 *
 * Position: fixed bottom-right, draggable resize from top-left corner.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Music, Search, Plug, AlertTriangle, ChevronDown,
  Play, Pause, SkipBack, SkipForward, MonitorSpeaker, Volume2,
} from 'lucide-react';

const URI_KEY = 'boss_spotify_uri';
const OPEN_KEY = 'boss_spotify_open';
const SIZE_KEY = 'boss_spotify_size';
const POSITION_KEY = 'boss_spotify_position';

const MIN_W = 300;
const MAX_W = 720;
const DEFAULT_W = 380;
const POLL_MS = 3000;
const COLLAPSED_SIZE = 44;
const EDGE = 16;

interface Playlist {
  id: string; name: string; uri: string; image: string | null; owner: string; trackCount: number;
}

interface Track {
  uri: string; name: string; durationMs: number;
  albumName: string; albumUri: string; image: string | null;
  artists: string[];
}

interface Device {
  id: string; name: string; type: string; isActive: boolean; volume: number;
}

interface NowPlaying {
  source: 'current' | 'recent';
  isPlaying: boolean;
  progressMs: number;
  timestamp: number; // server-side timestamp when the snapshot was taken
  shuffle: boolean;
  repeat: string;
  context: { uri: string; type: string } | null;
  track: Track | null;
  device: Device | null;
}

interface StatusInfo { configured: boolean; connected: boolean }
interface DockPosition { x: number; y: number }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readSize(): number {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.w === 'number') return Math.max(MIN_W, Math.min(MAX_W, p.w));
    }
  } catch { /* ignore */ }
  return DEFAULT_W;
}

function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === 'true'; } catch { return false; }
}

function defaultPosition(width = DEFAULT_W): DockPosition {
  if (typeof window === 'undefined') return { x: EDGE, y: EDGE };
  return {
    x: window.innerWidth - width - EDGE,
    y: window.innerHeight - 230,
  };
}

function readPosition(width = DEFAULT_W): DockPosition {
  const fallback = defaultPosition(width);
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DockPosition>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return fallback;
    return {
      x: clamp(parsed.x, EDGE, window.innerWidth - COLLAPSED_SIZE - EDGE),
      y: clamp(parsed.y, EDGE, window.innerHeight - COLLAPSED_SIZE - EDGE),
    };
  } catch {
    return fallback;
  }
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

async function fetchStatus(): Promise<StatusInfo | null> {
  try {
    const r = await fetch('api/connectors/spotify/status', { headers: authHeaders() });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchNowPlaying(): Promise<NowPlaying | null> {
  try {
    const r = await fetch('api/connectors/spotify/now-playing', { headers: authHeaders() });
    if (r.status === 204 || !r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchPlaylists(): Promise<Playlist[]> {
  const r = await fetch('api/connectors/spotify/playlists', { headers: authHeaders() });
  if (!r.ok) throw new Error(`playlists ${r.status}`);
  const data = await r.json() as { playlists: Playlist[] };
  return data.playlists;
}

async function fetchDevices(): Promise<Device[]> {
  const r = await fetch('api/connectors/spotify/devices', { headers: authHeaders() });
  if (!r.ok) return [];
  const data = await r.json() as { devices: Device[] };
  return data.devices;
}

async function startOAuth(): Promise<void> {
  const r = await fetch('api/connectors/oauth/spotify/start', { headers: authHeaders() });
  if (!r.ok) {
    alert('Spotify OAuth not configured. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI in .env, restart API.');
    return;
  }
  const data = await r.json() as { url: string };
  window.location.href = data.url;
}

async function postPlayback(action: string, uri?: string): Promise<boolean> {
  const r = await fetch('api/connectors/spotify/playback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(uri ? { action, uri } : { action }),
  });
  return r.ok;
}

function playUriForSnapshot(snapshot: NowPlaying): string | undefined {
  if (snapshot.source === 'recent') return snapshot.context?.uri ?? snapshot.track?.uri;
  return undefined;
}

export function SpotifyPlayer() {
  const [open, setOpen] = useState(readOpen);
  const [width, setWidth] = useState(readSize);
  const [position, setPosition] = useState<DockPosition>(() => readPosition(readSize()));
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [picking, setPicking] = useState(false);
  const [showingDevices, setShowingDevices] = useState(false);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(0); // interpolated progress ms
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resizeState = useRef<{ startX: number; startW: number } | null>(null);
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const lastPollRef = useRef<{ progressMs: number; isPlaying: boolean; at: number }>({ progressMs: 0, isPlaying: false, at: 0 });

  // persist open + size
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, String(open)); } catch { /* ignore */ } }, [open]);
  useEffect(() => { try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: width })); } catch { /* ignore */ } }, [width]);
  useEffect(() => { try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* ignore */ } }, [position]);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setPosition((pos) => ({
        x: clamp(pos.x, EDGE, window.innerWidth - COLLAPSED_SIZE - EDGE),
        y: clamp(pos.y, EDGE, window.innerHeight - COLLAPSED_SIZE - EDGE),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await fetchStatus();
    setStatus(s);
    return s;
  }, []);

  const pollNow = useCallback(async () => {
    const cur = await fetchNowPlaying();
    if (cur) {
      setNp(cur);
      lastPollRef.current = { progressMs: cur.progressMs ?? 0, isPlaying: cur.isPlaying, at: Date.now() };
      setNowMs(cur.progressMs ?? 0);
      // Persist last URI for fallback "play" if device empty
      if (cur.context?.uri) {
        try { localStorage.setItem(URI_KEY, cur.context.uri); } catch { /* ignore */ }
      } else if (cur.track?.uri) {
        try { localStorage.setItem(URI_KEY, cur.track.uri); } catch { /* ignore */ }
      }
    }
  }, []);

  const loadAux = useCallback(async () => {
    try {
      const [pl, dv] = await Promise.all([fetchPlaylists(), fetchDevices()]);
      setPlaylists(pl);
      setDevices(dv);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Initial bootstrap
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await refreshStatus();
      if (cancelled) return;
      if (s?.connected) {
        await pollNow();
        if (cancelled) return;
        await loadAux();
      }
    })();
    return () => { cancelled = true; };
  }, [refreshStatus, pollNow, loadAux]);

  // OAuth callback detection
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes('oauth=success') && hash.includes('provider=spotify')) {
      const cleaned = hash.replace(/[?&]oauth=success/, '').replace(/[?&]provider=spotify/, '');
      window.history.replaceState(null, '', window.location.pathname + window.location.search + cleaned);
      void (async () => {
        const s = await refreshStatus();
        if (s?.connected) { await pollNow(); await loadAux(); }
      })();
    }
  }, [refreshStatus, pollNow, loadAux]);

  // Poll every POLL_MS while connected (always, even when collapsed, so the
  // glyph ring reflects play state)
  useEffect(() => {
    if (!status?.connected) return;
    const id = window.setInterval(() => { void pollNow(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [status?.connected, pollNow]);

  // Local progress interpolation (smooth bar between polls)
  useEffect(() => {
    if (!np || !np.isPlaying) return;
    const id = window.setInterval(() => {
      const last = lastPollRef.current;
      const elapsed = Date.now() - last.at;
      setNowMs(Math.min((np.track?.durationMs ?? 0), last.progressMs + elapsed));
    }, 250);
    return () => window.clearInterval(id);
  }, [np]);

  // Pause/resume polling on tab visibility — don't drain phone batteries
  // while in another tab.
  useEffect(() => {
    if (!status?.connected) return;
    const onVis = () => { if (!document.hidden) void pollNow(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [status?.connected, pollNow]);

  // Resize handle
  const onResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeState.current = { startX: e.clientX, startW: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [width]);
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeState.current;
    if (!r) return;
    e.preventDefault();
    setWidth(Math.max(MIN_W, Math.min(MAX_W, r.startW + (r.startX - e.clientX))));
  }, []);
  const onResizeUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    resizeState.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const startDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [position.x, position.y]);

  const moveDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setPosition({
      x: clamp(drag.originX + dx, EDGE, viewport.w - COLLAPSED_SIZE - EDGE),
      y: clamp(drag.originY + dy, EDGE, viewport.h - COLLAPSED_SIZE - EDGE),
    });
  }, [viewport.h, viewport.w]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  // Transport handlers
  const onPlayPause = async () => {
    if (!np) return;
    const ok = await postPlayback(np.isPlaying ? 'pause' : 'play', np.isPlaying ? undefined : playUriForSnapshot(np));
    if (!ok) {
      setErr('Playback failed — open Spotify on a device first.');
      return;
    }
    setErr(null);
    setTimeout(() => void pollNow(), 350);
  };
  const onPrev = async () => {
    const ok = await postPlayback('previous');
    if (!ok) {
      setErr('Previous failed — open Spotify on a device first.');
      return;
    }
    setErr(null);
    setTimeout(() => void pollNow(), 350);
  };
  const onNext = async () => {
    const ok = await postPlayback('next');
    if (!ok) {
      setErr('Next failed — open Spotify on a device first.');
      return;
    }
    setErr(null);
    setTimeout(() => void pollNow(), 350);
  };
  const onPickPlaylist = async (p: Playlist) => {
    setPicking(false); setFilter('');
    const ok = await postPlayback('play', p.uri);
    if (!ok) {
      setErr('Could not start playback. Open Spotify on a device first.');
      return;
    }
    setErr(null);
    setTimeout(() => void pollNow(), 500);
  };
  const onPickDevice = async (d: Device) => {
    setShowingDevices(false);
    await postPlayback('transfer', d.id);
    setTimeout(() => void pollNow(), 600);
  };

  useEffect(() => { if (picking) inputRef.current?.focus(); }, [picking]);

  // Collapsed glyph — colored ring reflects play state
  if (!open) {
    const playing = !!np?.isPlaying;
    return (
      <button
        type="button"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (dragState.current?.moved) {
            dragState.current = null;
            return;
          }
          dragState.current = null;
          setOpen(true);
        }}
        className="fixed z-30 w-11 h-11 rounded-full grid place-items-center transition-transform hover:scale-105"
        style={{
          left: position.x,
          top: position.y,
          touchAction: 'none',
          cursor: 'grab',
          background: 'linear-gradient(135deg, #1ed760 0%, #168f43 100%)',
          boxShadow: playing
            ? '0 0 18px rgba(30,215,96,0.55), 0 4px 16px rgba(0,0,0,0.4)'
            : '0 0 14px rgba(30,215,96,0.30), 0 4px 16px rgba(0,0,0,0.4)',
        }}
        aria-label={`Spotify mini-player${playing ? ' (playing)' : ''}`}
        title={np?.track ? `${playing ? '▶' : '❚❚'} ${np.track.name} · ${np.track.artists.join(', ')}` : 'Spotify'}
      >
        <Music className="w-5 h-5 text-black" aria-hidden />
      </button>
    );
  }

  // Filtered playlists for picker
  const filtered = filter
    ? playlists.filter((p) =>
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        p.owner.toLowerCase().includes(filter.toLowerCase()))
    : playlists;

  const track = np?.track ?? null;
  const ctxLabel = np?.context?.uri
    ? (playlists.find((p) => p.uri === np.context!.uri)?.name ?? `${np.context.type}`)
    : null;
  const progressPct = track && track.durationMs > 0
    ? Math.min(100, (nowMs / track.durationMs) * 100)
    : 0;
  const deviceLabel = np?.device?.name ?? (np?.source === 'recent' ? 'last played' : 'no active device');

  return (
    <div
      className="fixed z-30 rounded-lg border border-border overflow-hidden"
      style={{
        left: clamp(position.x, EDGE, viewport.w - width - EDGE),
        top: clamp(position.y, EDGE, viewport.h - COLLAPSED_SIZE - EDGE),
        width,
        background: 'rgba(12,14,20,0.94)',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.55), 0 0 0 1px rgba(30,215,96,0.18)',
      }}
      role="region"
      aria-label="Spotify now-playing"
    >
      {/* resize handle (top-left) */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={() => setWidth(DEFAULT_W)}
        className="absolute top-0 left-0 z-10 w-4 h-4"
        style={{ cursor: 'nwse-resize', touchAction: 'none' }}
        title="Drag to resize · double-click to reset"
        aria-label="Resize player"
      >
        <span aria-hidden className="absolute top-1 left-1 w-2 h-2"
          style={{ borderTop: '2px solid rgba(30,215,96,0.7)', borderLeft: '2px solid rgba(30,215,96,0.7)', borderTopLeftRadius: 2 }}
        />
      </div>

      {/* header */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ cursor: 'grab', touchAction: 'none' }}
        title="Drag Spotify"
      >
        <Music className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#1ed760' }} aria-hidden />
        <span className="vs-mono text-[10px] uppercase tracking-[0.2em] text-text-muted flex-shrink-0">
          {np?.source === 'recent' ? 'last' : np?.isPlaying ? 'now' : 'paused'}
        </span>
        <span className="flex-1 truncate text-[10.5px] text-text-muted px-1" title={deviceLabel}>
          {deviceLabel}{ctxLabel ? ` · ${ctxLabel}` : ''}
        </span>
        {status?.connected && (
          <>
            <button type="button"
              onClick={() => { setShowingDevices((v) => !v); setPicking(false); void fetchDevices().then(setDevices); }}
              className="p-1 rounded hover:bg-surface-2/40 text-text-muted hover:text-text-secondary"
              aria-label="Devices" title="Switch device"
            ><MonitorSpeaker className="w-3 h-3" aria-hidden /></button>
            <button type="button"
              onClick={() => { setPicking((v) => !v); setShowingDevices(false); }}
              className="p-1 rounded hover:bg-surface-2/40 text-text-muted hover:text-text-secondary"
              aria-label="Switch playlist" title="Switch playlist"
            ><Search className="w-3 h-3" aria-hidden /></button>
          </>
        )}
        <button type="button"
          onClick={() => setOpen(false)}
          className="p-1 rounded hover:bg-surface-2/40 text-text-muted hover:text-text-secondary"
          aria-label="Minimize" title="Minimize (playback continues on Spotify)"
        ><ChevronDown className="w-3.5 h-3.5" aria-hidden /></button>
      </div>

      {/* connection state */}
      {status && !status.configured && (
        <div className="px-2.5 py-2 border-b border-border bg-warning/10 text-warning text-[11px] flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Spotify not configured</div>
            <div className="opacity-80">Set <code className="vs-mono">SPOTIFY_CLIENT_ID</code> / <code className="vs-mono">_SECRET</code> / <code className="vs-mono">_REDIRECT_URI</code> in <code className="vs-mono">.env</code>.</div>
          </div>
        </div>
      )}
      {status?.configured && !status.connected && (
        <div className="px-2.5 py-2 border-b border-border flex items-center gap-2">
          <span className="text-[11px] text-text-muted flex-1">Connect Spotify to see now-playing.</span>
          <button type="button"
            onClick={() => void startOAuth()}
            className="vs-mono text-[10px] uppercase tracking-[0.22em] px-2 py-1 border text-black inline-flex items-center gap-1"
            style={{ background: '#1ed760', borderColor: '#1ed760' }}
          ><Plug className="w-3 h-3" aria-hidden /> Connect</button>
        </div>
      )}
      {err && (
        <div className="px-2.5 py-1.5 border-b border-border bg-danger/10 text-danger text-[11px]" title={err}>
          {err}
        </div>
      )}

      {/* picker — playlists */}
      {picking && status?.connected && (
        <div className="border-b border-border bg-surface-1/40">
          <div className="px-2.5 py-2">
            <input
              ref={inputRef} type="text" value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setPicking(false); setFilter(''); } }}
              placeholder={`Search ${playlists.length} playlists…`}
              className="w-full bg-surface-0 border border-border text-text-primary text-[11.5px] px-2 py-1.5 vs-mono"
            />
          </div>
          <ul className="max-h-[220px] overflow-y-auto px-1 pb-1.5" role="list">
            {filtered.length === 0 && (
              <li className="px-2.5 py-2 text-[11px] text-text-muted italic">
                {playlists.length === 0 ? 'Loading…' : 'No matches'}
              </li>
            )}
            {filtered.slice(0, 80).map((p) => {
              const active = p.uri === np?.context?.uri;
              return (
                <li key={p.id}>
                  <button type="button"
                    onClick={() => void onPickPlaylist(p)}
                    className={'w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left transition-colors ' +
                      (active ? 'bg-surface-2/60' : 'hover:bg-surface-2/40')}
                  >
                    {p.image ? (
                      <img src={p.image} alt="" className="w-6 h-6 rounded-sm flex-shrink-0 object-cover" />
                    ) : (
                      <span className="w-6 h-6 rounded-sm flex-shrink-0 grid place-items-center"
                        style={{ background: 'rgba(30,215,96,0.18)' }}><Music className="w-3 h-3" style={{ color: '#1ed760' }} aria-hidden /></span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12px] text-text-primary truncate">{p.name}</span>
                      <span className="block text-[10px] text-text-muted truncate">{p.owner} · {p.trackCount}</span>
                    </span>
                    {active && <span className="vs-mono text-[9px] uppercase tracking-[0.18em]" style={{ color: '#1ed760' }}>now</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* picker — devices */}
      {showingDevices && status?.connected && (
        <div className="border-b border-border bg-surface-1/40">
          <ul className="max-h-[180px] overflow-y-auto px-1 py-1.5" role="list">
            {devices.length === 0 && (
              <li className="px-2.5 py-2 text-[11px] text-text-muted italic">
                No devices visible. Open Spotify on a phone, laptop, or speaker.
              </li>
            )}
            {devices.map((d) => (
              <li key={d.id}>
                <button type="button"
                  onClick={() => void onPickDevice(d)}
                  className={'w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left transition-colors ' +
                    (d.isActive ? 'bg-surface-2/60' : 'hover:bg-surface-2/40')}
                >
                  <MonitorSpeaker className="w-3.5 h-3.5 flex-shrink-0" style={{ color: d.isActive ? '#1ed760' : '#8a93a7' }} aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12px] text-text-primary truncate">{d.name}</span>
                    <span className="block text-[10px] text-text-muted truncate">{d.type} · vol {d.volume}</span>
                  </span>
                  {d.isActive && <span className="vs-mono text-[9px] uppercase tracking-[0.18em]" style={{ color: '#1ed760' }}>active</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* now-playing body */}
      {status?.connected && track && (
        <div className="px-3 py-3 flex items-center gap-3">
          {track.image ? (
            <img src={track.image} alt="" className="w-14 h-14 rounded-sm flex-shrink-0 object-cover" />
          ) : (
            <span className="w-14 h-14 rounded-sm flex-shrink-0 grid place-items-center"
              style={{ background: 'rgba(30,215,96,0.18)' }}><Music className="w-6 h-6" style={{ color: '#1ed760' }} aria-hidden /></span>
          )}
          <div className="flex-1 min-w-0 leading-tight">
            <div className="text-[13px] font-semibold text-text-primary truncate" title={track.name}>{track.name}</div>
            <div className="text-[11px] text-text-secondary truncate" title={track.artists.join(', ')}>{track.artists.join(', ')}</div>
            <div className="text-[10px] text-text-muted truncate mt-0.5" title={track.albumName}>{track.albumName}</div>
          </div>
        </div>
      )}

      {/* progress + transport */}
      {status?.connected && track && (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex items-center gap-2 vs-mono text-[9.5px] text-text-muted">
            <span className="w-9 text-right tabular-nums">{fmtMs(nowMs)}</span>
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div className="h-full" style={{ width: `${progressPct}%`, background: '#1ed760', transition: 'width 250ms linear' }} />
            </div>
            <span className="w-9 text-left tabular-nums">{fmtMs(track.durationMs)}</span>
          </div>
          <div className="flex items-center justify-center gap-2">
            <button type="button" onClick={() => void onPrev()}
              className="p-1.5 rounded hover:bg-surface-2/40 text-text-secondary hover:text-text-primary" aria-label="Previous">
              <SkipBack className="w-4 h-4" aria-hidden />
            </button>
            <button type="button" onClick={() => void onPlayPause()}
              className="w-9 h-9 rounded-full grid place-items-center text-black transition-transform hover:scale-105"
              style={{ background: '#1ed760', boxShadow: '0 0 10px rgba(30,215,96,0.45)' }}
              aria-label={np?.isPlaying ? 'Pause' : 'Play'}>
              {np?.isPlaying ? <Pause className="w-4 h-4" aria-hidden /> : <Play className="w-4 h-4 ml-0.5" aria-hidden />}
            </button>
            <button type="button" onClick={() => void onNext()}
              className="p-1.5 rounded hover:bg-surface-2/40 text-text-secondary hover:text-text-primary" aria-label="Next">
              <SkipForward className="w-4 h-4" aria-hidden />
            </button>
            {np?.device?.volume !== undefined && (
              <span className="ml-2 inline-flex items-center gap-1 vs-mono text-[9.5px] text-text-muted">
                <Volume2 className="w-3 h-3" aria-hidden />
                {np.device.volume}
              </span>
            )}
          </div>
        </div>
      )}

      {status?.connected && !track && (
        <div className="px-3 py-4 text-center text-[11.5px] text-text-muted">
          Nothing playing. Open Spotify on a device, then refresh.
        </div>
      )}
    </div>
  );
}

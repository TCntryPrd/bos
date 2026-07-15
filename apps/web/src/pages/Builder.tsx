/**
 * Builder console — read-only live view of agent CLI streams.
 * Only bundled/routed when VITE_BUILDER=1 (builder installs); the API side
 * additionally 404s unless BOSS_BUILDER_MODE=1.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface BuilderSession {
  id: string;
  label: string;
  status: 'live' | 'finished' | 'error';
  updatedAt: number;
}

interface StreamLine {
  ts: number;
  line: string;
  status?: string;
}

function token(): string {
  return localStorage.getItem('boss_token') ?? '';
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const statusColor: Record<string, string> = {
  live: 'var(--v-accent, #4ade80)',
  finished: 'var(--v-muted, #9ca3af)',
  error: '#f87171',
};

export default function Builder() {
  const [sessions, setSessions] = useState<BuilderSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const followRef = useRef(true);
  followRef.current = follow;

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/builder/sessions', {
        headers: { Authorization: `Bearer ${token()}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: BuilderSession[] };
      setSessions(data.sessions ?? []);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    const t = setInterval(() => void loadSessions(), 5000);
    return () => clearInterval(t);
  }, [loadSessions]);

  // Stream the selected session over fetch+reader SSE (EventSource can't send auth headers).
  useEffect(() => {
    if (!selected) return;
    setLines([]);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    void (async () => {
      try {
        const res = await fetch(`/api/builder/stream/${encodeURIComponent(selected)}`, {
          headers: { Authorization: `Bearer ${token()}` },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          const batch: StreamLine[] = [];
          for (const frame of frames) {
            for (const fl of frame.split('\n')) {
              if (!fl.startsWith('data: ')) continue;
              try {
                batch.push(JSON.parse(fl.slice(6)) as StreamLine);
              } catch {
                /* skip malformed */
              }
            }
          }
          if (batch.length) {
            setLines((prev) => {
              const next = [...prev, ...batch];
              return next.length > 4000 ? next.slice(-4000) : next;
            });
          }
        }
      } catch {
        /* aborted or network */
      }
    })();

    return () => ctrl.abort();
  }, [selected]);

  useEffect(() => {
    if (followRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const current = sessions.find((s) => s.id === selected);

  return (
    <div className="flex h-full min-h-0">
      {/* Session list */}
      <aside className="w-64 flex-shrink-0 border-r border-border overflow-y-auto p-3 space-y-1">
        <h2 className="text-sm font-semibold mb-2 opacity-70">Agent sessions</h2>
        {sessions.length === 0 && (
          <p className="text-xs opacity-50">No agent streams yet. Sessions appear here as agents run.</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            className={[
              'w-full text-left rounded-md px-2 py-1.5 text-xs transition-colors',
              selected === s.id ? 'bg-white/10' : 'hover:bg-white/5',
            ].join(' ')}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
              style={{ background: statusColor[s.status] ?? '#9ca3af' }}
              title={s.status}
            />
            <span className="font-mono">{s.label}</span>
            <div className="opacity-50 mt-0.5 pl-4">
              {s.status} · {fmtTime(s.updatedAt)}
            </div>
          </button>
        ))}
      </aside>

      {/* Stream view */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs">
          <span className="font-semibold">Builder console</span>
          {current && (
            <>
              <span className="font-mono opacity-70">{current.label}</span>
              <span style={{ color: statusColor[current.status] }}>{current.status}</span>
            </>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 opacity-70 cursor-pointer">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            follow
          </label>
          <span className="opacity-40">read-only</span>
        </div>
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && followRef.current) setFollow(false);
          }}
          className="flex-1 overflow-y-auto overflow-x-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
          style={{ background: 'rgba(0,0,0,0.35)' }}
        >
          {!selected && <p className="opacity-50">Select a session to watch its live stream.</p>}
          {lines.map((l, i) => (
            <div key={i} className={l.status === 'error' ? 'text-red-400' : l.status ? 'opacity-60 italic' : ''}>
              <span className="opacity-35 select-none mr-2">{fmtTime(l.ts)}</span>
              {l.line}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

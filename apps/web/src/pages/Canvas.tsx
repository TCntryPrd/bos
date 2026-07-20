/**
 * Canvas - immersive Miro room surface.
 *
 * The page uses the planning-room background as the physical room and pins the
 * Miro embed over the wall whiteboard. Board switching and collaboration
 * actions sit on the conference table so Canvas stays click/talk first.
 */

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  Frame,
  Layers3,
  Mic2,
  RefreshCw,
  Users,
} from 'lucide-react';

interface MiroBoard {
  id: string;
  name: string;
  description?: string;
  viewLink?: string;
  modifiedAt?: string;
  team?: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

export default function Canvas() {
  const [boards, setBoards] = useState<MiroBoard[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadBoards = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ boards: MiroBoard[]; total: number }>('api/miro/boards?limit=50');
      setBoards(r.boards);
      setActiveId((current) => (
        current && r.boards.some((board) => board.id === current)
          ? current
          : r.boards[0]?.id ?? null
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBoards();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const active = boards.find((board) => board.id === activeId) ?? null;

  const copyInvite = async () => {
    if (!active?.viewLink) return;
    try {
      await navigator.clipboard.writeText(active.viewLink);
      setCopied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not copy invite link');
    }
  };

  const openBoard = () => {
    if (!active?.viewLink) return;
    window.open(active.viewLink, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="canvas-room-page planning-room-page" aria-label="Canvas Miro board room">
      <h1 className="sr-only">Canvas</h1>

      <section className="canvas-whiteboard-window" aria-label="Active Miro board">
        <div className="canvas-whiteboard-plane">
          <div className="canvas-electrical-tape canvas-tape-top-left" aria-hidden />
          <div className="canvas-electrical-tape canvas-tape-top-right" aria-hidden />
          <div className="canvas-board-caption">
            <Frame className="h-3.5 w-3.5" />
            {active?.name ?? (loading ? 'Loading Miro boards' : 'No board selected')}
          </div>
          {active ? (
            <iframe
              key={active.id}
              src={`https://miro.com/app/live-embed/${active.id}/?embedMode=view_only_without_ui&autoplay=false`}
              title={active.name}
              allow="fullscreen; clipboard-read; clipboard-write"
              allowFullScreen
            />
          ) : (
            <div className="canvas-whiteboard-empty">
              {loading ? 'Loading boards...' : 'Choose a board from the table.'}
            </div>
          )}
          <div className="canvas-marker-rail" aria-hidden>
            <span className="is-black" />
            <span className="is-red" />
            <span className="is-blue" />
            <span className="is-green" />
          </div>
        </div>
      </section>

      {error && (
        <div className="canvas-room-error" role="alert">
          <AlertTriangle className="h-4 w-4" />
          <div className="min-w-0">
            <strong>Miro is not ready</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      <section className="canvas-table-console" aria-label="Canvas table controls">
        <div className="canvas-table-header">
          <div>
            <div className="vs-mono canvas-table-kicker">CANVAS TABLE</div>
            <h2>{active?.name ?? 'Choose a board'}</h2>
            <p>
              {active?.team || 'Miro workspace'}
              {active?.modifiedAt ? ` / updated ${formatBoardDate(active.modifiedAt)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadBoards()}
            className="canvas-round-button"
            title="Refresh boards"
            aria-label="Refresh boards"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>

        <div className="canvas-board-strip" aria-label="Switch Miro boards">
          {boards.length > 0 ? (
            boards.slice(0, 10).map((board) => (
              <button
                key={board.id}
                type="button"
                onClick={() => setActiveId(board.id)}
                className={board.id === activeId ? 'canvas-board-note is-active' : 'canvas-board-note'}
              >
                <span>{board.name}</span>
                <small>{board.team || 'Miro'}</small>
              </button>
            ))
          ) : (
            <div className="canvas-board-note is-empty">
              {loading ? 'Syncing boards...' : 'No Miro boards found'}
            </div>
          )}
        </div>

        <div className="canvas-action-row">
          <button
            type="button"
            onClick={copyInvite}
            disabled={!active?.viewLink}
            className="canvas-action-button"
          >
            {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Invite copied' : 'Invite'}
          </button>
          <button
            type="button"
            onClick={openBoard}
            disabled={!active?.viewLink}
            className="canvas-action-button"
          >
            <Users className="h-4 w-4" />
            Collaborate
          </button>
          <button
            type="button"
            onClick={openBoard}
            disabled={!active?.viewLink}
            className="canvas-action-button"
          >
            <Eye className="h-4 w-4" />
            View
          </button>
          <span className="canvas-talk-pill">
            <Mic2 className="h-4 w-4" />
            Click or talk
          </span>
          <span className="canvas-count-pill">
            <Layers3 className="h-4 w-4" />
            {boards.length} boards
          </span>
          {active?.viewLink && (
            <a className="canvas-miro-link" href={active.viewLink} target="_blank" rel="noopener">
              <ExternalLink className="h-4 w-4" />
              Miro
            </a>
          )}
        </div>
      </section>
    </div>
  );
}

function formatBoardDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

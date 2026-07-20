/**
 * Ephemeral live agent activity stream.
 *
 * Stream lines are emitted directly to connected browsers. They are never
 * written to Redis, a database, a file, or a replay buffer. The browser owns
 * the only short-lived line buffer, so refreshing or leaving the page clears
 * everything the operator saw.
 */
import { EventEmitter } from 'node:events';
import { redactLiveOutput } from '../agents/live-output-redaction.js';

const ENABLED = process.env.BOSS_BUILDER_MODE === '1';

export interface BuilderSessionMeta {
  id: string;
  label: string;
  status: 'live' | 'finished' | 'error';
  updatedAt: number;
}

export interface BuilderStreamRecord {
  ts: number;
  sessionId: string;
  label: string;
  line: string;
  mode?: 'line' | 'snapshot';
  status?: 'live' | 'finished' | 'error';
}

const sessions = new Map<string, BuilderSessionMeta>();
const liveBus = new EventEmitter();
liveBus.setMaxListeners(250);

// Keep only lightweight, in-process session labels long enough for the tile to
// discover a run. No terminal output is retained here.
const SESSION_TTL_MS = 15 * 60 * 1000;

function mask(line: string): string {
  return redactLiveOutput(line);
}

function updateSession(sessionId: string, label: string, status: BuilderSessionMeta['status'], updatedAt: number): void {
  sessions.set(sessionId, { id: sessionId, label, status, updatedAt });
}

function emit(sessionId: string, record: Omit<BuilderStreamRecord, 'sessionId' | 'label'>, label: string): void {
  const enriched = { ...record, sessionId, label };
  liveBus.emit('all', enriched);
  liveBus.emit(`session:${sessionId}`, enriched);
}

export function builderEnabled(): boolean {
  return ENABLED;
}

export function builderSessions(): BuilderSessionMeta[] {
  if (!ENABLED) return [];
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt < cutoff) sessions.delete(id);
  }
  return [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40);
}

export function subscribeBuilderStream(
  sessionId: string | null,
  listener: (record: BuilderStreamRecord) => void,
): () => void {
  const channel = sessionId ? `session:${sessionId}` : 'all';
  liveBus.on(channel, listener);
  return () => liveBus.off(channel, listener);
}

/** Emit one line to browsers that are watching right now. */
export function builderTap(sessionId: string, label: string, line: string): void {
  if (!ENABLED || !line) return;
  const ts = Date.now();
  updateSession(sessionId, label, 'live', ts);
  emit(sessionId, { ts, line: mask(line).slice(0, 4000) }, label);
}

/** Replace the browser's current terminal view with a fresh in-memory pane snapshot. */
export function builderSnapshot(sessionId: string, label: string, pane: string): void {
  if (!ENABLED || !pane) return;
  const ts = Date.now();
  updateSession(sessionId, label, 'live', ts);
  emit(sessionId, { ts, line: mask(pane).slice(-48_000), mode: 'snapshot' }, label);
}

/** Mark the live run finished/errored without retaining its output. */
export function builderStatus(
  sessionId: string,
  label: string,
  status: 'live' | 'finished' | 'error',
  note?: string,
): void {
  if (!ENABLED) return;
  const ts = Date.now();
  updateSession(sessionId, label, status, ts);
  emit(sessionId, {
    ts,
    line: `Session ${status}${note ? ` — ${mask(note).slice(0, 500)}` : ''}`,
    status,
  }, label);
}

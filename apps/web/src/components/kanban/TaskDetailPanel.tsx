import { useState } from 'react';
import { X, CheckCircle2, Archive, Trash2, UserCog, RotateCcw, Eye } from 'lucide-react';
import type { KanbanTask } from './kanban.types';

// 48hr auto-close window for client-deliverable tasks in to_close.
const AUTO_CLOSE_MS = 48 * 60 * 60 * 1000;

function autoCloseLeft(updatedAtIso: string): string | null {
  const elapsed = Date.now() - Date.parse(updatedAtIso);
  const remaining = AUTO_CLOSE_MS - elapsed;
  if (remaining <= 0) return 'auto-closes any minute';
  const hr = Math.floor(remaining / 3_600_000);
  const min = Math.floor((remaining % 3_600_000) / 60_000);
  if (hr > 0) return `auto-closes in ${hr}h ${min}m`;
  return `auto-closes in ${min}m`;
}

interface Props {
  task: KanbanTask;
  onClose: () => void;
  onChanged: () => void;            // parent refreshes board
  onDeleted: (id: string) => void;  // parent removes from local state
}

async function api(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = localStorage.getItem('boss_token') ?? '';
  return fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function TaskDetailPanel({ task, onClose, onChanged, onDeleted }: Props) {
  const [reassigning, setReassigning] = useState(false);
  const [newAgent, setNewAgent] = useState(task.assigned_agent ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const blocked = task.status === 'blocked';
  const canHardDelete = task.view_column === 'done';
  const isResponse = task.kind === 'response';
  const isPendingReview = task.kind === 'task' && task.view_column === 'to_close';
  const [reopenNote, setReopenNote] = useState('');
  const [showReopen, setShowReopen] = useState(false);

  async function approve() {
    setErr(null); setBusy(true);
    try {
      const r = await api('POST', `api/kanban/tasks/${task.id}/approve`);
      if (!r.ok) throw new Error(`approve failed: ${r.status}`);
      onChanged();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function archive() {
    setErr(null); setBusy(true);
    try {
      const r = await api('POST', `api/kanban/tasks/${task.id}/archive`);
      if (!r.ok) throw new Error(`archive failed: ${r.status}`);
      onChanged();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function reassign() {
    setErr(null); setBusy(true);
    try {
      const r = await api('PATCH', `api/kanban/tasks/${task.id}`, { assigned_agent: newAgent || null });
      if (!r.ok) throw new Error(`reassign failed: ${r.status}`);
      setReassigning(false);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function hardDelete() {
    setErr(null); setBusy(true);
    try {
      const r = await api('DELETE', `api/kanban/tasks/${task.id}`);
      if (!r.ok) throw new Error(`delete failed: ${r.status}`);
      onDeleted(task.id);
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function finalApprove() {
    setErr(null); setBusy(true);
    try {
      const r = await api('POST', `api/kanban/tasks/${task.id}/final-approve`);
      if (!r.ok) throw new Error(`final-approve failed: ${r.status}`);
      onChanged();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function reopen() {
    setErr(null); setBusy(true);
    try {
      const r = await api('POST', `api/kanban/tasks/${task.id}/reopen`, { note: reopenNote });
      if (!r.ok) throw new Error(`reopen failed: ${r.status}`);
      setShowReopen(false);
      setReopenNote('');
      onChanged();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function ackResponse() {
    setErr(null); setBusy(true);
    try {
      const r = await api('POST', `api/tasks/${task.id}/ack`);
      if (!r.ok) throw new Error(`ack failed: ${r.status}`);
      onChanged();
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} aria-hidden />
      <aside
        className="fixed top-0 right-0 h-full w-[480px] max-w-[95vw] bg-surface border-l border-border z-50 flex flex-col"
        role="dialog" aria-modal="true"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-xs uppercase tracking-wider text-muted">
            {isResponse ? 'Response' : isPendingReview ? 'Pending Final Review' : 'Task'}
          </div>
          {isPendingReview && (
            <div className="text-[11px] text-amber-400">{autoCloseLeft(task.updated_at)}</div>
          )}
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          <div>
            <div className="text-base font-semibold leading-tight">{task.title}</div>
            <div className="text-xs text-muted mt-1">id {task.id.slice(0, 8)}…</div>
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted">Status</dt>
            <dd>{task.status}{blocked && ' 🔒'}</dd>
            <dt className="text-muted">Priority</dt>
            <dd>P{task.priority}</dd>
            <dt className="text-muted">Client column</dt>
            <dd>{task.view_column}</dd>
            <dt className="text-muted">Project stage</dt>
            <dd>{task.current_stage}</dd>
            <dt className="text-muted">Assigned agent</dt>
            <dd>
              {reassigning ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    autoFocus value={newAgent}
                    onChange={(e) => setNewAgent(e.target.value)}
                    placeholder="darla, coo, …"
                    className="bg-background border border-border rounded px-2 py-0.5 w-32 text-xs"
                  />
                  <button onClick={reassign} disabled={busy} className="text-xs px-2 py-0.5 bg-accent text-accent-foreground rounded">save</button>
                  <button onClick={() => setReassigning(false)} className="text-xs text-muted">cancel</button>
                </span>
              ) : (
                <span>
                  {task.assigned_agent ?? 'unassigned'}{' '}
                  <button onClick={() => setReassigning(true)} className="text-xs text-muted hover:text-foreground underline ml-1">change</button>
                </span>
              )}
            </dd>
            <dt className="text-muted">Assigned client</dt>
            <dd>{task.assigned_client ?? '—'}</dd>
            <dt className="text-muted">Due</dt>
            <dd>{task.due_at ? new Date(task.due_at).toLocaleString() : '—'}</dd>
            <dt className="text-muted">Updated</dt>
            <dd>{new Date(task.updated_at).toLocaleString()}</dd>
          </dl>

          {task.stage_history.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted mb-1">Stage history</div>
              <ol className="space-y-1 text-xs border border-border rounded-md p-2 max-h-40 overflow-y-auto">
                {task.stage_history.map((h, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>{h.from} → {h.to}</span>
                    <span className="text-muted">{new Date(h.at).toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {Object.keys(task.context).length > 0 && (
            <details>
              <summary className="text-xs uppercase tracking-wider text-muted cursor-pointer">Context</summary>
              <pre className="text-xs bg-background border border-border rounded-md p-2 mt-1 overflow-x-auto">
                {JSON.stringify(task.context, null, 2)}
              </pre>
            </details>
          )}

          {err && <div className="text-xs text-red-400">{err}</div>}
        </div>

        <footer className="px-5 py-3 border-t border-border flex flex-wrap gap-2">
          {isResponse && !task.archived_at && (
            <button onClick={ackResponse} disabled={busy} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-accent text-accent-foreground rounded">
              <Eye size={14} /> Ack & dismiss
            </button>
          )}
          {isPendingReview && !showReopen && (
            <>
              <button onClick={finalApprove} disabled={busy} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-green-600 text-white rounded">
                <CheckCircle2 size={14} /> Approve & close
              </button>
              <button onClick={() => setShowReopen(true)} disabled={busy} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-amber-500/40 text-amber-400 rounded">
                <RotateCcw size={14} /> Reopen
              </button>
            </>
          )}
          {isPendingReview && showReopen && (
            <span className="inline-flex items-center gap-1 text-xs">
              <input
                autoFocus value={reopenNote}
                onChange={(e) => setReopenNote(e.target.value)}
                placeholder="reason for reopen"
                className="bg-background border border-border rounded px-2 py-0.5 w-48 text-xs"
              />
              <button onClick={reopen} disabled={busy} className="px-2 py-1 bg-amber-600 text-white rounded">Reopen</button>
              <button onClick={() => { setShowReopen(false); setReopenNote(''); }} className="px-2 py-1 text-muted">cancel</button>
            </span>
          )}
          {blocked && (
            <button onClick={approve} disabled={busy} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-green-600 text-white rounded">
              <CheckCircle2 size={14} /> Unblock
            </button>
          )}
          <button onClick={() => setReassigning(true)} disabled={busy} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-border rounded">
            <UserCog size={14} /> Reassign
          </button>
          {!task.archived_at && (
            <button onClick={archive} disabled={busy} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-border rounded">
              <Archive size={14} /> Archive
            </button>
          )}
          {canHardDelete && (
            confirmDelete ? (
              <span className="inline-flex items-center gap-1 text-xs">
                Delete forever?
                <button onClick={hardDelete} disabled={busy} className="px-2 py-1 bg-red-600 text-white rounded">Yes</button>
                <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 text-muted">No</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-red-500/40 text-red-400 rounded">
                <Trash2 size={14} /> Delete
              </button>
            )
          )}
        </footer>
      </aside>
    </>
  );
}

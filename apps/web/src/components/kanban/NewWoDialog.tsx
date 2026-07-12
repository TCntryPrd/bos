/**
 * NewWoDialog — submit a Work Order (AIOS v2.1 section 9 #6).
 *
 * WOs are stored in boss_tasks with `bucket` set, so they render on the
 * kanban with a bucket pill. After submit, the API emits task.changed and
 * the board auto-refreshes via the existing SSE subscription.
 */

import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import {
  WO_BUCKETS, WO_BUCKET_LABELS, type WoBucket,
  type KanbanScope,
} from './kanban.types';

interface Props {
  scope: KanbanScope;
  onClose: () => void;
  onCreated: () => void;
}

function defaultHandle(scope: KanbanScope): string {
  switch (scope.kind) {
    case 'rascal':
    case 'outsider': return scope.handle;
    case 'coo':      return 'coo';
    case 'coe':      return 'coe';
    case 'global':   return '';
  }
}

export function NewWoDialog({ scope, onClose, onCreated }: Props) {
  const [handle, setHandle]   = useState(defaultHandle(scope));
  const [title, setTitle]     = useState('');
  const [body, setBody]       = useState('');
  const [bucket, setBucket]   = useState<WoBucket>('today');
  const [client, setClient]   = useState('');
  const [priority, setPriority] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const token = localStorage.getItem('boss_token') ?? '';
      const r = await fetch('api/wo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          handle: handle.trim(),
          title: title.trim(),
          body: body.trim() || undefined,
          bucket,
          priority,
          client: client.trim() || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border rounded-lg p-5 w-[460px] max-w-[90vw]"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold">New Work Order</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-muted mb-1">Client manager / agent handle</span>
              <input
                autoFocus
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                required
                placeholder="wheezer, darla, …"
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">Bucket</span>
              <select
                value={bucket}
                onChange={(e) => setBucket(e.target.value as WoBucket)}
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              >
                {WO_BUCKETS.map((b) => (
                  <option key={b} value={b}>{WO_BUCKET_LABELS[b]}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-muted mb-1">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full bg-background border border-border rounded px-2 py-1.5"
            />
          </label>

          <label className="block">
            <span className="block text-xs text-muted mb-1">Instructions (optional)</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="What you need the client manager to do"
              className="w-full bg-background border border-border rounded px-2 py-1.5 resize-y"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-muted mb-1">Client (optional)</span>
              <input
                value={client}
                onChange={(e) => setClient(e.target.value)}
                placeholder="Lori Zeoli"
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">Priority (1=high, 10=low)</span>
              <input
                type="number" min={1} max={10}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-24 bg-background border border-border rounded px-2 py-1.5"
              />
            </label>
          </div>
        </div>

        {err && <div className="mt-3 text-xs text-red-400">{err}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs">Cancel</button>
          <button
            type="submit"
            disabled={submitting || !title.trim() || !handle.trim()}
            className="px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit WO'}
          </button>
        </div>
      </form>
    </div>
  );
}

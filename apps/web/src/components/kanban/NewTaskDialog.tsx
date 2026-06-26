import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import {
  CLIENT_COLUMNS, PROJECT_STAGES, CLIENT_COLUMN_LABELS,
  type KanbanScope, type ClientColumn, type ProjectStage,
} from './kanban.types';

interface Props {
  scope: KanbanScope;
  onClose: () => void;
  onCreated: () => void;
}

function defaultAgent(scope: KanbanScope): string {
  switch (scope.kind) {
    case 'rascal':
    case 'outsider': return scope.handle;
    case 'coo':      return 'coo';
    case 'coe':      return 'coe';
    case 'global':   return '';
  }
}

export function NewTaskDialog({ scope, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState(defaultAgent(scope));
  const [client, setClient] = useState('');
  const [view_column, setViewColumn] = useState<ClientColumn>('inbox');
  const [current_stage, setCurrentStage] = useState<ProjectStage>('Initiated');
  const [priority, setPriority] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const token = localStorage.getItem('boss_token') ?? '';
      const r = await fetch('api/kanban/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          title: title.trim(),
          assigned_agent: agent || null,
          assigned_client: client || null,
          view_column,
          current_stage,
          priority,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
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
          <h3 className="text-base font-semibold">New Task</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="block text-xs text-muted mb-1">Title</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full bg-background border border-border rounded px-2 py-1.5"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-muted mb-1">Assigned to</span>
              <input
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="darla, ponyboy, coo, …"
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">Client</span>
              <input
                value={client}
                onChange={(e) => setClient(e.target.value)}
                placeholder="Leslie Bodine"
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-muted mb-1">Client column</span>
              <select
                value={view_column}
                onChange={(e) => setViewColumn(e.target.value as ClientColumn)}
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              >
                {CLIENT_COLUMNS.map((c) => (
                  <option key={c} value={c}>{CLIENT_COLUMN_LABELS[c]}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-muted mb-1">Project stage</span>
              <select
                value={current_stage}
                onChange={(e) => setCurrentStage(e.target.value as ProjectStage)}
                className="w-full bg-background border border-border rounded px-2 py-1.5"
              >
                {PROJECT_STAGES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
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

        {err && <div className="mt-3 text-xs text-red-400">{err}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs">Cancel</button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="px-3 py-1.5 text-xs bg-accent text-accent-foreground rounded disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

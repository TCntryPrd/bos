import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { fetchWorkspaces, type CooWorkspace } from './useCooThreads.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, workspace_dir: string) => Promise<void>;
}

export function NewThreadModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [workspaces, setWorkspaces] = useState<CooWorkspace[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName('');
    fetchWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        const def = ws.find((w) => w.kind === 'boss-dev') ?? ws[0];
        setWorkspaceDir(def?.path ?? '');
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim() || !workspaceDir) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(name.trim(), workspaceDir);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] rounded-xl border border-border p-5 flex flex-col gap-4"
        style={{ background: 'linear-gradient(180deg, rgba(26,31,48,0.95), rgba(14,18,30,0.98))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="vs-mono text-[10px] tracking-[0.22em] text-info">New COO thread</div>
            <div className="text-[11px] text-text-muted mt-1">Pick a workspace; CC spawns there.</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="vs-mono text-[10px] tracking-[0.18em] text-text-muted">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="e.g. Demo prep"
            className="px-3 py-2 rounded-md bg-surface-2/60 border border-border text-text-primary text-[12.5px] focus:outline-none focus:border-accent/60"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="vs-mono text-[10px] tracking-[0.18em] text-text-muted">Workspace</label>
          <select
            value={workspaceDir}
            onChange={(e) => setWorkspaceDir(e.target.value)}
            className="px-3 py-2 rounded-md bg-surface-2/60 border border-border text-text-primary text-[12.5px] focus:outline-none focus:border-accent/60"
          >
            {workspaces.map((w) => (
              <option key={w.path} value={w.path}>
                [{w.kind}] {w.label} — {w.path}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="text-[11px] text-warning">{error}</div>}
        <div className="flex justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary border border-border"
          >Cancel</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!name.trim() || !workspaceDir || submitting}
            className="px-3.5 py-1.5 rounded-md text-[12px] font-semibold text-[#0a0c12] disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
          >{submitting ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

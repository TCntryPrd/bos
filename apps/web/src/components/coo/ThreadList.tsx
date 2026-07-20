import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { CooThread } from './useCooThreads.js';

const MAX_THREADS = 5;

interface Props {
  threads: CooThread[];
  activeId: string | null;
  isLoading: boolean;
  onPick: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onNew: () => void;
}

export function ThreadList({ threads, activeId, isLoading, onPick, onRename, onDelete, onNew }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const atCap = threads.length >= MAX_THREADS;

  return (
    <aside className="aios-frost-surface--dark aios-panel p-2 flex flex-col gap-1 overflow-y-auto">
      <div className="flex items-center justify-between px-2 pt-1 pb-2">
        <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-info">
          Threads <span className="text-text-muted">{threads.length}/{MAX_THREADS}</span>
        </div>
        <button
          type="button"
          onClick={onNew}
          disabled={atCap}
          className="vs-mono text-[10px] tracking-[0.18em] text-text-muted hover:text-text-primary disabled:opacity-30 disabled:hover:text-text-muted flex items-center gap-1"
          title={atCap ? `Max ${MAX_THREADS} threads. Delete one first.` : 'New thread'}
        >
          <Plus className="w-3 h-3" /> NEW
        </button>
      </div>
      {isLoading && threads.length === 0 && (
        <div className="vs-mono text-[10px] text-text-muted px-2">loading…</div>
      )}
      {!isLoading && threads.length === 0 && (
        <div className="vs-mono text-[10px] text-text-muted px-2 leading-relaxed">
          No threads yet.
        </div>
      )}
      {threads.map((t) => {
        const on = activeId === t.id;
        const isEditing = editingId === t.id;
        return (
          <div
            key={t.id}
            onClick={() => !isEditing && onPick(t.id)}
            onDoubleClick={() => { setEditingId(t.id); setDraftName(t.name); }}
            className={`group relative cursor-pointer text-left rounded-md px-2.5 py-2 transition-colors border-l-2 ${
              on ? 'border-l-info bg-surface-2/60 text-info' : 'border-l-transparent hover:bg-surface-2/40 text-text-primary'
            }`}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete thread "${t.name}"? (Removes from view; CC session JSONL stays on disk.)`)) {
                  void onDelete(t.id);
                }
              }}
              className="absolute top-1.5 right-1.5 p-0.5 rounded text-text-muted hover:text-warning hover:bg-warning/10 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Delete thread (removes from view)"
              aria-label="Delete thread"
            >
              <X className="w-3 h-3" />
            </button>
            {isEditing ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={async () => {
                  if (draftName.trim() && draftName.trim() !== t.name) {
                    await onRename(t.id, draftName.trim());
                  }
                  setEditingId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
                  if (e.key === 'Escape') { setEditingId(null); }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-[12.5px] text-text-primary focus:outline-none focus:border-accent"
              />
            ) : (
              <>
                <div className={`text-[12.5px] ${on ? 'font-semibold' : 'font-medium'} truncate`}>{t.name}</div>
                <div className="vs-mono text-[10px] text-text-muted mt-0.5 truncate">
                  {(t.workspace_dir ?? '').split('/').slice(-2).join('/')}
                </div>
                {t.last_message_preview && (
                  <div className="text-[10.5px] text-text-muted mt-1 truncate">{t.last_message_preview}</div>
                )}
              </>
            )}
          </div>
        );
      })}
    </aside>
  );
}

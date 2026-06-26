/**
 * SurfaceTabs — v1.7.13
 *
 * Small chat/tasks toggle used by COO, COE, RascalWorkspace, Outsiders
 * pages to switch between the existing chat surface and a scoped
 * KanbanBoard mount.
 */
import React from 'react';

export type SurfaceTab = 'chat' | 'tasks';

interface Props {
  value: SurfaceTab;
  onChange: (next: SurfaceTab) => void;
}

export function SurfaceTabs({ value, onChange }: Props) {
  return (
    <div className="flex gap-1 vs-mono text-[10px] uppercase tracking-[0.22em]">
      {(['chat', 'tasks'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className={
            'px-3 py-1.5 border ' +
            (value === tab
              ? 'bg-surface-2 border-info text-info'
              : 'bg-transparent border-border text-text-muted hover:text-text-secondary hover:border-text-muted')
          }
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

// Generic lock-aware reorderable tile grid.
//
// Wrap any list of cards/tiles to make them user-arrangeable when the global
// tile lock (padlock in the TopBar) is open:
//
//   <SortableTileGrid
//     storageKey="boss_agents_tile_order_v1"
//     ids={agents.map((a) => a.id)}
//     className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
//     render={(id) => <AgentCard agent={byId[id]} />}
//   />
//
// - Order persists in localStorage under storageKey (ids not present in the
//   saved order are appended in natural order; stale ids are dropped).
// - Locked (default): plain grid, zero behavior change, no handles.
// - Unlocked: each tile grows a grip; drag to reorder (dnd-kit sortable).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useTilesLocked } from '../../lib/tileLock';

function readOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function applyStoredOrder(ids: string[], stored: string[]): string[] {
  if (!stored.length) return ids;
  const present = new Set(ids);
  const ordered = stored.filter((id) => present.has(id));
  const rest = ids.filter((id) => !ordered.includes(id));
  return [...ordered, ...rest];
}

function SortableCell({ id, locked, children }: { id: string; locked: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: locked,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative min-w-0 ${isDragging ? 'z-20 opacity-70' : ''}`}
    >
      {!locked && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="absolute -right-2 -top-2 z-20 inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-full border border-border bg-surface-1 text-text-muted shadow-sm transition hover:text-text-primary active:cursor-grabbing"
          aria-label="Drag tile"
          title="Drag to rearrange"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      {children}
    </div>
  );
}

export function SortableTileGrid({
  storageKey,
  ids,
  render,
  className = '',
}: {
  storageKey: string;
  ids: string[];
  render: (id: string) => ReactNode;
  className?: string;
}) {
  const locked = useTilesLocked();
  const [stored, setStored] = useState<string[]>(() => readOrder(storageKey));
  useEffect(() => {
    setStored(readOrder(storageKey));
  }, [storageKey]);

  const ordered = useMemo(() => applyStoredOrder(ids, stored), [ids, stored]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = ordered.indexOf(String(active.id));
      const to = ordered.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const next = arrayMove(ordered, from, to);
      setStored(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [ordered, storageKey],
  );

  if (locked) {
    return <div className={className}>{ordered.map((id) => <React.Fragment key={id}>{render(id)}</React.Fragment>)}</div>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ordered} strategy={rectSortingStrategy}>
        <div className={className}>
          {ordered.map((id) => (
            <SortableCell key={id} id={id} locked={locked}>
              {render(id)}
            </SortableCell>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Calendar } from 'lucide-react';
import {
  DndContext, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { KanbanColumn } from './KanbanColumn';
import { NewTaskDialog } from './NewTaskDialog';
import { NewWoDialog } from './NewWoDialog';
import { TaskDetailPanel } from './TaskDetailPanel';
import { FiltersBar, applyFilters, type FiltersState } from './FiltersBar';
import type {
  KanbanBoardResponse, KanbanScope, KanbanView, KanbanTask, KanbanColumnData,
} from './kanban.types';
import { scopeToQuery } from './kanban.types';
import { moveTask, parseDndId } from './dnd-helpers';

interface Props {
  scope: KanbanScope;
  onCardClick?: (task: KanbanTask) => void;
}

export function KanbanBoard({ scope, onCardClick }: Props) {
  // Single agent job board — the columns the agents work each heartbeat
  // (inbox → today → in_progress → to_close → done). No view toggle.
  const [view] = useState<KanbanView>('client');
  const [data, setData] = useState<KanbanBoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [showNewWo, setShowNewWo] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<KanbanTask | null>(null);
  const [filters, setFilters] = useState<FiltersState>({
    q: '', client: '', hideOldDone: false, showArchived: false,
  });

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('boss_token') ?? '';
      const r = await fetch(
        `api/kanban/board?${scopeToQuery(scope)}&view=${view}${filters.showArchived ? '&include_archived=1' : ''}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      const body = (await r.json()) as KanbanBoardResponse;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, view, filters.showArchived]);

  useEffect(() => { fetchBoard(); }, [fetchBoard, refreshKey]);

  // SSE consumer — pushes server-side mutations into the board state without
  // needing a refetch. Pauses while the tab is hidden; reconnects with a 3s
  // backoff. Tenant filtering is server-side; we still ignore events for tasks
  // that don't match the current scope.
  useEffect(() => {
    let es: EventSource | null = null;
    let backoff: number | null = null;
    let stopped = false;

    function open() {
      if (stopped) return;
      es = new EventSource('api/kanban/stream');
      es.addEventListener('task.changed', () => {
        // Cheapest correct refresh: re-fetch the board. Avoids per-event
        // surgery for in-scope/out-of-scope/view-mismatch logic.
        fetchBoard();
      });
      es.addEventListener('error', () => {
        es?.close();
        es = null;
        if (stopped) return;
        backoff = window.setTimeout(open, 3000);
      });
    }

    function pause() {
      stopped = true;
      es?.close(); es = null;
      if (backoff) { window.clearTimeout(backoff); backoff = null; }
    }
    function resume() {
      stopped = false;
      open();
    }

    if (document.visibilityState === 'visible') open();
    const onVis = () => {
      if (document.visibilityState === 'visible') resume();
      else pause();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      stopped = true;
      es?.close();
      if (backoff) window.clearTimeout(backoff);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchBoard]);

  // Pointer sensor with a small activation distance so clicks (no movement)
  // still fire onClick instead of starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = useCallback(async (e: DragEndEvent) => {
    const dragged = parseDndId(String(e.active.id));
    const dropped = e.over ? parseDndId(String(e.over.id)) : null;
    if (!dragged || dragged.kind !== 'card') return;
    if (!dropped || dropped.kind !== 'col') return; // dropped on nothing or another card

    const taskId = dragged.key;
    const targetColumn = dropped.key;
    if (!data) return;

    // Find current column
    const currentCol = data.columns.find((c) => c.tasks.some((t) => t.id === taskId));
    if (!currentCol) return;
    if (currentCol.key === targetColumn) return; // no-op self-drop

    // Optimistic update
    const movingTask = currentCol.tasks.find((t) => t.id === taskId)!;
    const optimistic: KanbanBoardResponse = {
      ...data,
      columns: data.columns.map<KanbanColumnData>((col) => {
        if (col.key === currentCol.key) {
          return { ...col, tasks: col.tasks.filter((t) => t.id !== taskId), count: col.count - 1 };
        }
        if (col.key === targetColumn) {
          const updated: KanbanTask = view === 'client'
            ? { ...movingTask, view_column: targetColumn as KanbanTask['view_column'] }
            : { ...movingTask, current_stage: targetColumn };
          return { ...col, tasks: [updated, ...col.tasks], count: col.count + 1 };
        }
        return col;
      }),
    };
    setData(optimistic);

    try {
      await moveTask(taskId, view, targetColumn);
      // Server's task.changed SSE will eventually re-confirm; but since SSE
      // arrives asynchronously, we trust the optimistic state.
    } catch (err) {
      // Revert
      setData(data);
      setToast(err instanceof Error ? err.message : 'move failed');
      setTimeout(() => setToast(null), 3500);
    }
  }, [data, view]);

  const columns = useMemo(
    () => applyFilters(data?.columns ?? [], filters),
    [data, filters],
  );

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-semibold text-text-primary">Task Board</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchBoard()}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
            aria-label="Refresh"
          >
            <RefreshCw size={14} /> refresh
          </button>
          <button
            type="button"
            onClick={() => setShowNewWo(true)}
            className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-accent text-accent rounded-md hover:bg-accent/10"
          >
            <Calendar size={14} /> New WO
          </button>
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-accent text-accent-foreground rounded-md"
          >
            <Plus size={14} /> New Task
          </button>
        </div>
      </div>

      <FiltersBar filters={filters} onChange={setFilters} columns={data?.columns ?? []} />

      {error && (
        <div className="px-4 py-2 bg-red-500/10 text-red-400 text-xs">
          {error} · <button className="underline" onClick={() => fetchBoard()}>retry</button>
        </div>
      )}

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-3 px-4 py-3 h-full">
            {loading && !data ? (
              <div className="text-sm text-muted">loading…</div>
            ) : columns.length === 0 ? (
              <div className="text-sm text-muted">no columns</div>
            ) : (
              columns.map((col) => (
                <KanbanColumn
                  key={col.key}
                  column={col}
                  onCardClick={(t) => { setSelected(t); onCardClick?.(t); }}
                />
              ))
            )}
          </div>
        </div>
      </DndContext>

      {toast && (
        <div className="absolute bottom-4 right-4 bg-red-500/90 text-white text-xs px-3 py-2 rounded-md shadow-lg">
          {toast}
        </div>
      )}

      {showNewWo && (
        <NewWoDialog
          scope={scope}
          onClose={() => setShowNewWo(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {showNew && (
        <NewTaskDialog
          scope={scope}
          onClose={() => setShowNew(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {selected && (
        <TaskDetailPanel
          task={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { setRefreshKey((k) => k + 1); }}
          onDeleted={(_id) => { setRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}

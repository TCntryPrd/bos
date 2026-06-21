import { Search } from 'lucide-react';
import type { KanbanColumnData } from './kanban.types';

export interface FiltersState {
  q: string;
  client: string;          // '' = any
  hideOldDone: boolean;    // hide Done items older than 7 days
  showArchived: boolean;
}

interface Props {
  filters: FiltersState;
  onChange: (f: FiltersState) => void;
  columns: KanbanColumnData[];   // used to derive distinct assigned_client values
}

export function FiltersBar({ filters, onChange, columns }: Props) {
  const allClients = Array.from(new Set(
    columns.flatMap((c) => c.tasks.map((t) => t.assigned_client).filter((x): x is string => !!x)),
  )).sort();

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border text-xs">
      <label className="inline-flex items-center gap-1 bg-background border border-border rounded px-2 py-1">
        <Search size={12} className="text-muted" />
        <input
          value={filters.q}
          onChange={(e) => onChange({ ...filters, q: e.target.value })}
          placeholder="search title…"
          className="bg-transparent outline-none w-40 text-xs"
        />
      </label>

      <label className="inline-flex items-center gap-1">
        <span className="text-muted">Client</span>
        <select
          value={filters.client}
          onChange={(e) => onChange({ ...filters, client: e.target.value })}
          className="bg-background border border-border rounded px-1 py-1 text-xs"
        >
          <option value="">any</option>
          {allClients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>

      <label className="inline-flex items-center gap-1">
        <input
          type="checkbox"
          checked={filters.hideOldDone}
          onChange={(e) => onChange({ ...filters, hideOldDone: e.target.checked })}
        />
        <span>Hide old Done</span>
      </label>

      <label className="inline-flex items-center gap-1">
        <input
          type="checkbox"
          checked={filters.showArchived}
          onChange={(e) => onChange({ ...filters, showArchived: e.target.checked })}
        />
        <span>Show archived</span>
      </label>
    </div>
  );
}

export function applyFilters(
  columns: KanbanColumnData[],
  f: FiltersState,
): KanbanColumnData[] {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return columns.map((col) => {
    let tasks = col.tasks;
    if (f.q.trim()) {
      const q = f.q.toLowerCase();
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
    }
    if (f.client) {
      tasks = tasks.filter((t) => t.assigned_client === f.client);
    }
    if (f.hideOldDone && col.key === 'done') {
      tasks = tasks.filter((t) => Date.parse(t.updated_at) >= sevenDaysAgo);
    }
    return { ...col, tasks, count: tasks.length };
  });
}

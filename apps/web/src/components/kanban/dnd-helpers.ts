import type { KanbanView, KanbanTask } from './kanban.types';

/**
 * Identifier shape used by dnd-kit for cards and columns. dnd-kit uses
 * string/number ids; we encode kind so the drop handler can route.
 */
export type DndItemId = string;

export function cardDndId(taskId: string): DndItemId {
  return `card:${taskId}`;
}
export function columnDndId(columnKey: string): DndItemId {
  return `col:${columnKey}`;
}
export function parseDndId(id: DndItemId): { kind: 'card' | 'col'; key: string } | null {
  const [kind, key] = String(id).split(':');
  if (kind !== 'card' && kind !== 'col') return null;
  if (!key) return null;
  return { kind, key };
}

/** Server call. Returns the updated task on success; throws on failure. */
export async function moveTask(
  taskId: string,
  view: KanbanView,
  to: string,
): Promise<KanbanTask> {
  const token = localStorage.getItem('boss_token') ?? '';
  const r = await fetch(`api/kanban/tasks/${encodeURIComponent(taskId)}/move`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ view, to }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `move failed: HTTP ${r.status}`);
  }
  const body = (await r.json()) as { task: KanbanTask };
  return body.task;
}

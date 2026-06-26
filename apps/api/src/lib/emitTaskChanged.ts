/**
 * SSE fan-out helper for Kanban task changes.
 *
 * Subscribers register a writer function via `subscribeTaskChanged()`; mutations
 * call `emitTaskChanged(payload)` to push a `task.changed` event to every
 * subscriber. Tenant filtering is the subscriber's responsibility.
 */

export interface KanbanTaskRow {
  id: string;
  tenant_id: string;
  pipeline_id: string | null;
  title: string;
  current_stage: string;
  status: string;
  assigned_agent: string | null;
  assigned_client: string | null;
  context: Record<string, unknown>;
  stage_history: unknown[];
  priority: number;
  view_column: string;
  due_at: string | null;
  archived_at: string | null;
  /** WO bucket label ('today'|'tomorrow'|'this_week'|'next_week'). NULL for plain kanban rows. */
  bucket: string | null;
  /** Heartbeat gate: rascal cannot pick this up until now() >= gate_at. NULL for plain kanban rows. */
  gate_at: string | null;
  /** Set by heartbeat when a rascal claims the WO. */
  picked_at: string | null;
  /** Row discriminator: 'task' = real work; 'response' = Outsider→Rascal auto-reply. */
  kind: string;
  created_at: string;
  updated_at: string;
}

export type TaskChangedPayload =
  | { id: string; tenantId: string; task: KanbanTaskRow }
  | { id: string; tenantId: string; task: null };

type Subscriber = (payload: TaskChangedPayload) => void;

const subscribers = new Set<Subscriber>();

export function subscribeTaskChanged(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function emitTaskChanged(payload: TaskChangedPayload): void {
  for (const fn of subscribers) {
    try {
      fn(payload);
    } catch {
      // a single subscriber error must not break fan-out
    }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}

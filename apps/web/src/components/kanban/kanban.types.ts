export const PROJECT_STAGES = [
  'Initiated',
  'Assessment',
  'Value & Process Mapping',
  'KFR & Roadmap forward',
  'L1 Implementation',
  'L2 Implementation',
  'Delivered',
  'Support',
  'Closed',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const CLIENT_COLUMNS = [
  'inbox', 'today', 'in_progress', 'to_close', 'done',
] as const;
export type ClientColumn = (typeof CLIENT_COLUMNS)[number];

export const CLIENT_COLUMN_LABELS: Record<ClientColumn, string> = {
  inbox:       'Inbox',
  today:       'Today',
  in_progress: 'In Progress',
  to_close:    'Pending Final Review',
  done:        'Done',
};

export type KanbanScope =
  | { kind: 'global' }
  | { kind: 'rascal';   handle: string }
  | { kind: 'outsider'; handle: string }
  | { kind: 'coo' }
  | { kind: 'coe' };

export type KanbanView = 'client' | 'project';

export interface KanbanTask {
  id: string;
  tenant_id: string;
  pipeline_id: string | null;
  title: string;
  current_stage: string;
  status: 'pending' | 'active' | 'blocked' | 'done' | 'failed';
  assigned_agent: string | null;
  assigned_client: string | null;
  context: Record<string, unknown>;
  stage_history: Array<{ from: string; to: string; at: string; by: string }>;
  priority: number;
  view_column: ClientColumn;
  due_at: string | null;
  archived_at: string | null;
  /** WO bucket label. NULL for plain kanban rows. */
  bucket: 'today' | 'tomorrow' | 'this_week' | 'next_week' | null;
  /** Heartbeat gate: earliest pickup time. NULL for plain kanban rows. */
  gate_at: string | null;
  /** Set when a rascal heartbeat claims this WO. */
  picked_at: string | null;
  /** Row discriminator: 'task' = real work; 'response' = Outsider→Rascal auto-reply. */
  kind: 'task' | 'response';
  created_at: string;
  updated_at: string;
}

export const WO_BUCKETS = ['today', 'tomorrow', 'this_week', 'next_week'] as const;
export type WoBucket = (typeof WO_BUCKETS)[number];
export const WO_BUCKET_LABELS: Record<WoBucket, string> = {
  today:     'Today',
  tomorrow:  'Tomorrow',
  this_week: 'This Week',
  next_week: 'Next Week',
};

export interface KanbanColumnData {
  key: string;
  label: string;
  count: number;
  tasks: KanbanTask[];
}

export interface KanbanBoardResponse {
  view: KanbanView;
  scope: { kind: string; handle?: string };
  columns: KanbanColumnData[];
}

export function scopeToQuery(scope: KanbanScope): string {
  switch (scope.kind) {
    case 'global':   return 'scope=global';
    case 'coo':      return 'scope=coo';
    case 'coe':      return 'scope=coe';
    case 'rascal':   return `scope=rascal&handle=${encodeURIComponent(scope.handle)}`;
    case 'outsider': return `scope=outsider&handle=${encodeURIComponent(scope.handle)}`;
  }
}

export function scopeKey(scope: KanbanScope): string {
  return scope.kind === 'rascal' || scope.kind === 'outsider'
    ? `${scope.kind}_${scope.handle}`
    : scope.kind;
}

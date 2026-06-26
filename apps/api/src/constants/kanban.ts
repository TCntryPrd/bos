/**
 * Kanban column constants — shared between API route validation and frontend
 * column rendering. Keep this file the single source of truth.
 */

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
  'inbox',
  'today',
  'in_progress',
  'to_close',
  'done',
] as const;
export type ClientColumn = (typeof CLIENT_COLUMNS)[number];

export const CLIENT_COLUMN_LABELS: Record<ClientColumn, string> = {
  inbox:       'Inbox',
  today:       'Today',
  in_progress: 'In Progress',
  to_close:    'To Close',
  done:        'Done',
};

export function isClientColumn(value: unknown): value is ClientColumn {
  return typeof value === 'string' && (CLIENT_COLUMNS as readonly string[]).includes(value);
}

export function isProjectStage(value: unknown): value is ProjectStage {
  return typeof value === 'string' && (PROJECT_STAGES as readonly string[]).includes(value);
}

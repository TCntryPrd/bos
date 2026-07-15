import { Lock, Bot, Clock, Zap, Calendar, MessageSquareReply } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { KanbanTask } from './kanban.types';
import { WO_BUCKET_LABELS } from './kanban.types';
import { cardDndId } from './dnd-helpers';

const AUTO_CLOSE_HRS = 48;

interface Props {
  task: KanbanTask;
  onClick?: (task: KanbanTask) => void;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function autoCloseLabel(updatedAtIso: string): string {
  const elapsed = Date.now() - Date.parse(updatedAtIso);
  const remainingHr = AUTO_CLOSE_HRS - elapsed / 3_600_000;
  if (remainingHr <= 0) return 'auto-closes any minute';
  if (remainingHr < 1) return `${Math.floor(remainingHr * 60)}m left`;
  return `${Math.floor(remainingHr)}h left`;
}

export function KanbanCard({ task, onClick }: Props) {
  const blocked = task.status === 'blocked';
  const isResponse = task.kind === 'response';
  const isPendingReview = task.kind === 'task' && task.view_column === 'to_close';
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: cardDndId(task.id),
    data: { taskId: task.id },
  });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    cursor: 'grab',
  };

  // Response cards: smaller, banner-style, no draggable affordance to make
  // it clear they aren't work the rascal needs to grab and move.
  if (isResponse) {
    const replyResult = typeof task.context.result === 'string'
      ? task.context.result : '';
    const fromHandle = typeof task.context.from === 'string'
      ? task.context.from : task.assigned_agent ?? 'someone';
    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={(e) => {
          if (isDragging) return;
          e.stopPropagation();
          onClick?.(task);
        }}
        role="button"
        tabIndex={0}
        className={[
          'w-full text-left rounded-md border border-accent/30 bg-accent/5',
          'px-3 py-1.5 mb-2 hover:border-accent/60 transition-colors',
          'border-l-2 border-l-accent',
        ].join(' ')}
      >
        <div className="flex items-center justify-between text-[11px] text-accent">
          <span className="inline-flex items-center gap-1">
            <MessageSquareReply size={11} />Reply from {fromHandle}
          </span>
          <span className="inline-flex items-center gap-0.5 text-muted">
            <Clock size={10} />{relativeTime(task.created_at)}
          </span>
        </div>
        {replyResult && (
          <div className="text-xs text-foreground/80 mt-0.5 line-clamp-2">{replyResult}</div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        if (isDragging) return;
        e.stopPropagation();
        onClick?.(task);
      }}
      role="button"
      tabIndex={0}
      className={[
        'w-full text-left rounded-md border border-border bg-surface',
        'px-3 py-2 mb-2 hover:border-accent/60 transition-colors',
        blocked ? 'border-l-4 border-l-red-500'
          : isPendingReview ? 'border-l-4 border-l-amber-500'
          : 'border-l-4 border-l-accent/40',
        isDragging ? 'shadow-lg ring-2 ring-accent/60' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="truncate">{task.assigned_client ?? '—'}</span>
        <span className="flex items-center gap-2 shrink-0">
          {isPendingReview && (
            <span
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 bg-amber-500/20 text-amber-400"
              title="Auto-closes 48hr after last update"
            >
              <Clock size={11} />{autoCloseLabel(task.updated_at)}
            </span>
          )}
          {task.bucket && (
            <span
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 bg-accent/20 text-accent"
              title={`WO bucket: ${WO_BUCKET_LABELS[task.bucket]}`}
            >
              <Calendar size={11} />{WO_BUCKET_LABELS[task.bucket]}
            </span>
          )}
          <span className="inline-flex items-center gap-0.5"><Zap size={11} />P{task.priority}</span>
          <span className="inline-flex items-center gap-0.5"><Clock size={11} />{relativeTime(task.updated_at)}</span>
        </span>
      </div>
      <div className="text-sm font-medium leading-snug mt-1 line-clamp-2">
        {task.title}
      </div>
      <div className="flex items-center justify-between text-xs text-muted mt-1.5">
        <span className="inline-flex items-center gap-1">
          <Bot size={12} />{task.assigned_agent ?? 'unassigned'}
        </span>
        <span className="inline-flex items-center gap-1">
          {task.current_stage}
          {blocked && <Lock size={12} className="text-red-500 ml-1" />}
        </span>
      </div>
    </div>
  );
}

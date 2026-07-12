import { useDroppable } from '@dnd-kit/core';
import { KanbanCard } from './KanbanCard';
import type { KanbanColumnData, KanbanTask } from './kanban.types';
import { columnDndId } from './dnd-helpers';

interface Props {
  column: KanbanColumnData;
  onCardClick?: (task: KanbanTask) => void;
}

export function KanbanColumn({ column, onCardClick }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: columnDndId(column.key),
    data: { columnKey: column.key },
  });

  return (
    <div
      ref={setNodeRef}
      className={[
        'flex flex-col min-w-[260px] w-[260px] shrink-0 rounded-md transition-colors',
        isOver ? 'bg-accent/5 ring-1 ring-accent/40' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-2 py-1.5 mb-2 border-b border-border">
        <span className="text-sm font-semibold uppercase tracking-wide">{column.label}</span>
        <span className="text-xs text-muted">{column.count}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-1">
        {column.tasks.length === 0 ? (
          <div
            className={[
              'text-center text-xs py-6 border border-dashed rounded-md',
              isOver ? 'border-accent text-accent' : 'border-border text-muted',
            ].join(' ')}
          >
            {isOver ? 'drop here' : 'empty'}
          </div>
        ) : (
          column.tasks.map((t) => (
            <KanbanCard key={t.id} task={t} onClick={onCardClick} />
          ))
        )}
      </div>
    </div>
  );
}

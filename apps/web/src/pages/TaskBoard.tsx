import { KanbanBoard } from '../components/kanban/KanbanBoard';

export default function TaskBoard() {
  return (
    <div className="h-full flex flex-col">
      <KanbanBoard scope={{ kind: 'global' }} />
    </div>
  );
}

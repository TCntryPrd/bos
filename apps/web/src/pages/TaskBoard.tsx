import { useSearchParams } from 'react-router-dom';
import { KanbanBoard } from '../components/kanban/KanbanBoard';

export default function TaskBoard() {
  const [searchParams] = useSearchParams();
  const initialNewTask = searchParams.get('new') === 'task';

  return (
    <div className="aios-page planning-room-page aios-page-pad h-full min-h-0 flex flex-col">
      <div className="planning-room-header">
        <div>
          <div className="vs-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">War Room</div>
          <h1 className="text-xl font-semibold text-slate-950">Task Board</h1>
        </div>
      </div>
      <div className="aios-workbench planning-whiteboard flex-1">
        <KanbanBoard scope={{ kind: 'global' }} initialNewTask={initialNewTask} />
      </div>
    </div>
  );
}

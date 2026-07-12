import type { KanbanView } from './kanban.types';

interface Props {
  value: KanbanView;
  onChange: (v: KanbanView) => void;
}

const OPTIONS: Array<{ value: KanbanView; label: string }> = [
  { value: 'client',  label: 'My Client' },
  { value: 'project', label: 'Project Status' },
];

export function ViewToggle({ value, onChange }: Props) {
  return (
    <div role="tablist" aria-label="Kanban view" className="inline-flex border border-border rounded-md overflow-hidden">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={[
            'px-3 py-1.5 text-xs font-medium transition-colors',
            value === opt.value
              ? 'bg-accent text-accent-foreground'
              : 'bg-transparent text-muted hover:text-foreground',
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

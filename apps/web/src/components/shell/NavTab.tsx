import React from 'react';
import { NavLink } from 'react-router-dom';
import { Pencil } from 'lucide-react';

export type NavTabVariant = 'default' | 'kanban' | 'miro';

interface NavTabBaseProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: React.ReactNode;
  variant?: NavTabVariant;
  collapsed?: boolean;
  onNavClick?: () => void;
  /** When set, a rename pencil appears on hover (expanded only). */
  onRename?: () => void;
}

interface LinkTabProps extends NavTabBaseProps {
  to: string;
  end?: boolean;
  disabled?: false;
  comingSoon?: false;
}

interface PlaceholderTabProps extends NavTabBaseProps {
  to?: undefined;
  disabled: true;
  comingSoon?: boolean;
  title?: string;
}

export type NavTabProps = LinkTabProps | PlaceholderTabProps;

const VARIANT_CLASS: Record<NavTabVariant, string> = {
  default: '',
  kanban: 'k-kanban',
  miro:   'k-miro',
};

function Body({
  label,
  icon: Icon,
  badge,
  collapsed,
  comingSoon,
  onRename,
}: Pick<NavTabBaseProps, 'label' | 'icon' | 'badge' | 'collapsed' | 'onRename'> & { comingSoon?: boolean }) {
  return (
    <>
      <Icon className="ico w-4 h-4 flex-shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {onRename && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRename(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRename(); } }}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-text-muted hover:text-text-primary flex-shrink-0 cursor-pointer"
              title={`Rename ${label}`}
              aria-label={`Rename ${label}`}
            >
              <Pencil className="w-3 h-3" />
            </span>
          )}
          {badge !== undefined && badge !== null && (
            <span className="vs-mono text-[10px] tracking-wider text-text-muted bg-surface-3 rounded-md px-2 py-0.5">
              {badge}
            </span>
          )}
          {comingSoon && (
            <span className="vs-mono text-[9px] tracking-[0.12em] text-text-muted/70 uppercase">
              soon
            </span>
          )}
        </>
      )}
    </>
  );
}

export function NavTab(props: NavTabProps) {
  const variantClass = VARIANT_CLASS[props.variant ?? 'default'];
  const baseClass = 'vs-tab ' + variantClass + (props.collapsed ? ' justify-center' : '');

  if (props.disabled) {
    return (
      <button
        type="button"
        className={baseClass + ' opacity-50 cursor-not-allowed'}
        aria-label={props.label}
        title={props.title ?? (props.comingSoon ? `${props.label} — coming soon` : props.label)}
        disabled
      >
        <Body
          label={props.label}
          icon={props.icon}
          badge={props.badge}
          collapsed={props.collapsed}
          comingSoon={props.comingSoon}
        />
      </button>
    );
  }

  return (
    <NavLink
      to={props.to}
      end={props.end}
      onClick={props.onNavClick}
      className={({ isActive }) => 'group ' + baseClass + (isActive ? ' active' : '')}
      aria-label={props.label}
      title={props.label}
    >
      <Body label={props.label} icon={props.icon} badge={props.badge} collapsed={props.collapsed} onRename={props.onRename} />
    </NavLink>
  );
}

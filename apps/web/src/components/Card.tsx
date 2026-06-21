/**
 * Card — base container component for dashboard sections.
 *
 * Usage:
 *   <Card>
 *     <Card.Header title="System Health" action={<button>Refresh</button>} />
 *     <Card.Body>…content…</Card.Body>
 *   </Card>
 */

import React from 'react';
import { cn } from '../lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  /** Remove default padding from the card body area. */
  noPadding?: boolean;
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}

interface CardBodyProps {
  children: React.ReactNode;
  className?: string;
}

function CardRoot({ children, className, noPadding }: CardProps) {
  return (
    <div className={cn('bg-surface-2 border border-border rounded-xl', !noPadding && '', className)}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 py-4 border-b border-border', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-primary truncate">{title}</h2>
        {subtitle && (
          <p className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

function CardBody({ children, className }: CardBodyProps) {
  return (
    <div className={cn('p-5', className)}>
      {children}
    </div>
  );
}

export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Body: CardBody,
});

/**
 * LoadingSpinner and skeleton loaders for data-fetching states.
 */

import React from 'react';
import { cn } from '../lib/utils';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'w-4 h-4 border-2',
    md: 'w-6 h-6 border-2',
    lg: 'w-8 h-8 border-[3px]',
  };

  return (
    <span
      className={cn(
        'inline-block rounded-full border-border-strong border-t-accent animate-spin',
        sizeClasses[size],
        className,
      )}
      role="status"
      aria-label="Loading"
    />
  );
}

export function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <LoadingSpinner size="lg" />
    </div>
  );
}

export function SkeletonLine({ className }: { className?: string }) {
  return (
    <div
      className={cn('h-3 bg-surface-3 rounded animate-pulse', className)}
      aria-hidden
    />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card p-5 space-y-3" aria-busy="true" aria-label="Loading content">
      <SkeletonLine className="w-1/3 h-4" />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} className={i % 2 === 0 ? 'w-full' : 'w-4/5'} />
      ))}
    </div>
  );
}

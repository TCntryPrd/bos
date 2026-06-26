/**
 * ConfirmDialog — simple modal for destructive action confirmation.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <ConfirmDialog
 *     open={open}
 *     title="Delete preference?"
 *     description="This cannot be undone."
 *     onConfirm={() => { doDelete(); setOpen(false); }}
 *     onCancel={() => setOpen(false)}
 *   />
 */

import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
  danger = true,
}: ConfirmDialogProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={onCancel}
    >
      <div
        className="bg-surface-2 border border-border rounded-xl shadow-2xl w-full max-w-sm p-6 animate-slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        {danger && (
          <div className="flex justify-center mb-4">
            <span className="p-3 rounded-full bg-danger/10">
              <AlertTriangle className="w-5 h-5 text-danger" aria-hidden />
            </span>
          </div>
        )}
        <h2
          id="confirm-dialog-title"
          className="text-sm font-semibold text-text-primary text-center"
        >
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-xs text-text-muted text-center">{description}</p>
        )}
        <div className="mt-5 flex gap-3">
          <button
            className="btn-secondary flex-1 justify-center"
            onClick={onCancel}
            autoFocus
          >
            Cancel
          </button>
          <button
            className={danger ? 'btn-danger flex-1 justify-center' : 'btn-primary flex-1 justify-center'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

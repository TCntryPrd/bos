/**
 * FrontSwitcher — login-page selector between the two web fronts:
 *   Themed    (Executive experience)  -> apex domain
 *   Original  (templated deliverable) -> app.<apex> domain
 * Both fronts share the same backend; switching is a full redirect so the
 * selected container serves everything from login onward.
 */
import React from 'react';

function fronts() {
  const host = window.location.host;
  const isTemplate = host.startsWith('app.');
  const apex = isTemplate ? host.slice(4) : host;
  return {
    current: isTemplate ? 'template' : 'themed',
    themedUrl: `${window.location.protocol}//${apex}/login`,
    templateUrl: `${window.location.protocol}//app.${apex}/login`,
  };
}

export function FrontSwitcher() {
  const f = fronts();
  const btn = (active: boolean) =>
    `flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
      active
        ? 'border-accent/60 bg-accent/10 text-text-primary'
        : 'border-border bg-surface-2 text-text-muted hover:border-border-strong hover:text-text-secondary'
    }`;
  return (
    <div className="mt-4">
      <div className="vs-mono mb-1.5 text-center text-[9px] uppercase tracking-[0.2em] text-text-muted">
        Interface
      </div>
      <div className="flex gap-2" role="group" aria-label="Interface selector">
        <button type="button" className={btn(f.current === 'themed')}
          onClick={() => { if (f.current !== 'themed') window.location.href = f.themedUrl; }}>
          Executive
        </button>
        <button type="button" className={btn(f.current === 'template')}
          onClick={() => { if (f.current !== 'template') window.location.href = f.templateUrl; }}>
          Original
        </button>
      </div>
    </div>
  );
}

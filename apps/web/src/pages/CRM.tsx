/**
 * CRM — embedded Katalyst CRM with a Keap launch button.
 *
 * Katalyst (https://www.katalyst-crm.com) embeds cleanly in an iframe and is
 * the primary surface. Keap can't be framed (X-Frame-Options: SAMEORIGIN), so
 * it gets a launch button that opens it in a new tab.
 *
 * Agents work CRM data through the boss_crm_* tools (Katalyst API); this page
 * is the human surface.
 */

import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

const KATALYST_URL = 'https://www.katalyst-crm.com';
const KEAP_URL = 'https://app.keap.com';

export default function CRM() {
  const [loading, setLoading] = useState(true);

  return (
    <div className="h-full w-full flex flex-col bg-surface-1">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border shrink-0">
        <span className="text-[13px] font-semibold text-text-primary">Katalyst CRM</span>
        <span className="text-[11.5px] text-text-muted font-mono truncate">{KATALYST_URL}</span>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={KATALYST_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-md border border-border bg-surface-2/50"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
          </a>
          <a
            href={KEAP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary flex items-center gap-1.5 text-[12px]"
            title="Keap can't be embedded — opens in a new tab"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Launch Keap
          </a>
        </div>
      </div>

      {/* Embedded Katalyst */}
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-1 z-10">
            <Loader2 className="w-6 h-6 animate-spin text-accent" />
          </div>
        )}
        <iframe
          src={KATALYST_URL}
          title="Katalyst CRM"
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  );
}

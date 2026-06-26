/**
 * GenericWorkspace — placeholder for integrations without a full workspace view yet.
 * Shows integration name and a "coming soon" message.
 */

import React from 'react';
import { Zap } from 'lucide-react';

const INTEGRATION_NAMES: Record<string, string> = {
  slack: 'Slack',
  stripe: 'Stripe',
  notion: 'Notion',
  telegram: 'Telegram',
  make: 'Make',
  home_assistant: 'Home Assistant',
  hubspace: 'Hubspace',
  whatsapp: 'WhatsApp',
};

export function GenericWorkspace({ integrationId }: { integrationId: string }) {
  const name = INTEGRATION_NAMES[integrationId] ?? integrationId;

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-surface-3 flex items-center justify-center mb-4">
        <Zap className="w-6 h-6 text-text-muted" aria-hidden />
      </div>
      <h2 className="text-base font-semibold text-text-primary mb-2">{name} Workspace</h2>
      <p className="text-sm text-text-muted max-w-sm">
        The {name} workspace view is coming soon. For now, you can interact with {name} through the BOS chat panel.
      </p>
    </div>
  );
}

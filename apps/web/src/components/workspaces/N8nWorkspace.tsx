/**
 * N8nWorkspace — embedded n8n canvas editor via iframe.
 */

import React from 'react';

export function N8nWorkspace() {
  return (
    <div className="h-full w-full">
      <iframe
        src="/ops/"
        className="w-full h-full border-0"
        title="n8n Canvas Editor"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

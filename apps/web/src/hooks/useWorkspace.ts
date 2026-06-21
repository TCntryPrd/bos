/**
 * Workspace state — shared between Layout sidebar and Dashboard.
 *
 * When a connected integration is clicked in the sidebar, the workspace
 * is set to that integration's ID.  Dashboard renders a workspace view
 * instead of the tiles grid.  Setting workspace to null returns to the
 * default dashboard.
 */

import { createContext, useContext } from 'react';

export type WorkspaceType = 'n8n' | 'airtable' | 'slack' | 'stripe' | 'notion' | 'telegram' | 'make' | 'home_assistant' | 'browser' | null;

export interface WorkspaceContextValue {
  workspace: WorkspaceType;
  browserUrl: string | null;
  openWorkspace: (id: string) => void;
  openBrowser: (url: string) => void;
  closeWorkspace: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspace: null,
  browserUrl: null,
  openWorkspace: () => {},
  openBrowser: () => {},
  closeWorkspace: () => {},
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

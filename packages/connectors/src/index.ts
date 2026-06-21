/**
 * @boss/connectors — Connector Layer for BOS v2
 *
 * Provides M365 + Google Workspace integration with a unified,
 * provider-agnostic interface that the brain talks to.
 */

// Types
export * from './types.js';

// Auth
export * from './auth/index.js';

// Google connectors
export {
  GoogleClient,
  GmailConnector,
  GoogleCalendarConnector,
  GoogleTasksConnector,
  GoogleDriveConnector,
  GoogleContactsConnector,
  GoogleChatConnector,
} from './google/index.js';
export type { GoogleClientConfig, ChatMessage, ChatSpace } from './google/index.js';

// Microsoft connectors
export {
  GraphClient,
  OutlookMailConnector,
  OutlookCalendarConnector,
  MicrosoftTasksConnector,
  OneDriveConnector,
  TeamsConnector,
  MicrosoftContactsConnector,
} from './microsoft/index.js';
export type {
  GraphClientConfig,
  TeamsChannel,
  TeamsMessage,
  TeamsChat,
} from './microsoft/index.js';

// Unified interface (what the brain talks to)
export {
  UnifiedMailService,
  UnifiedCalendarService,
  UnifiedTaskService,
  UnifiedFileService,
  UnifiedContactService,
} from './unified/index.js';

// Logger
export { logger } from './logger.js';

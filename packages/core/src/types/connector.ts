/**
 * Connector types for Microsoft 365 and Google Workspace integration.
 * The unified layer abstracts over both providers.
 */

export type ConnectorProvider = 'microsoft' | 'google';

export type ConnectorService =
  | 'mail'
  | 'calendar'
  | 'tasks'
  | 'drive'
  | 'contacts'
  | 'chat';

export interface ConnectorAuth {
  provider: ConnectorProvider;
  tenantId: string;
  accountId: string;
  accountLabel: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export interface ConnectorStatus {
  provider: ConnectorProvider;
  service: ConnectorService;
  healthy: boolean;
  lastChecked: Date;
  error?: string;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyType: 'text' | 'html';
  receivedAt: Date;
  isRead: boolean;
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  location?: string;
  attendees?: string[];
  isAllDay: boolean;
  recurrence?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  dueDate?: Date;
  completed: boolean;
  priority?: 'low' | 'medium' | 'high';
  listId?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parentId?: string;
  webUrl?: string;
  createdAt: Date;
  modifiedAt: Date;
}

export interface Contact {
  id: string;
  displayName: string;
  email?: string;
  phone?: string;
  company?: string;
}

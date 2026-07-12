/**
 * Unified connector types for BOS v2.
 * These types define the provider-agnostic interfaces the brain talks to.
 */

// ── Provider & Account ──────────────────────────────────────────────

export type Provider = 'google' | 'microsoft' | 'linkedin';

export interface ConnectedAccount {
  id: string;
  provider: Provider;
  email: string;
  label: string;
  scopes: string[];
  createdAt: Date;
}

// ── OAuth / Token ───────────────────────────────────────────────────

export interface OAuthConfig {
  provider: Provider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface StoredToken {
  accountId: string;
  provider: Provider;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  /** Timestamp of when the account was first connected (maps to created_at in DB).
   *  Populated on reads from the token store. Not required when writing a new token. */
  connectedAt?: Date;
}

// ── Mail ────────────────────────────────────────────────────────────

export interface MailMessage {
  id: string;
  threadId?: string;
  accountId: string;
  provider: Provider;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  bodyHtml?: string;
  date: Date;
  isRead: boolean;
  labels?: string[];
  attachments?: Attachment[];
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface SendMailParams {
  accountId?: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  bodyHtml?: string;
  replyToMessageId?: string;
  attachments?: { filename: string; content: Buffer; mimeType: string }[];
}

export interface MailSearchParams {
  accountId?: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: Date;
  before?: Date;
  isRead?: boolean;
  maxResults?: number;
}

// ── Calendar ────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  accountId: string;
  provider: Provider;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  attendees?: EventAttendee[];
  recurrence?: string[];
  status?: 'confirmed' | 'tentative' | 'cancelled';
  organizer?: EmailAddress;
  htmlLink?: string;
}

export interface EventAttendee {
  email: string;
  name?: string;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
}

export interface CreateEventParams {
  accountId?: string;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  isAllDay?: boolean;
  attendees?: EmailAddress[];
  timeZone?: string;
  recurrence?: string[];
}

export interface UpdateEventParams extends Partial<CreateEventParams> {
  eventId: string;
}

export interface FreeBusyParams {
  accountId?: string;
  start: Date;
  end: Date;
  emails?: string[];
}

export interface FreeBusySlot {
  start: Date;
  end: Date;
}

// ── Tasks ───────────────────────────────────────────────────────────

export interface Task {
  id: string;
  accountId: string;
  provider: Provider;
  title: string;
  notes?: string;
  dueDate?: Date;
  isCompleted: boolean;
  completedAt?: Date;
  listId?: string;
  listName?: string;
  priority?: 'low' | 'medium' | 'high';
  status?: string;
}

export interface TaskList {
  id: string;
  accountId: string;
  provider: Provider;
  name: string;
}

export interface CreateTaskParams {
  accountId?: string;
  title: string;
  notes?: string;
  dueDate?: Date;
  listId?: string;
  priority?: 'low' | 'medium' | 'high';
}

export interface UpdateTaskParams extends Partial<CreateTaskParams> {
  taskId: string;
}

// ── Files / Drive ───────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  accountId: string;
  provider: Provider;
  name: string;
  mimeType: string;
  size?: number;
  createdAt?: Date;
  modifiedAt?: Date;
  parentId?: string;
  webUrl?: string;
  downloadUrl?: string;
  shared?: boolean;
}

export interface FileSearchParams {
  accountId?: string;
  query?: string;
  mimeType?: string;
  parentId?: string;
  maxResults?: number;
}

export interface UploadFileParams {
  accountId?: string;
  name: string;
  content: Buffer;
  mimeType: string;
  parentId?: string;
}

// ── Contacts ────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  accountId: string;
  provider: Provider;
  fullName: string;
  firstName?: string;
  lastName?: string;
  emails?: EmailAddress[];
  phones?: { type?: string; number: string }[];
  company?: string;
  title?: string;
  notes?: string;
}

export interface ContactSearchParams {
  accountId?: string;
  query: string;
  maxResults?: number;
}

// ── Unified Service Interfaces ──────────────────────────────────────

export interface MailService {
  listMessages(params?: MailSearchParams): Promise<MailMessage[]>;
  getMessage(messageId: string, accountId?: string): Promise<MailMessage>;
  send(params: SendMailParams): Promise<MailMessage>;
  reply(params: SendMailParams): Promise<MailMessage>;
  markAsRead(messageId: string, accountId?: string): Promise<void>;
  trash(messageId: string, accountId?: string): Promise<void>;
}

export interface CalendarService {
  listEvents(start: Date, end: Date, accountId?: string): Promise<CalendarEvent[]>;
  getEvent(eventId: string, accountId?: string): Promise<CalendarEvent>;
  createEvent(params: CreateEventParams): Promise<CalendarEvent>;
  updateEvent(params: UpdateEventParams): Promise<CalendarEvent>;
  deleteEvent(eventId: string, accountId?: string): Promise<void>;
  getFreeBusy(params: FreeBusyParams): Promise<Map<string, FreeBusySlot[]>>;
}

export interface TaskService {
  listTaskLists(accountId?: string): Promise<TaskList[]>;
  listTasks(listId?: string, accountId?: string): Promise<Task[]>;
  createTask(params: CreateTaskParams): Promise<Task>;
  updateTask(params: UpdateTaskParams): Promise<Task>;
  completeTask(taskId: string, listId?: string, accountId?: string): Promise<Task>;
  deleteTask(taskId: string, listId?: string, accountId?: string): Promise<void>;
}

export interface FileService {
  listFiles(params?: FileSearchParams): Promise<DriveFile[]>;
  getFile(fileId: string, accountId?: string): Promise<DriveFile>;
  upload(params: UploadFileParams): Promise<DriveFile>;
  download(fileId: string, accountId?: string): Promise<Buffer>;
  delete(fileId: string, accountId?: string): Promise<void>;
  search(params: FileSearchParams): Promise<DriveFile[]>;
}

export interface ContactService {
  search(params: ContactSearchParams): Promise<Contact[]>;
  getContact(contactId: string, accountId?: string): Promise<Contact>;
  listContacts(accountId?: string, maxResults?: number): Promise<Contact[]>;
}

// ── Error Types ─────────────────────────────────────────────────────

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly provider: Provider,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export class TokenExpiredError extends ConnectorError {
  constructor(provider: Provider, email: string) {
    super(`Token expired for ${email}`, provider, 'TOKEN_EXPIRED', 401);
    this.name = 'TokenExpiredError';
  }
}

export class NotConnectedError extends ConnectorError {
  constructor(provider: Provider, service?: string) {
    super(
      `Not connected to ${provider}${service ? ` ${service}` : ''}`,
      provider,
      'NOT_CONNECTED',
    );
    this.name = 'NotConnectedError';
  }
}

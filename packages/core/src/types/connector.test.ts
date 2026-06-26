/**
 * Unit tests — @boss/core connector types
 */

import { describe, it, expect } from 'vitest';
import type {
  ConnectorAuth,
  ConnectorStatus,
  ConnectorProvider,
  ConnectorService,
  MailMessage,
  CalendarEvent,
  Task,
  DriveFile,
  Contact,
} from './connector.js';

describe('ConnectorProvider', () => {
  it('accepts microsoft and google as valid providers', () => {
    const google: ConnectorProvider = 'google';
    const microsoft: ConnectorProvider = 'microsoft';

    expect(google).toBe('google');
    expect(microsoft).toBe('microsoft');
  });
});

describe('ConnectorService', () => {
  it('covers all expected service types', () => {
    const services: ConnectorService[] = ['mail', 'calendar', 'tasks', 'drive', 'contacts', 'chat'];
    expect(services).toHaveLength(6);
  });
});

describe('ConnectorAuth', () => {
  it('holds complete oauth token data', () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000);
    const auth: ConnectorAuth = {
      provider: 'google',
      tenantId: 'tenant-01',
      accountId: 'account-01',
      accountLabel: 'Work Gmail',
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAt,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    };

    expect(auth.provider).toBe('google');
    expect(auth.expiresAt).toBe(expiresAt);
    expect(auth.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });

  it('can represent a microsoft connector auth', () => {
    const auth: ConnectorAuth = {
      provider: 'microsoft',
      tenantId: 'tenant-02',
      accountId: 'account-02',
      accountLabel: 'Office 365',
      accessToken: 'eyJ0eXAiOiJKV1Q...',
      refreshToken: 'OAQABAAAAAABn...',
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scopes: ['Mail.ReadWrite', 'Calendars.ReadWrite'],
    };

    expect(auth.provider).toBe('microsoft');
    expect(auth.scopes).toContain('Mail.ReadWrite');
  });
});

describe('ConnectorStatus', () => {
  it('represents a healthy service', () => {
    const status: ConnectorStatus = {
      provider: 'google',
      service: 'calendar',
      healthy: true,
      lastChecked: new Date(),
    };

    expect(status.healthy).toBe(true);
    expect(status.error).toBeUndefined();
  });

  it('represents an unhealthy service with an error message', () => {
    const status: ConnectorStatus = {
      provider: 'microsoft',
      service: 'mail',
      healthy: false,
      lastChecked: new Date(),
      error: 'Token expired',
    };

    expect(status.healthy).toBe(false);
    expect(status.error).toBe('Token expired');
  });
});

describe('MailMessage', () => {
  it('constructs a valid mail message', () => {
    const msg: MailMessage = {
      id: 'msg-001',
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Weekly Update',
      body: 'Here is this week\'s update...',
      bodyType: 'text',
      receivedAt: new Date(),
      isRead: false,
    };

    expect(msg.id).toBe('msg-001');
    expect(msg.isRead).toBe(false);
    expect(msg.to).toContain('recipient@example.com');
  });
});

describe('CalendarEvent', () => {
  it('constructs a valid calendar event', () => {
    const start = new Date('2026-04-01T09:00:00Z');
    const end = new Date('2026-04-01T10:00:00Z');

    const event: CalendarEvent = {
      id: 'evt-001',
      title: 'Team Standup',
      start,
      end,
      isAllDay: false,
    };

    expect(event.title).toBe('Team Standup');
    expect(event.start).toBe(start);
    expect(event.isAllDay).toBe(false);
  });

  it('supports an all-day event with optional fields', () => {
    const event: CalendarEvent = {
      id: 'evt-002',
      title: 'Company Holiday',
      start: new Date('2026-04-04T00:00:00Z'),
      end: new Date('2026-04-04T23:59:59Z'),
      isAllDay: true,
      recurrence: 'RRULE:FREQ=YEARLY',
    };

    expect(event.isAllDay).toBe(true);
    expect(event.recurrence).toBe('RRULE:FREQ=YEARLY');
  });
});

describe('Task', () => {
  it('constructs a task with completion state', () => {
    const task: Task = {
      id: 'task-001',
      title: 'Send invoice to client',
      completed: false,
      priority: 'high',
    };

    expect(task.completed).toBe(false);
    expect(task.priority).toBe('high');
  });
});

describe('DriveFile', () => {
  it('constructs a drive file with required metadata', () => {
    const file: DriveFile = {
      id: 'file-001',
      name: 'Q1 Report.pdf',
      mimeType: 'application/pdf',
      size: 204800,
      createdAt: new Date(),
      modifiedAt: new Date(),
    };

    expect(file.mimeType).toBe('application/pdf');
    expect(file.size).toBe(204800);
  });
});

describe('Contact', () => {
  it('constructs a minimal contact', () => {
    const contact: Contact = {
      id: 'contact-001',
      displayName: 'John Smith',
      email: 'john@example.com',
    };

    expect(contact.displayName).toBe('John Smith');
    expect(contact.email).toBe('john@example.com');
  });
});

/**
 * Unit tests — UnifiedMailService
 *
 * Tests cover:
 * - Routing to Google vs Microsoft connector based on account provider
 * - listMessages aggregation across multiple accounts sorted by date
 * - getMessage with and without accountId
 * - send / reply routing to specific account or default
 * - markAsRead / trash routing
 * - Error when accountId is not found
 * - Graceful skip of failing accounts in listMessages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectedAccount, MailMessage, SendMailParams, MailSearchParams } from '../types.js';

// ── Mock data factory ─────────────────────────────────────────────────

function makeMailMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'msg-001',
    accountId: 'account-1',
    provider: 'google',
    from: { email: 'sender@example.com' },
    to: [{ email: 'recipient@example.com' }],
    subject: 'Hello',
    body: 'Message body',
    date: new Date('2026-03-29T10:00:00Z'),
    isRead: false,
    ...overrides,
  };
}

function makeGoogleAccount(id = 'google-acc-1'): ConnectedAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@gmail.com`,
    label: 'Gmail',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    createdAt: new Date(),
  };
}

function makeMicrosoftAccount(id = 'ms-acc-1'): ConnectedAccount {
  return {
    id,
    provider: 'microsoft',
    email: `${id}@outlook.com`,
    label: 'Outlook',
    scopes: ['Mail.ReadWrite'],
    createdAt: new Date(),
  };
}

// ── Module-level mocks using class syntax ─────────────────────────────
// We must use class-based constructors (not arrow functions) because
// UnifiedMailService calls `new GmailConnector(...)` and `new OutlookMailConnector(...)`.

// Shared state so tests can control what each mock returns
const gmailMessages: Record<string, MailMessage[]> = {};
const outlookMessages: Record<string, MailMessage[]> = {};
const gmailShouldFail: Record<string, boolean> = {};

vi.mock('../google/gmail.js', () => {
  return {
    GmailConnector: class {
      private accountId: string;

      constructor(_client: unknown, accountId: string) {
        this.accountId = accountId;
      }

      async listMessages(_params?: MailSearchParams): Promise<MailMessage[]> {
        if (gmailShouldFail[this.accountId]) throw new Error('Gmail connector failed');
        return gmailMessages[this.accountId] ?? [];
      }

      async getMessage(id: string): Promise<MailMessage> {
        const msgs = gmailMessages[this.accountId] ?? [];
        const m = msgs.find(msg => msg.id === id);
        if (!m) throw new Error(`Message ${id} not found`);
        return m;
      }

      async send(params: SendMailParams): Promise<MailMessage> {
        return makeMailMessage({ accountId: this.accountId, subject: params.subject });
      }

      async reply(params: SendMailParams): Promise<MailMessage> {
        return makeMailMessage({ accountId: this.accountId, subject: `Re: ${params.subject}` });
      }

      async markAsRead(_id: string): Promise<void> {}
      async trash(_id: string): Promise<void> {}
    },
  };
});

vi.mock('../microsoft/mail.js', () => {
  return {
    OutlookMailConnector: class {
      private accountId: string;

      constructor(_client: unknown, accountId: string) {
        this.accountId = accountId;
      }

      async listMessages(_params?: MailSearchParams): Promise<MailMessage[]> {
        return outlookMessages[this.accountId] ?? [];
      }

      async getMessage(id: string): Promise<MailMessage> {
        const msgs = outlookMessages[this.accountId] ?? [];
        const m = msgs.find(msg => msg.id === id);
        if (!m) throw new Error(`Message ${id} not found`);
        return m;
      }

      async send(params: SendMailParams): Promise<MailMessage> {
        return makeMailMessage({
          accountId: this.accountId,
          provider: 'microsoft',
          subject: params.subject,
        });
      }

      async reply(params: SendMailParams): Promise<MailMessage> {
        return makeMailMessage({
          accountId: this.accountId,
          provider: 'microsoft',
          subject: `Re: ${params.subject}`,
        });
      }

      async markAsRead(_id: string): Promise<void> {}
      async trash(_id: string): Promise<void> {}
    },
  };
});

// Import AFTER mocks are registered
import { UnifiedMailService } from './mail.js';

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset shared state before each test
  for (const key of Object.keys(gmailMessages)) delete gmailMessages[key];
  for (const key of Object.keys(outlookMessages)) delete outlookMessages[key];
  for (const key of Object.keys(gmailShouldFail)) delete gmailShouldFail[key];
});

describe('UnifiedMailService — account routing', () => {
  it('creates a service with a Google account without throwing', () => {
    const accounts = [makeGoogleAccount('g1')];
    const service = new UnifiedMailService(accounts, {} as never);
    expect(service).toBeDefined();
  });

  it('creates a service with a Microsoft account without throwing', () => {
    const accounts = [makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, undefined, {} as never);
    expect(service).toBeDefined();
  });

  it('handles both Google and Microsoft accounts simultaneously', () => {
    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);
    expect(service).toBeDefined();
  });
});

describe('UnifiedMailService — listMessages()', () => {
  it('aggregates messages from all accounts sorted by date descending', async () => {
    gmailMessages['g1'] = [
      makeMailMessage({ id: 'gmail-1', accountId: 'g1', provider: 'google', date: new Date('2026-03-29T09:00:00Z') }),
    ];
    outlookMessages['m1'] = [
      makeMailMessage({ id: 'outlook-1', accountId: 'm1', provider: 'microsoft', date: new Date('2026-03-29T08:00:00Z') }),
    ];

    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);

    const messages = await service.listMessages();
    expect(messages).toHaveLength(2);
    // Gmail message is newer (09:00) so should come first
    expect(messages[0].id).toBe('gmail-1');
    expect(messages[1].id).toBe('outlook-1');
  });

  it('routes to specific account when accountId is provided', async () => {
    gmailMessages['g1'] = [makeMailMessage({ id: 'only-gmail', accountId: 'g1', provider: 'google' })];

    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);

    const messages = await service.listMessages({ accountId: 'g1' });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('only-gmail');
  });

  it('throws when specified accountId has no connector', async () => {
    const service = new UnifiedMailService([], undefined, undefined);
    await expect(
      service.listMessages({ accountId: 'nonexistent' }),
    ).rejects.toThrow('No mail connector for account nonexistent');
  });

  it('skips failing connectors and continues with others', async () => {
    gmailShouldFail['g1'] = true;
    outlookMessages['m1'] = [makeMailMessage({ id: 'ok-msg', accountId: 'm1', provider: 'microsoft' })];

    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);

    // Should not throw even though g1 fails
    const messages = await service.listMessages();
    expect(messages.find(m => m.id === 'ok-msg')).toBeDefined();
  });
});

describe('UnifiedMailService — getMessage()', () => {
  it('fetches from specific account when accountId is provided', async () => {
    gmailMessages['g1'] = [makeMailMessage({ id: 'target-msg', accountId: 'g1', provider: 'google' })];

    const accounts = [makeGoogleAccount('g1')];
    const service = new UnifiedMailService(accounts, {} as never, undefined);

    const msg = await service.getMessage('target-msg', 'g1');
    expect(msg.id).toBe('target-msg');
  });

  it('tries all connectors when no accountId is provided', async () => {
    outlookMessages['m1'] = [makeMailMessage({ id: 'ms-msg', accountId: 'm1', provider: 'microsoft' })];

    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);

    // Google has no messages; should find in Outlook
    const msg = await service.getMessage('ms-msg');
    expect(msg.id).toBe('ms-msg');
  });

  it('throws when message not found in any connector', async () => {
    const accounts = [makeGoogleAccount('g1')];
    const service = new UnifiedMailService(accounts, {} as never, undefined);

    await expect(service.getMessage('does-not-exist')).rejects.toThrow();
  });
});

describe('UnifiedMailService — send()', () => {
  it('routes to specific account when accountId is provided', async () => {
    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);

    const result = await service.send({
      accountId: 'g1',
      to: [{ email: 'recipient@example.com' }],
      subject: 'Test email',
      body: 'Hello',
    });
    expect(result.accountId).toBe('g1');
    expect(result.subject).toBe('Test email');
  });

  it('uses default (first) connector when no accountId is provided', async () => {
    const accounts = [makeGoogleAccount('g1')];
    const service = new UnifiedMailService(accounts, {} as never, undefined);

    const result = await service.send({
      to: [{ email: 'someone@example.com' }],
      subject: 'No account',
      body: 'Body',
    });
    expect(result).toBeDefined();
    expect(result.subject).toBe('No account');
  });

  it('throws when no accounts are connected', async () => {
    const service = new UnifiedMailService([], undefined, undefined);
    await expect(
      service.send({
        to: [{ email: 'a@b.com' }],
        subject: 'Test',
        body: 'Body',
      }),
    ).rejects.toThrow('No mail accounts connected');
  });

  it('routes to Microsoft account by id', async () => {
    const accounts = [makeGoogleAccount('g1'), makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, {} as never, {} as never);

    const result = await service.send({
      accountId: 'm1',
      to: [{ email: 'recipient@corp.com' }],
      subject: 'MS Send',
      body: 'Hello',
    });
    expect(result.provider).toBe('microsoft');
  });
});

describe('UnifiedMailService — reply()', () => {
  it('calls reply on the correct Google connector', async () => {
    const accounts = [makeGoogleAccount('g1')];
    const service = new UnifiedMailService(accounts, {} as never, undefined);

    const result = await service.reply({
      accountId: 'g1',
      to: [{ email: 'a@b.com' }],
      subject: 'Hello',
      body: 'Reply',
      replyToMessageId: 'orig-msg',
    });
    expect(result.subject).toBe('Re: Hello');
  });
});

describe('UnifiedMailService — markAsRead() and trash()', () => {
  it('markAsRead with accountId does not throw', async () => {
    const accounts = [makeGoogleAccount('g1')];
    const service = new UnifiedMailService(accounts, {} as never, undefined);
    await expect(service.markAsRead('some-msg-id', 'g1')).resolves.not.toThrow();
  });

  it('trash with accountId does not throw', async () => {
    const accounts = [makeMicrosoftAccount('m1')];
    const service = new UnifiedMailService(accounts, undefined, {} as never);
    await expect(service.trash('some-msg-id', 'm1')).resolves.not.toThrow();
  });

  it('throws when connector for accountId is not found', async () => {
    const service = new UnifiedMailService([], undefined, undefined);
    await expect(service.markAsRead('msg', 'missing-account')).rejects.toThrow();
  });
});

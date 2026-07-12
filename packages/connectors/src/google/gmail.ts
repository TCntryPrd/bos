/**
 * Gmail connector — read, send, reply, search, labels.
 * Rewritten from v1 Python (services/api/app/google/gmail.py).
 */

import type { MailMessage, MailSearchParams, SendMailParams, EmailAddress, Provider } from '../types.js';
import type { GoogleClient } from './api-client.js';
import { logger } from '../logger.js';

const GMAIL_BASE = '/gmail/v1/users/me';

interface GmailHeader { name: string; value: string }
interface GmailPart {
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload: { headers: GmailHeader[]; mimeType: string; body?: { data?: string }; parts?: GmailPart[] };
  internalDate: string;
}

export class GmailConnector {
  private readonly provider: Provider = 'google';

  constructor(private client: GoogleClient, private accountId: string) {}

  async listMessages(params?: MailSearchParams): Promise<MailMessage[]> {
    const q = this.buildQuery(params);
    const data = await this.client.get<{ messages?: { id: string }[] }>(
      `${GMAIL_BASE}/messages`, { q, maxResults: String(params?.maxResults ?? 20) },
      { accountId: this.accountId },
    );
    if (!data.messages?.length) return [];

    const messages: MailMessage[] = [];
    for (const msg of data.messages) {
      try {
        const full = await this.client.get<GmailMessage>(
          `${GMAIL_BASE}/messages/${msg.id}`, { format: 'full' }, { accountId: this.accountId },
        );
        messages.push(this.parseMessage(full));
      } catch (err) {
        logger.warn({ messageId: msg.id, err }, 'Failed to fetch Gmail message');
      }
    }
    return messages;
  }

  async getMessage(messageId: string): Promise<MailMessage> {
    const data = await this.client.get<GmailMessage>(
      `${GMAIL_BASE}/messages/${messageId}`, { format: 'full' }, { accountId: this.accountId },
    );
    return this.parseMessage(data);
  }

  async send(params: SendMailParams): Promise<MailMessage> {
    const raw = this.buildMimeMessage(params);
    const data = await this.client.post<GmailMessage>(
      `${GMAIL_BASE}/messages/send`, { raw }, { accountId: this.accountId },
    );
    return this.getMessage(data.id);
  }

  async reply(params: SendMailParams): Promise<MailMessage> {
    if (!params.replyToMessageId) throw new Error('replyToMessageId required for reply');
    // Fetch the full original message to get both threadId and RFC 2822 Message-ID header
    const originalFull = await this.client.get<GmailMessage>(
      `${GMAIL_BASE}/messages/${params.replyToMessageId}`, { format: 'full' }, { accountId: this.accountId },
    );
    const originalParsed = this.parseMessage(originalFull);
    // Extract the RFC 2822 Message-ID header from the original for proper threading
    const messageIdHeader = originalFull.payload.headers
      .find((hh) => hh.name.toLowerCase() === 'message-id')?.value;
    const raw = this.buildMimeMessage(params, originalParsed.threadId, messageIdHeader);
    const data = await this.client.post<GmailMessage>(
      `${GMAIL_BASE}/messages/send`, { raw, threadId: originalParsed.threadId }, { accountId: this.accountId },
    );
    return this.getMessage(data.id);
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.client.post(
      `${GMAIL_BASE}/messages/${messageId}/modify`, { removeLabelIds: ['UNREAD'] }, { accountId: this.accountId },
    );
  }

  async trash(messageId: string): Promise<void> {
    await this.client.post(
      `${GMAIL_BASE}/messages/${messageId}/trash`, undefined, { accountId: this.accountId },
    );
  }

  private parseMessage(msg: GmailMessage): MailMessage {
    const headers = msg.payload.headers;
    const h = (name: string) => headers.find((hh) => hh.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    const body = this.extractBody(msg.payload, 'text/plain');
    const bodyHtml = this.extractBody(msg.payload, 'text/html');
    return {
      id: msg.id, threadId: msg.threadId, accountId: this.accountId, provider: this.provider,
      from: this.parseAddr(h('From')), to: this.parseAddrs(h('To')),
      cc: h('Cc') ? this.parseAddrs(h('Cc')) : undefined,
      subject: h('Subject'), body, bodyHtml: bodyHtml || undefined,
      date: new Date(parseInt(msg.internalDate, 10)),
      isRead: !(msg.labelIds ?? []).includes('UNREAD'), labels: msg.labelIds,
    };
  }

  private extractBody(payload: GmailMessage['payload'], mimeType: string): string {
    if (payload.mimeType === mimeType && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf8');
    }
    for (const part of payload.parts ?? []) {
      if (part.mimeType === mimeType && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf8');
      }
      if (part.parts) {
        const found = this.extractBody({ ...payload, mimeType: part.mimeType, parts: part.parts, body: part.body } as GmailMessage['payload'], mimeType);
        if (found) return found;
      }
    }
    return '';
  }

  private buildMimeMessage(params: SendMailParams, threadId?: string, originalMessageId?: string): string {
    const lines: string[] = [];
    lines.push(`To: ${params.to.map((a) => this.fmtAddr(a)).join(', ')}`);
    if (params.cc?.length) lines.push(`Cc: ${params.cc.map((a) => this.fmtAddr(a)).join(', ')}`);
    if (params.bcc?.length) lines.push(`Bcc: ${params.bcc.map((a) => this.fmtAddr(a)).join(', ')}`);
    lines.push(`Subject: ${params.subject}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    // Use the RFC 2822 Message-ID header for In-Reply-To/References, not the Gmail threadId.
    // This ensures correct threading in non-Gmail clients per RFC 2822 section 3.6.4.
    if (originalMessageId) {
      lines.push(`In-Reply-To: ${originalMessageId}`);
      lines.push(`References: ${originalMessageId}`);
    }
    lines.push('', params.body);
    return Buffer.from(lines.join('\r\n')).toString('base64url');
  }

  private buildQuery(params?: MailSearchParams): string {
    const p: string[] = [];
    if (params?.query) p.push(params.query);
    if (params?.from) p.push(`from:${params.from}`);
    if (params?.to) p.push(`to:${params.to}`);
    if (params?.subject) p.push(`subject:${params.subject}`);
    if (params?.after) p.push(`after:${params.after.toISOString().split('T')[0]}`);
    if (params?.before) p.push(`before:${params.before.toISOString().split('T')[0]}`);
    if (params?.isRead === true) p.push('is:read');
    if (params?.isRead === false) p.push('is:unread');
    return p.join(' ') || 'in:inbox';
  }

  private parseAddr(raw: string): EmailAddress {
    const m = raw.match(/^(.+?)\s*<(.+?)>$/);
    return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { email: raw.trim() };
  }

  private parseAddrs(raw: string): EmailAddress[] {
    return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => this.parseAddr(s));
  }

  private fmtAddr(a: EmailAddress): string {
    return a.name ? `${a.name} <${a.email}>` : a.email;
  }
}

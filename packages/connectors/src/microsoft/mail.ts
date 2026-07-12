/**
 * Outlook Mail connector via Microsoft Graph API.
 * Read, send, reply, search, mark as read, trash.
 */

import type {
  MailMessage,
  MailSearchParams,
  SendMailParams,
  EmailAddress,
  Attachment,
  Provider,
} from '../types.js';
import type { GraphClient } from './graph-client.js';
import { logger } from '../logger.js';

interface GraphMessage {
  id: string;
  conversationId?: string;
  from?: { emailAddress: { name?: string; address: string } };
  toRecipients?: { emailAddress: { name?: string; address: string } }[];
  ccRecipients?: { emailAddress: { name?: string; address: string } }[];
  bccRecipients?: { emailAddress: { name?: string; address: string } }[];
  subject: string;
  body: { contentType: string; content: string };
  receivedDateTime: string;
  isRead: boolean;
  categories?: string[];
  hasAttachments?: boolean;
  webLink?: string;
}

export class OutlookMailConnector {
  private readonly provider: Provider = 'microsoft';

  constructor(
    private client: GraphClient,
    private accountId: string,
  ) {}

  async listMessages(params?: MailSearchParams): Promise<MailMessage[]> {
    const queryParams: Record<string, string> = {
      $top: String(params?.maxResults ?? 20),
      $orderby: 'receivedDateTime desc',
      $select: 'id,conversationId,from,toRecipients,ccRecipients,subject,body,receivedDateTime,isRead,categories,hasAttachments',
    };

    // Microsoft Graph API does not allow $filter and $search in the same request
    // (returns HTTP 400). When a free-text query is provided, use $search only.
    // When structured filters (from, isRead, date range) are provided without
    // a free-text query, use $filter only.
    if (params?.query) {
      queryParams.$search = `"${params.query}"`;
    } else {
      const filter = this.buildFilter(params);
      if (filter) queryParams.$filter = filter;
    }

    const data = await this.client.get<{ value: GraphMessage[] }>(
      '/me/messages',
      queryParams,
      { accountId: this.accountId },
    );

    return data.value.map((m) => this.parseMessage(m));
  }

  async getMessage(messageId: string): Promise<MailMessage> {
    const data = await this.client.get<GraphMessage>(
      `/me/messages/${messageId}`,
      undefined,
      { accountId: this.accountId },
    );
    return this.parseMessage(data);
  }

  async send(params: SendMailParams): Promise<MailMessage> {
    const message = this.buildGraphMessage(params);

    await this.client.post(
      '/me/sendMail',
      { message, saveToSentItems: true },
      { accountId: this.accountId },
    );

    // Graph sendMail doesn't return the sent message ID, so fetch latest sent
    const sent = await this.client.get<{ value: GraphMessage[] }>(
      '/me/mailFolders/sentitems/messages',
      { $top: '1', $orderby: 'sentDateTime desc' },
      { accountId: this.accountId },
    );

    return this.parseMessage(sent.value[0]);
  }

  async reply(params: SendMailParams): Promise<MailMessage> {
    if (!params.replyToMessageId) {
      throw new Error('replyToMessageId is required for reply');
    }

    await this.client.post(
      `/me/messages/${params.replyToMessageId}/reply`,
      { comment: params.body },
      { accountId: this.accountId },
    );

    // Fetch the reply from sent items
    const sent = await this.client.get<{ value: GraphMessage[] }>(
      '/me/mailFolders/sentitems/messages',
      { $top: '1', $orderby: 'sentDateTime desc' },
      { accountId: this.accountId },
    );

    return this.parseMessage(sent.value[0]);
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.client.patch(
      `/me/messages/${messageId}`,
      { isRead: true },
      { accountId: this.accountId },
    );
  }

  async trash(messageId: string): Promise<void> {
    await this.client.post(
      `/me/messages/${messageId}/move`,
      { destinationId: 'deleteditems' },
      { accountId: this.accountId },
    );
  }

  // ── Internal ──────────────────────────────────────────────────

  private parseMessage(msg: GraphMessage): MailMessage {
    const isHtml = msg.body.contentType === 'html';

    return {
      id: msg.id,
      threadId: msg.conversationId,
      accountId: this.accountId,
      provider: this.provider,
      from: msg.from
        ? { name: msg.from.emailAddress.name, email: msg.from.emailAddress.address }
        : { email: 'unknown' },
      to: (msg.toRecipients ?? []).map((r) => ({
        name: r.emailAddress.name,
        email: r.emailAddress.address,
      })),
      cc: msg.ccRecipients?.map((r) => ({
        name: r.emailAddress.name,
        email: r.emailAddress.address,
      })),
      subject: msg.subject,
      body: isHtml ? '' : msg.body.content,
      bodyHtml: isHtml ? msg.body.content : undefined,
      date: new Date(msg.receivedDateTime),
      isRead: msg.isRead,
      labels: msg.categories,
    };
  }

  private buildGraphMessage(params: SendMailParams): Record<string, unknown> {
    return {
      subject: params.subject,
      body: {
        contentType: params.bodyHtml ? 'html' : 'text',
        content: params.bodyHtml ?? params.body,
      },
      toRecipients: params.to.map((a) => ({
        emailAddress: { name: a.name, address: a.email },
      })),
      ccRecipients: params.cc?.map((a) => ({
        emailAddress: { name: a.name, address: a.email },
      })),
      bccRecipients: params.bcc?.map((a) => ({
        emailAddress: { name: a.name, address: a.email },
      })),
    };
  }

  private buildFilter(params?: MailSearchParams): string {
    const parts: string[] = [];

    if (params?.from) {
      // Sanitize the from address to prevent OData injection via single quotes
      const sanitizedFrom = params.from.replace(/'/g, "''");
      parts.push(`from/emailAddress/address eq '${sanitizedFrom}'`);
    }
    if (params?.isRead === true) parts.push('isRead eq true');
    if (params?.isRead === false) parts.push('isRead eq false');
    if (params?.after) parts.push(`receivedDateTime ge ${params.after.toISOString()}`);
    if (params?.before) parts.push(`receivedDateTime le ${params.before.toISOString()}`);

    return parts.join(' and ');
  }
}

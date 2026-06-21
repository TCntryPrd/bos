/**
 * Unified Mail interface — provider-agnostic.
 * send(to, subject, body) -> works with either Google or Microsoft.
 */

import type {
  MailMessage,
  MailSearchParams,
  SendMailParams,
  MailService,
  ConnectedAccount,
} from '../types.js';
import { GmailConnector } from '../google/gmail.js';
import { OutlookMailConnector } from '../microsoft/mail.js';
import type { GoogleClient } from '../google/api-client.js';
import type { GraphClient } from '../microsoft/graph-client.js';
import { logger } from '../logger.js';

export class UnifiedMailService implements MailService {
  private gmailConnectors = new Map<string, GmailConnector>();
  private outlookConnectors = new Map<string, OutlookMailConnector>();

  constructor(
    private accounts: ConnectedAccount[],
    private googleClient?: GoogleClient,
    private graphClient?: GraphClient,
  ) {
    for (const account of accounts) {
      if (account.provider === 'google' && googleClient) {
        this.gmailConnectors.set(account.id, new GmailConnector(googleClient, account.id));
      } else if (account.provider === 'microsoft' && graphClient) {
        this.outlookConnectors.set(account.id, new OutlookMailConnector(graphClient, account.id));
      }
    }
  }

  async listMessages(params?: MailSearchParams): Promise<MailMessage[]> {
    if (params?.accountId) {
      return this.getConnector(params.accountId).listMessages(params);
    }

    // Aggregate from all accounts
    const allMessages: MailMessage[] = [];
    for (const [, connector] of this.allConnectors()) {
      try {
        const messages = await connector.listMessages(params);
        allMessages.push(...messages);
      } catch (err) {
        logger.warn({ err }, 'Failed to list messages from account');
      }
    }

    return allMessages.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async getMessage(messageId: string, accountId?: string): Promise<MailMessage> {
    if (accountId) {
      return this.getConnector(accountId).getMessage(messageId);
    }
    // Try all connectors
    return this.tryAll((c) => c.getMessage(messageId));
  }

  async send(params: SendMailParams): Promise<MailMessage> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.send(params);
  }

  async reply(params: SendMailParams): Promise<MailMessage> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.reply(params);
  }

  async markAsRead(messageId: string, accountId?: string): Promise<void> {
    if (accountId) {
      return this.getConnector(accountId).markAsRead(messageId);
    }
    return this.tryAll((c) => c.markAsRead(messageId));
  }

  async trash(messageId: string, accountId?: string): Promise<void> {
    if (accountId) {
      return this.getConnector(accountId).trash(messageId);
    }
    return this.tryAll((c) => c.trash(messageId));
  }

  // ── Internal ──────────────────────────────────────────────────

  private getConnector(accountId: string): MailConnector {
    const gmail = this.gmailConnectors.get(accountId);
    if (gmail) return gmail;
    const outlook = this.outlookConnectors.get(accountId);
    if (outlook) return outlook;
    throw new Error(`No mail connector for account ${accountId}`);
  }

  private defaultConnector(): MailConnector {
    const first =
      this.gmailConnectors.values().next().value ??
      this.outlookConnectors.values().next().value;
    if (!first) throw new Error('No mail accounts connected');
    return first;
  }

  private *allConnectors(): Generator<[string, MailConnector]> {
    yield* this.gmailConnectors;
    yield* this.outlookConnectors;
  }

  private async tryAll<T>(fn: (c: MailConnector) => Promise<T>): Promise<T> {
    for (const [, connector] of this.allConnectors()) {
      try {
        return await fn(connector);
      } catch {
        continue;
      }
    }
    throw new Error('Operation failed across all mail accounts');
  }
}

type MailConnector = GmailConnector | OutlookMailConnector;

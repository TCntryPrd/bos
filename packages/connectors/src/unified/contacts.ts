/**
 * Unified Contacts interface — provider-agnostic.
 * findContact(query) -> works with either Google Contacts or Microsoft People.
 */

import type {
  Contact,
  ContactSearchParams,
  ContactService,
  ConnectedAccount,
} from '../types.js';
import { GoogleContactsConnector } from '../google/contacts.js';
import { MicrosoftContactsConnector } from '../microsoft/contacts.js';
import type { GoogleClient } from '../google/api-client.js';
import type { GraphClient } from '../microsoft/graph-client.js';
import { logger } from '../logger.js';

export class UnifiedContactService implements ContactService {
  private googleContacts = new Map<string, GoogleContactsConnector>();
  private msContacts = new Map<string, MicrosoftContactsConnector>();

  constructor(
    accounts: ConnectedAccount[],
    googleClient?: GoogleClient,
    graphClient?: GraphClient,
  ) {
    for (const account of accounts) {
      if (account.provider === 'google' && googleClient) {
        this.googleContacts.set(
          account.id,
          new GoogleContactsConnector(googleClient, account.id),
        );
      } else if (account.provider === 'microsoft' && graphClient) {
        this.msContacts.set(
          account.id,
          new MicrosoftContactsConnector(graphClient, account.id),
        );
      }
    }
  }

  async search(params: ContactSearchParams): Promise<Contact[]> {
    if (params.accountId) {
      return this.getConnector(params.accountId).search(params);
    }

    // Search across all accounts, deduplicate by email
    const allContacts: Contact[] = [];
    const seenEmails = new Set<string>();

    for (const [, connector] of this.allConnectors()) {
      try {
        const contacts = await connector.search(params);
        for (const contact of contacts) {
          const primaryEmail = contact.emails?.[0]?.email;
          if (primaryEmail && seenEmails.has(primaryEmail)) continue;
          if (primaryEmail) seenEmails.add(primaryEmail);
          allContacts.push(contact);
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to search contacts');
      }
    }

    return allContacts.slice(0, params.maxResults ?? 10);
  }

  async getContact(contactId: string, accountId?: string): Promise<Contact> {
    if (accountId) {
      return this.getConnector(accountId).getContact(contactId);
    }
    return this.tryAll((c) => c.getContact(contactId));
  }

  async listContacts(accountId?: string, maxResults?: number): Promise<Contact[]> {
    if (accountId) {
      return this.getConnector(accountId).listContacts(maxResults);
    }

    const allContacts: Contact[] = [];
    for (const [, connector] of this.allConnectors()) {
      try {
        allContacts.push(...(await connector.listContacts(maxResults)));
      } catch (err) {
        logger.warn({ err }, 'Failed to list contacts');
      }
    }
    return maxResults ? allContacts.slice(0, maxResults) : allContacts;
  }

  // ── Internal ──────────────────────────────────────────────────

  private getConnector(accountId: string): ContactConnector {
    const google = this.googleContacts.get(accountId);
    if (google) return google;
    const ms = this.msContacts.get(accountId);
    if (ms) return ms;
    throw new Error(`No contact connector for account ${accountId}`);
  }

  private *allConnectors(): Generator<[string, ContactConnector]> {
    yield* this.googleContacts;
    yield* this.msContacts;
  }

  private async tryAll<T>(fn: (c: ContactConnector) => Promise<T>): Promise<T> {
    for (const [, connector] of this.allConnectors()) {
      try {
        return await fn(connector);
      } catch {
        continue;
      }
    }
    throw new Error('Operation failed across all contact accounts');
  }
}

type ContactConnector = GoogleContactsConnector | MicrosoftContactsConnector;

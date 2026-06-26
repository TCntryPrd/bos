/**
 * Microsoft Contacts connector via Graph API (People).
 */

import type { Contact, ContactSearchParams, Provider } from '../types.js';
import type { GraphClient } from './graph-client.js';

interface GraphContact {
  id: string;
  displayName: string;
  givenName?: string;
  surname?: string;
  // /me/contacts returns emailAddresses
  emailAddresses?: { address: string; name?: string }[];
  // /me/people returns scoredEmailAddresses (different shape)
  scoredEmailAddresses?: { address: string; relevanceScore?: number }[];
  phones?: { type?: string; number: string }[];
  companyName?: string;
  jobTitle?: string;
  personalNotes?: string;
}

export class MicrosoftContactsConnector {
  private readonly provider: Provider = 'microsoft';

  constructor(
    private client: GraphClient,
    private accountId: string,
  ) {}

  async search(params: ContactSearchParams): Promise<Contact[]> {
    // Use the /people endpoint for search (ranked relevance)
    const data = await this.client.get<{ value: GraphContact[] }>(
      '/me/people',
      {
        $search: `"${params.query}"`,
        $top: String(params.maxResults ?? 10),
        // /me/people returns scoredEmailAddresses, not emailAddresses
        $select: 'id,displayName,givenName,surname,scoredEmailAddresses,phones,companyName,jobTitle',
      },
      { accountId: params.accountId ?? this.accountId },
    );

    return data.value.map((c) => this.parseContact(c));
  }

  async getContact(contactId: string): Promise<Contact> {
    const data = await this.client.get<GraphContact>(
      `/me/contacts/${contactId}`,
      { $select: 'id,displayName,givenName,surname,emailAddresses,phones,companyName,jobTitle,personalNotes' },
      { accountId: this.accountId },
    );

    return this.parseContact(data);
  }

  async listContacts(maxResults?: number): Promise<Contact[]> {
    const data = await this.client.get<{ value: GraphContact[] }>(
      '/me/contacts',
      {
        $top: String(maxResults ?? 100),
        $orderby: 'displayName',
        $select: 'id,displayName,givenName,surname,emailAddresses,phones,companyName,jobTitle',
      },
      { accountId: this.accountId },
    );

    return data.value.map((c) => this.parseContact(c));
  }

  // ── Internal ──────────────────────────────────────────────────

  private parseContact(contact: GraphContact): Contact {
    // /me/contacts returns emailAddresses; /me/people returns scoredEmailAddresses.
    // Handle both shapes so search() and listContacts() produce correct results.
    let emails: { email: string; name?: string }[] | undefined;
    if (contact.emailAddresses?.length) {
      emails = contact.emailAddresses.map((e) => ({
        email: e.address,
        name: e.name,
      }));
    } else if (contact.scoredEmailAddresses?.length) {
      emails = contact.scoredEmailAddresses.map((e) => ({
        email: e.address,
      }));
    }

    return {
      id: contact.id,
      accountId: this.accountId,
      provider: this.provider,
      fullName: contact.displayName,
      firstName: contact.givenName,
      lastName: contact.surname,
      emails,
      phones: contact.phones?.map((p) => ({
        type: p.type,
        number: p.number,
      })),
      company: contact.companyName,
      title: contact.jobTitle,
      notes: contact.personalNotes,
    };
  }
}

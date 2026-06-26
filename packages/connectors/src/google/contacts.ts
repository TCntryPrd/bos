/**
 * Google Contacts connector (People API) — search, list contacts.
 */

import type { Contact, ContactSearchParams, Provider } from '../types.js';
import type { GoogleClient } from './api-client.js';

interface GPerson {
  resourceName: string;
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value: string; type?: string }[];
  phoneNumbers?: { value: string; type?: string }[];
  organizations?: { name?: string; title?: string }[];
  biographies?: { value: string }[];
}

export class GoogleContactsConnector {
  private readonly provider: Provider = 'google';
  constructor(private client: GoogleClient, private accountId: string) {}

  async search(params: ContactSearchParams): Promise<Contact[]> {
    const data = await this.client.get<{ results?: { person: GPerson }[] }>(
      'https://people.googleapis.com/v1/people:searchContacts',
      { query: params.query, readMask: 'names,emailAddresses,phoneNumbers,organizations,biographies', pageSize: String(params.maxResults ?? 10) },
      { accountId: params.accountId ?? this.accountId },
    );
    return (data.results ?? []).map((r) => this.parse(r.person));
  }

  async getContact(contactId: string): Promise<Contact> {
    const data = await this.client.get<GPerson>(
      `https://people.googleapis.com/v1/${contactId}`,
      { personFields: 'names,emailAddresses,phoneNumbers,organizations,biographies' },
      { accountId: this.accountId },
    );
    return this.parse(data);
  }

  async listContacts(maxResults?: number): Promise<Contact[]> {
    const contacts: Contact[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        personFields: 'names,emailAddresses,phoneNumbers,organizations,biographies',
        pageSize: String(Math.min(maxResults ?? 100, 100)), sortOrder: 'LAST_NAME_ASCENDING',
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await this.client.get<{ connections?: GPerson[]; nextPageToken?: string }>(
        'https://people.googleapis.com/v1/people/me/connections', params, { accountId: this.accountId },
      );
      for (const p of data.connections ?? []) contacts.push(this.parse(p));
      pageToken = data.nextPageToken;
      if (maxResults && contacts.length >= maxResults) break;
    } while (pageToken);
    return maxResults ? contacts.slice(0, maxResults) : contacts;
  }

  private parse(person: GPerson): Contact {
    const name = person.names?.[0];
    const primaryEmail = person.emailAddresses?.[0];
    return {
      id: person.resourceName, accountId: this.accountId, provider: this.provider,
      fullName: name?.displayName ?? primaryEmail?.value ?? 'Unknown',
      firstName: name?.givenName, lastName: name?.familyName,
      emails: person.emailAddresses?.map((e) => ({ email: e.value, name: e.type })),
      phones: person.phoneNumbers?.map((p) => ({ type: p.type, number: p.value })),
      company: person.organizations?.[0]?.name, title: person.organizations?.[0]?.title,
      notes: person.biographies?.[0]?.value,
    };
  }
}

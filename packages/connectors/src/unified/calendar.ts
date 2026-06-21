/**
 * Unified Calendar interface — provider-agnostic.
 * createEvent(event) -> works with either Google or Microsoft.
 */

import type {
  CalendarEvent,
  CreateEventParams,
  UpdateEventParams,
  FreeBusyParams,
  FreeBusySlot,
  CalendarService,
  ConnectedAccount,
} from '../types.js';
import { GoogleCalendarConnector } from '../google/calendar.js';
import { OutlookCalendarConnector } from '../microsoft/calendar.js';
import type { GoogleClient } from '../google/api-client.js';
import type { GraphClient } from '../microsoft/graph-client.js';
import { logger } from '../logger.js';

export class UnifiedCalendarService implements CalendarService {
  private googleCalendars = new Map<string, GoogleCalendarConnector>();
  private outlookCalendars = new Map<string, OutlookCalendarConnector>();

  constructor(
    private accounts: ConnectedAccount[],
    private googleClient?: GoogleClient,
    private graphClient?: GraphClient,
  ) {
    for (const account of accounts) {
      if (account.provider === 'google' && googleClient) {
        this.googleCalendars.set(
          account.id,
          new GoogleCalendarConnector(googleClient, account.id),
        );
      } else if (account.provider === 'microsoft' && graphClient) {
        this.outlookCalendars.set(
          account.id,
          new OutlookCalendarConnector(graphClient, account.id),
        );
      }
    }
  }

  async listEvents(start: Date, end: Date, accountId?: string): Promise<CalendarEvent[]> {
    if (accountId) {
      return this.getConnector(accountId).listEvents(start, end);
    }

    // Aggregate across all connected accounts with deduplication
    const allEvents: CalendarEvent[] = [];
    const seen = new Set<string>();

    for (const [, connector] of this.allConnectors()) {
      try {
        const events = await connector.listEvents(start, end);
        for (const event of events) {
          const dedupKey = `${event.title}|${event.start.toISOString()}`;
          if (!seen.has(dedupKey)) {
            seen.add(dedupKey);
            allEvents.push(event);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to list calendar events from account');
      }
    }

    return allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async getEvent(eventId: string, accountId?: string): Promise<CalendarEvent> {
    if (accountId) {
      return this.getConnector(accountId).getEvent(eventId);
    }
    return this.tryAll((c) => c.getEvent(eventId));
  }

  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.createEvent(params);
  }

  async updateEvent(params: UpdateEventParams): Promise<CalendarEvent> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.updateEvent(params);
  }

  async deleteEvent(eventId: string, accountId?: string): Promise<void> {
    if (accountId) {
      return this.getConnector(accountId).deleteEvent(eventId);
    }
    return this.tryAll((c) => c.deleteEvent(eventId));
  }

  async getFreeBusy(params: FreeBusyParams): Promise<Map<string, FreeBusySlot[]>> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.getFreeBusy(params);
  }

  // ── Internal ──────────────────────────────────────────────────

  private getConnector(accountId: string): CalConnector {
    const google = this.googleCalendars.get(accountId);
    if (google) return google;
    const outlook = this.outlookCalendars.get(accountId);
    if (outlook) return outlook;
    throw new Error(`No calendar connector for account ${accountId}`);
  }

  private defaultConnector(): CalConnector {
    const first =
      this.googleCalendars.values().next().value ??
      this.outlookCalendars.values().next().value;
    if (!first) throw new Error('No calendar accounts connected');
    return first;
  }

  private *allConnectors(): Generator<[string, CalConnector]> {
    yield* this.googleCalendars;
    yield* this.outlookCalendars;
  }

  private async tryAll<T>(fn: (c: CalConnector) => Promise<T>): Promise<T> {
    for (const [, connector] of this.allConnectors()) {
      try {
        return await fn(connector);
      } catch {
        continue;
      }
    }
    throw new Error('Operation failed across all calendar accounts');
  }
}

type CalConnector = GoogleCalendarConnector | OutlookCalendarConnector;

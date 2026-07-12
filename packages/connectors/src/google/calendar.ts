/**
 * Google Calendar connector — CRUD events, free/busy, multi-account aggregation.
 */

import type { CalendarEvent, CreateEventParams, UpdateEventParams, FreeBusyParams, FreeBusySlot, EventAttendee, Provider } from '../types.js';
import type { GoogleClient } from './api-client.js';
import { logger } from '../logger.js';

const CAL = '/calendar/v3';

interface GCalEvent {
  id: string; summary?: string; description?: string; location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  recurrence?: string[]; status?: string;
  organizer?: { email: string; displayName?: string }; htmlLink?: string;
}

export class GoogleCalendarConnector {
  private readonly provider: Provider = 'google';
  constructor(private client: GoogleClient, private accountId: string) {}

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const data = await this.client.get<{ items?: GCalEvent[] }>(
      `${CAL}/calendars/primary/events`,
      { timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' },
      { accountId: this.accountId },
    );
    return (data.items ?? []).map((e) => this.parse(e));
  }

  async listEventsAllAccounts(start: Date, end: Date): Promise<CalendarEvent[]> {
    const accounts = await this.client.getAllTokens();
    const all: CalendarEvent[] = [];
    const seen = new Set<string>();
    for (const account of accounts) {
      try {
        const data = await this.client.get<{ items?: GCalEvent[] }>(
          `${CAL}/calendars/primary/events`,
          { timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' },
          { accountId: account.accountId },
        );
        for (const event of data.items ?? []) {
          const parsed = this.parse(event, account.accountId);
          const key = `${parsed.title}|${parsed.start.toISOString()}`;
          if (!seen.has(key)) { seen.add(key); all.push(parsed); }
        }
      } catch (err) {
        logger.warn({ email: account.email, err }, 'Failed to fetch calendar');
      }
    }
    return all.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    const data = await this.client.get<GCalEvent>(`${CAL}/calendars/primary/events/${eventId}`, undefined, { accountId: this.accountId });
    return this.parse(data);
  }

  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    const body: Record<string, unknown> = { summary: params.title, description: params.description, location: params.location, recurrence: params.recurrence };
    const tz = params.timeZone ?? 'America/New_York';
    if (params.isAllDay) {
      body.start = { date: params.start.toISOString().split('T')[0] };
      body.end = { date: params.end.toISOString().split('T')[0] };
    } else {
      body.start = { dateTime: params.start.toISOString(), timeZone: tz };
      body.end = { dateTime: params.end.toISOString(), timeZone: tz };
    }
    if (params.attendees?.length) body.attendees = params.attendees.map((a: { email: string }) => ({ email: a.email }));
    const data = await this.client.post<GCalEvent>(`${CAL}/calendars/primary/events`, body, { accountId: params.accountId ?? this.accountId });
    return this.parse(data);
  }

  async updateEvent(params: UpdateEventParams): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (params.title !== undefined) body.summary = params.title;
    if (params.description !== undefined) body.description = params.description;
    if (params.location !== undefined) body.location = params.location;
    if (params.start && params.end) {
      const tz = params.timeZone ?? 'America/New_York';
      if (params.isAllDay) {
        body.start = { date: params.start.toISOString().split('T')[0] };
        body.end = { date: params.end.toISOString().split('T')[0] };
      } else {
        body.start = { dateTime: params.start.toISOString(), timeZone: tz };
        body.end = { dateTime: params.end.toISOString(), timeZone: tz };
      }
    }
    if (params.attendees?.length) body.attendees = params.attendees.map((a: { email: string }) => ({ email: a.email }));
    const data = await this.client.patch<GCalEvent>(`${CAL}/calendars/primary/events/${params.eventId}`, body, { accountId: params.accountId ?? this.accountId });
    return this.parse(data);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.client.delete(`${CAL}/calendars/primary/events/${eventId}`, { accountId: this.accountId });
  }

  async getFreeBusy(params: FreeBusyParams): Promise<Map<string, FreeBusySlot[]>> {
    const data = await this.client.post<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }>(
      `${CAL}/freeBusy`,
      { timeMin: params.start.toISOString(), timeMax: params.end.toISOString(), items: (params.emails ?? ['primary']).map((id) => ({ id })) },
      { accountId: params.accountId ?? this.accountId },
    );
    const result = new Map<string, FreeBusySlot[]>();
    for (const [calId, cal] of Object.entries(data.calendars)) {
      result.set(calId, cal.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })));
    }
    return result;
  }

  private parse(event: GCalEvent, overrideAccountId?: string): CalendarEvent {
    return {
      id: event.id, accountId: overrideAccountId ?? this.accountId, provider: this.provider,
      title: event.summary ?? '(No title)', description: event.description, location: event.location,
      start: new Date(event.start.dateTime ?? event.start.date!),
      end: new Date(event.end.dateTime ?? event.end.date!),
      isAllDay: !event.start.dateTime,
      attendees: event.attendees?.map((a) => ({ email: a.email, name: a.displayName, responseStatus: a.responseStatus as EventAttendee['responseStatus'] })),
      recurrence: event.recurrence,
      status: event.status as CalendarEvent['status'],
      organizer: event.organizer ? { email: event.organizer.email, name: event.organizer.displayName } : undefined,
      htmlLink: event.htmlLink,
    };
  }
}

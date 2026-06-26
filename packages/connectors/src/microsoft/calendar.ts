/**
 * Outlook Calendar connector via Microsoft Graph API.
 * CRUD events, free/busy queries.
 */

import type {
  CalendarEvent,
  CreateEventParams,
  UpdateEventParams,
  FreeBusyParams,
  FreeBusySlot,
  EventAttendee,
  Provider,
} from '../types.js';
import type { GraphClient } from './graph-client.js';

interface GraphEvent {
  id: string;
  subject: string;
  body?: { contentType: string; content: string };
  location?: { displayName: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  attendees?: {
    emailAddress: { name?: string; address: string };
    status: { response: string };
  }[];
  recurrence?: { pattern: { type: string } };
  showAs?: string;
  organizer?: { emailAddress: { name?: string; address: string } };
  webLink?: string;
}

export class OutlookCalendarConnector {
  private readonly provider: Provider = 'microsoft';

  constructor(
    private client: GraphClient,
    private accountId: string,
  ) {}

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const data = await this.client.get<{ value: GraphEvent[] }>(
      '/me/calendarView',
      {
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        $top: '250',
        $orderby: 'start/dateTime',
        $select: 'id,subject,body,location,start,end,isAllDay,attendees,recurrence,organizer,webLink',
      },
      { accountId: this.accountId },
    );

    return data.value.map((e) => this.parseEvent(e));
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    const data = await this.client.get<GraphEvent>(
      `/me/events/${eventId}`,
      undefined,
      { accountId: this.accountId },
    );
    return this.parseEvent(data);
  }

  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    const tz = params.timeZone ?? 'America/New_York';
    const body: Record<string, unknown> = {
      subject: params.title,
      body: params.description
        ? { contentType: 'text', content: params.description }
        : undefined,
      location: params.location ? { displayName: params.location } : undefined,
      start: { dateTime: params.start.toISOString(), timeZone: tz },
      end: { dateTime: params.end.toISOString(), timeZone: tz },
      isAllDay: params.isAllDay ?? false,
    };

    if (params.attendees?.length) {
      body.attendees = params.attendees.map((a) => ({
        emailAddress: { address: a.email, name: a.name },
        type: 'required',
      }));
    }

    const data = await this.client.post<GraphEvent>(
      '/me/events',
      body,
      { accountId: params.accountId ?? this.accountId },
    );

    return this.parseEvent(data);
  }

  async updateEvent(params: UpdateEventParams): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};

    if (params.title !== undefined) body.subject = params.title;
    if (params.description !== undefined) {
      body.body = { contentType: 'text', content: params.description };
    }
    if (params.location !== undefined) {
      body.location = { displayName: params.location };
    }

    if (params.start && params.end) {
      const tz = params.timeZone ?? 'America/New_York';
      body.start = { dateTime: params.start.toISOString(), timeZone: tz };
      body.end = { dateTime: params.end.toISOString(), timeZone: tz };
    }

    if (params.attendees?.length) {
      body.attendees = params.attendees.map((a) => ({
        emailAddress: { address: a.email, name: a.name },
        type: 'required',
      }));
    }

    const data = await this.client.patch<GraphEvent>(
      `/me/events/${params.eventId}`,
      body,
      { accountId: params.accountId ?? this.accountId },
    );

    return this.parseEvent(data);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.client.delete(
      `/me/events/${eventId}`,
      { accountId: this.accountId },
    );
  }

  async getFreeBusy(params: FreeBusyParams): Promise<Map<string, FreeBusySlot[]>> {
    const schedules = params.emails?.length
      ? params.emails
      : ['me'];

    const data = await this.client.post<{
      value: {
        scheduleId: string;
        scheduleItems: { start: { dateTime: string }; end: { dateTime: string } }[];
      }[];
    }>(
      '/me/calendar/getSchedule',
      {
        schedules,
        startTime: { dateTime: params.start.toISOString(), timeZone: 'UTC' },
        endTime: { dateTime: params.end.toISOString(), timeZone: 'UTC' },
      },
      { accountId: params.accountId ?? this.accountId },
    );

    const result = new Map<string, FreeBusySlot[]>();
    for (const schedule of data.value) {
      result.set(
        schedule.scheduleId,
        schedule.scheduleItems.map((item) => ({
          start: new Date(item.start.dateTime),
          end: new Date(item.end.dateTime),
        })),
      );
    }
    return result;
  }

  // ── Internal ──────────────────────────────────────────────────

  private parseEvent(event: GraphEvent): CalendarEvent {
    return {
      id: event.id,
      accountId: this.accountId,
      provider: this.provider,
      title: event.subject,
      description: event.body?.content,
      location: event.location?.displayName,
      start: new Date(event.start.dateTime),
      end: new Date(event.end.dateTime),
      isAllDay: event.isAllDay,
      attendees: event.attendees?.map((a) => ({
        email: a.emailAddress.address,
        name: a.emailAddress.name,
        responseStatus: this.mapResponseStatus(a.status.response),
      })),
      status: event.showAs === 'free' ? 'tentative' : 'confirmed',
      organizer: event.organizer
        ? { email: event.organizer.emailAddress.address, name: event.organizer.emailAddress.name }
        : undefined,
      htmlLink: event.webLink,
    };
  }

  private mapResponseStatus(status: string): EventAttendee['responseStatus'] {
    const map: Record<string, EventAttendee['responseStatus']> = {
      accepted: 'accepted',
      declined: 'declined',
      tentativelyAccepted: 'tentative',
      notResponded: 'needsAction',
    };
    return map[status] ?? 'needsAction';
  }
}

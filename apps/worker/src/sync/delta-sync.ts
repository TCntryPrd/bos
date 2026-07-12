/**
 * DeltaSync — fetches only changes since the last sync timestamp from each
 * connected platform and writes them into the local Postgres cache.
 *
 * Strategy per service type:
 *   Gmail      — users.history.list (historyId cursor stored in Redis via
 *                SyncScheduler). Falls back to a date-bounded search on first run.
 *   Graph mail — /me/mailFolders/Inbox/messages/delta (deltaLink token).
 *   Calendar   — Google: events.list(updatedMin). Graph: /me/calendarView/delta.
 *   Tasks      — full list diff (neither API exposes an incremental endpoint);
 *                small enough that a full refresh every cycle is acceptable.
 *   Drive      — Google: files.list(modifiedTime > last). Graph: /me/drive/root/delta.
 *   Contacts   — Google People API (syncToken). Graph: /me/contacts/delta.
 *
 * All methods are self-contained and receive only what they need so the class
 * can be unit-tested without a real connector stack.
 */

import type { CacheStore } from './cache-store.js';
import type {
  UpsertEmailParams,
  UpsertEventParams,
  UpsertTaskParams,
  UpsertContactParams,
  UpsertFileParams,
} from './cache-store.js';

// ---------------------------------------------------------------------------
// Structural API client interfaces
// These mirror the actual GoogleClient / GraphClient without importing them,
// keeping the worker free of a hard dependency on @boss/connectors at
// compile time. At runtime the real clients are injected.
// ---------------------------------------------------------------------------

export interface HttpGetClient {
  get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    opts?: { accountId?: string },
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Delta cursors — thin wrappers around the Redis-tracked cursor values
// ---------------------------------------------------------------------------

export interface DeltaCursors {
  getHistoryId(accountId: string, service: string): Promise<string | null>;
  setHistoryId(accountId: string, service: string, cursor: string): Promise<void>;
  getDeltaLink(accountId: string, service: string): Promise<string | null>;
  setDeltaLink(accountId: string, service: string, link: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// DeltaSync result
// ---------------------------------------------------------------------------

export interface DeltaSyncResult {
  service: string;
  added: number;
  updated: number;
  deleted: number;
  durationMs: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Internal Gmail response shapes
// ---------------------------------------------------------------------------

interface GmailHistoryResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: { id: string } }>;
    messagesDeleted?: Array<{ message: { id: string } }>;
    labelsAdded?: Array<{ message: { id: string; labelIds?: string[] } }>;
    labelsRemoved?: Array<{ message: { id: string; labelIds?: string[] } }>;
  }>;
  historyId?: string;
  nextPageToken?: string;
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
  };
  internalDate: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Internal Graph delta shapes
// ---------------------------------------------------------------------------

interface GraphDeltaResponse<T> {
  value: T[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

interface GraphMessage {
  id: string;
  from?: { emailAddress: { name?: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name?: string; address: string } }>;
  subject: string;
  bodyPreview: string;
  receivedDateTime: string;
  isRead: boolean;
  categories?: string[];
  '@removed'?: { reason: string };
}

interface GraphEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees?: Array<{ emailAddress: { address: string } }>;
  '@removed'?: { reason: string };
}

interface GraphContact {
  id: string;
  displayName: string;
  emailAddresses?: Array<{ address: string }>;
  mobilePhone?: string;
  companyName?: string;
  '@removed'?: { reason: string };
}

interface GraphDriveItem {
  id: string;
  name: string;
  file?: { mimeType: string };
  size?: number;
  lastModifiedDateTime?: string;
  parentReference?: { path: string };
  '@removed'?: { reason: string };
}

// ---------------------------------------------------------------------------
// DeltaSync
// ---------------------------------------------------------------------------

export class DeltaSync {
  constructor(
    private readonly store: CacheStore,
    private readonly cursors: DeltaCursors,
  ) {}

  // ── Gmail ─────────────────────────────────────────────────────────────────

  async syncGmail(
    tenantId: string,
    accountId: string,
    googleClient: HttpGetClient,
    lastSyncAt: Date | null,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const base = '/gmail/v1/users/me';
    let added = 0;
    let deleted = 0;

    const savedHistoryId = await this.cursors.getHistoryId(accountId, 'gmail');

    if (savedHistoryId) {
      // Incremental: walk history records
      let pageToken: string | undefined;
      let latestHistoryId = savedHistoryId;
      const toFetch = new Set<string>();
      const toDelete = new Set<string>();

      do {
        const params: Record<string, string> = {
          startHistoryId: savedHistoryId,
          historyTypes: 'messageAdded,messageDeleted,labelAdded,labelRemoved',
        };
        if (pageToken) params.pageToken = pageToken;

        const page = await googleClient.get<GmailHistoryResponse>(
          `${base}/history`,
          params,
          { accountId },
        );

        for (const h of page.history ?? []) {
          if (h.id > latestHistoryId) latestHistoryId = h.id;
          for (const item of h.messagesAdded ?? []) toFetch.add(item.message.id);
          for (const item of h.messagesDeleted ?? []) toDelete.add(item.message.id);
          // Label changes mean the message needs re-fetch
          for (const item of h.labelsAdded ?? []) toFetch.add(item.message.id);
          for (const item of h.labelsRemoved ?? []) toFetch.add(item.message.id);
        }

        pageToken = page.nextPageToken;
      } while (pageToken);

      // Batch-fetch full messages for everything that changed
      const rows: UpsertEmailParams[] = [];
      for (const msgId of toFetch) {
        try {
          const msg = await googleClient.get<GmailMessageFull>(
            `${base}/messages/${msgId}`,
            { format: 'full' },
            { accountId },
          );
          rows.push(this.parseGmailMessage(tenantId, accountId, msg));
        } catch {
          // Message may have been deleted between history page and now — skip
        }
      }

      await this.store.upsertEmails(rows);
      for (const msgId of toDelete) {
        await this.store.deleteEmail(tenantId, accountId, msgId);
      }

      added = rows.length;
      deleted = toDelete.size;
      await this.cursors.setHistoryId(accountId, 'gmail', latestHistoryId);
    } else {
      // First run: pull recent messages and record the current historyId
      const since = lastSyncAt ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const afterSec = Math.floor(since.getTime() / 1000);
      const list = await googleClient.get<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(
        `${base}/messages`,
        { q: `after:${afterSec}`, maxResults: '200' },
        { accountId },
      );

      const rows: UpsertEmailParams[] = [];
      for (const item of list.messages ?? []) {
        try {
          const msg = await googleClient.get<GmailMessageFull>(
            `${base}/messages/${item.id}`,
            { format: 'full' },
            { accountId },
          );
          rows.push(this.parseGmailMessage(tenantId, accountId, msg));
        } catch {
          // skip broken messages
        }
      }
      await this.store.upsertEmails(rows);
      added = rows.length;

      // Record the current profile historyId so next run is incremental
      const profile = await googleClient.get<{ historyId: string }>(
        `${base}/profile`,
        {},
        { accountId },
      );
      await this.cursors.setHistoryId(accountId, 'gmail', profile.historyId);
    }

    return { service: 'gmail', added, updated: 0, deleted, durationMs: Date.now() - start };
  }

  // ── Outlook Mail (Graph delta) ────────────────────────────────────────────

  async syncOutlookMail(
    tenantId: string,
    accountId: string,
    graphClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    let added = 0;
    let deleted = 0;

    const savedDeltaLink = await this.cursors.getDeltaLink(accountId, 'outlook_mail');

    const startUrl = savedDeltaLink
      ? savedDeltaLink
      : '/me/mailFolders/Inbox/messages/delta?$select=id,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,categories&$top=100';

    let url: string | undefined = startUrl;
    let finalDeltaLink: string | undefined;
    const rows: UpsertEmailParams[] = [];
    const toDelete: string[] = [];

    while (url) {
      const page: GraphDeltaResponse<GraphMessage> = await graphClient.get<GraphDeltaResponse<GraphMessage>>(url, {}, { accountId });

      for (const item of page.value) {
        if (item['@removed']) {
          toDelete.push(item.id);
          deleted++;
        } else {
          rows.push(this.parseGraphMessage(tenantId, accountId, item));
          added++;
        }
      }

      finalDeltaLink = page['@odata.deltaLink'];
      url = page['@odata.nextLink'];
    }

    await this.store.upsertEmails(rows);
    for (const id of toDelete) {
      await this.store.deleteEmail(tenantId, accountId, id);
    }

    if (finalDeltaLink) {
      await this.cursors.setDeltaLink(accountId, 'outlook_mail', finalDeltaLink);
    }

    return { service: 'outlook_mail', added, updated: 0, deleted, durationMs: Date.now() - start };
  }

  // ── Google Calendar ───────────────────────────────────────────────────────

  async syncGoogleCalendar(
    tenantId: string,
    accountId: string,
    googleClient: HttpGetClient,
    lastSyncAt: Date | null,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const since = lastSyncAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const data = await googleClient.get<{
      items?: Array<{
        id: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        location?: string;
        attendees?: Array<{ email: string }>;
        status?: string;
      }>;
    }>(
      '/calendar/v3/calendars/primary/events',
      {
        updatedMin: since.toISOString(),
        maxResults: '500',
        singleEvents: 'true',
        showDeleted: 'true',
        orderBy: 'updated',
      },
      { accountId },
    );

    const rows: UpsertEventParams[] = [];
    let deleted = 0;

    for (const item of data.items ?? []) {
      if (item.status === 'cancelled') {
        await this.store.deleteEvent(tenantId, accountId, item.id);
        deleted++;
        continue;
      }
      const startDt = item.start?.dateTime ?? item.start?.date ?? '';
      const endDt = item.end?.dateTime ?? item.end?.date ?? '';
      rows.push({
        tenant_id: tenantId,
        account_id: accountId,
        event_id: item.id,
        title: item.summary ?? '(No title)',
        start: new Date(startDt),
        end: new Date(endDt),
        attendees: (item.attendees ?? []).map((a) => a.email),
        location: item.location ?? null,
      });
    }

    await this.store.upsertEvents(rows);
    return {
      service: 'google_calendar',
      added: rows.length,
      updated: 0,
      deleted,
      durationMs: Date.now() - start,
    };
  }

  // ── Outlook Calendar (Graph delta) ────────────────────────────────────────

  async syncOutlookCalendar(
    tenantId: string,
    accountId: string,
    graphClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const savedDeltaLink = await this.cursors.getDeltaLink(accountId, 'outlook_calendar');
    const now = new Date();
    const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const startUrl = savedDeltaLink
      ? savedDeltaLink
      : `/me/calendarView/delta?startDateTime=${windowStart}&endDateTime=${windowEnd}&$top=100`;

    let url: string | undefined = startUrl;
    let finalDeltaLink: string | undefined;
    const rows: UpsertEventParams[] = [];
    const toDelete: string[] = [];

    while (url) {
      const page: GraphDeltaResponse<GraphEvent> = await graphClient.get<GraphDeltaResponse<GraphEvent>>(url, {}, { accountId });

      for (const item of page.value) {
        if (item['@removed']) {
          toDelete.push(item.id);
        } else {
          rows.push({
            tenant_id: tenantId,
            account_id: accountId,
            event_id: item.id,
            title: item.subject ?? '(No title)',
            start: new Date(item.start.dateTime),
            end: new Date(item.end.dateTime),
            attendees: (item.attendees ?? []).map((a: { emailAddress: { address: string } }) => a.emailAddress.address),
            location: item.location?.displayName ?? null,
          });
        }
      }

      finalDeltaLink = page['@odata.deltaLink'];
      url = page['@odata.nextLink'];
    }

    await this.store.upsertEvents(rows);
    for (const id of toDelete) {
      await this.store.deleteEvent(tenantId, accountId, id);
    }

    if (finalDeltaLink) {
      await this.cursors.setDeltaLink(accountId, 'outlook_calendar', finalDeltaLink);
    }

    return {
      service: 'outlook_calendar',
      added: rows.length,
      updated: 0,
      deleted: toDelete.length,
      durationMs: Date.now() - start,
    };
  }

  // ── Tasks (full refresh — no incremental API on either platform) ──────────

  async syncGoogleTasks(
    tenantId: string,
    accountId: string,
    googleClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();

    const listsData = await googleClient.get<{
      items?: Array<{ id: string; title: string }>;
    }>('/tasks/v1/users/@me/lists', {}, { accountId });

    const rows: UpsertTaskParams[] = [];
    for (const list of listsData.items ?? []) {
      const tasks = await googleClient.get<{
        items?: Array<{
          id: string;
          title: string;
          status: string;
          due?: string;
        }>;
      }>(
        `/tasks/v1/lists/${list.id}/tasks`,
        { showCompleted: 'false', maxResults: '200' },
        { accountId },
      );

      for (const t of tasks.items ?? []) {
        rows.push({
          tenant_id: tenantId,
          account_id: accountId,
          task_id: t.id,
          title: t.title,
          status: t.status,
          due: t.due ? new Date(t.due) : null,
          list: list.title,
        });
      }
    }

    await this.store.upsertTasks(rows);
    return { service: 'google_tasks', added: rows.length, updated: 0, deleted: 0, durationMs: Date.now() - start };
  }

  async syncMicrosoftTasks(
    tenantId: string,
    accountId: string,
    graphClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();

    const listsData = await graphClient.get<{
      value?: Array<{ id: string; displayName: string }>;
    }>('/me/todo/lists', {}, { accountId });

    const rows: UpsertTaskParams[] = [];
    for (const list of listsData.value ?? []) {
      const tasks = await graphClient.get<{
        value?: Array<{
          id: string;
          title: string;
          status: string;
          dueDateTime?: { dateTime: string };
        }>;
      }>(
        `/me/todo/lists/${list.id}/tasks`,
        { $filter: "status ne 'completed'", $top: '200' },
        { accountId },
      );

      for (const t of tasks.value ?? []) {
        rows.push({
          tenant_id: tenantId,
          account_id: accountId,
          task_id: t.id,
          title: t.title,
          status: t.status,
          due: t.dueDateTime ? new Date(t.dueDateTime.dateTime) : null,
          list: list.displayName,
        });
      }
    }

    await this.store.upsertTasks(rows);
    return { service: 'ms_tasks', added: rows.length, updated: 0, deleted: 0, durationMs: Date.now() - start };
  }

  // ── Google Drive ──────────────────────────────────────────────────────────

  async syncGoogleDrive(
    tenantId: string,
    accountId: string,
    googleClient: HttpGetClient,
    lastSyncAt: Date | null,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const since = lastSyncAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const data = await googleClient.get<{
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        size?: string;
        modifiedTime?: string;
        parents?: string[];
        trashed?: boolean;
      }>;
    }>(
      '/drive/v3/files',
      {
        q: `modifiedTime > '${since.toISOString()}' and trashed = false`,
        fields: 'files(id,name,mimeType,size,modifiedTime,parents)',
        pageSize: '500',
      },
      { accountId },
    );

    const rows: UpsertFileParams[] = [];
    for (const f of data.files ?? []) {
      rows.push({
        tenant_id: tenantId,
        account_id: accountId,
        file_id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        path: f.parents?.[0] ?? null,
        size: f.size ? parseInt(f.size, 10) : null,
        modified: f.modifiedTime ? new Date(f.modifiedTime) : null,
      });
    }

    await this.store.upsertFiles(rows);
    return { service: 'google_drive', added: rows.length, updated: 0, deleted: 0, durationMs: Date.now() - start };
  }

  // ── OneDrive (Graph delta) ────────────────────────────────────────────────

  async syncOneDrive(
    tenantId: string,
    accountId: string,
    graphClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const savedDeltaLink = await this.cursors.getDeltaLink(accountId, 'onedrive');
    const startUrl = savedDeltaLink ?? '/me/drive/root/delta?$select=id,name,file,size,lastModifiedDateTime,parentReference&$top=200';

    let url: string | undefined = startUrl;
    let finalDeltaLink: string | undefined;
    const rows: UpsertFileParams[] = [];
    const toDelete: string[] = [];

    while (url) {
      const page: GraphDeltaResponse<GraphDriveItem> = await graphClient.get<GraphDeltaResponse<GraphDriveItem>>(url, {}, { accountId });

      for (const item of page.value) {
        if (item['@removed']) {
          toDelete.push(item.id);
        } else if (item.file) {
          rows.push({
            tenant_id: tenantId,
            account_id: accountId,
            file_id: item.id,
            name: item.name,
            mime_type: item.file.mimeType,
            path: item.parentReference?.path ?? null,
            size: item.size ?? null,
            modified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
          });
        }
      }

      finalDeltaLink = page['@odata.deltaLink'];
      url = page['@odata.nextLink'];
    }

    await this.store.upsertFiles(rows);
    for (const id of toDelete) {
      await this.store.deleteFile(tenantId, accountId, id);
    }

    if (finalDeltaLink) {
      await this.cursors.setDeltaLink(accountId, 'onedrive', finalDeltaLink);
    }

    return {
      service: 'onedrive',
      added: rows.length,
      updated: 0,
      deleted: toDelete.length,
      durationMs: Date.now() - start,
    };
  }

  // ── Google Contacts ───────────────────────────────────────────────────────

  async syncGoogleContacts(
    tenantId: string,
    accountId: string,
    googleClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const syncToken = await this.cursors.getHistoryId(accountId, 'google_contacts');

    const params: Record<string, string> = {
      personFields: 'names,emailAddresses,phoneNumbers,organizations',
      pageSize: '500',
    };
    if (syncToken) {
      params.syncToken = syncToken;
      params.requestSyncToken = 'true';
    } else {
      params.requestSyncToken = 'true';
    }

    const data = await googleClient.get<{
      connections?: Array<{
        resourceName: string;
        names?: Array<{ displayName: string }>;
        emailAddresses?: Array<{ value: string }>;
        phoneNumbers?: Array<{ value: string }>;
        organizations?: Array<{ name: string }>;
        metadata?: { deleted?: boolean };
      }>;
      nextSyncToken?: string;
    }>('/v1/people/me/connections', params, { accountId });

    const rows: UpsertContactParams[] = [];
    for (const c of data.connections ?? []) {
      if (c.metadata?.deleted) continue;
      rows.push({
        tenant_id: tenantId,
        account_id: accountId,
        contact_id: c.resourceName,
        name: c.names?.[0]?.displayName ?? '',
        email: c.emailAddresses?.[0]?.value ?? null,
        phone: c.phoneNumbers?.[0]?.value ?? null,
        company: c.organizations?.[0]?.name ?? null,
      });
    }

    await this.store.upsertContacts(rows);

    if (data.nextSyncToken) {
      await this.cursors.setHistoryId(accountId, 'google_contacts', data.nextSyncToken);
    }

    return { service: 'google_contacts', added: rows.length, updated: 0, deleted: 0, durationMs: Date.now() - start };
  }

  // ── Microsoft Contacts (Graph delta) ─────────────────────────────────────

  async syncMicrosoftContacts(
    tenantId: string,
    accountId: string,
    graphClient: HttpGetClient,
  ): Promise<DeltaSyncResult> {
    const start = Date.now();
    const savedDeltaLink = await this.cursors.getDeltaLink(accountId, 'ms_contacts');
    const startUrl = savedDeltaLink ?? '/me/contacts/delta?$select=id,displayName,emailAddresses,mobilePhone,companyName&$top=200';

    let url: string | undefined = startUrl;
    let finalDeltaLink: string | undefined;
    const rows: UpsertContactParams[] = [];

    while (url) {
      const page: GraphDeltaResponse<GraphContact> = await graphClient.get<GraphDeltaResponse<GraphContact>>(url, {}, { accountId });

      for (const item of page.value) {
        if (item['@removed']) continue;
        rows.push({
          tenant_id: tenantId,
          account_id: accountId,
          contact_id: item.id,
          name: item.displayName ?? '',
          email: item.emailAddresses?.[0]?.address ?? null,
          phone: item.mobilePhone ?? null,
          company: item.companyName ?? null,
        });
      }

      finalDeltaLink = page['@odata.deltaLink'];
      url = page['@odata.nextLink'];
    }

    await this.store.upsertContacts(rows);

    if (finalDeltaLink) {
      await this.cursors.setDeltaLink(accountId, 'ms_contacts', finalDeltaLink);
    }

    return { service: 'ms_contacts', added: rows.length, updated: 0, deleted: 0, durationMs: Date.now() - start };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private parseGmailMessage(
    tenantId: string,
    accountId: string,
    msg: GmailMessageFull,
  ): UpsertEmailParams {
    const headers = msg.payload.headers;
    const h = (name: string) =>
      headers.find((hh) => hh.name.toLowerCase() === name.toLowerCase())?.value ?? '';

    return {
      tenant_id: tenantId,
      account_id: accountId,
      message_id: msg.id,
      from_address: h('from'),
      to_addresses: h('to')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      subject: h('subject'),
      snippet: msg.snippet ?? '',
      date: new Date(parseInt(msg.internalDate, 10)),
      is_read: !(msg.labelIds ?? []).includes('UNREAD'),
      labels: msg.labelIds ?? [],
    };
  }

  private parseGraphMessage(
    tenantId: string,
    accountId: string,
    msg: GraphMessage,
  ): UpsertEmailParams {
    return {
      tenant_id: tenantId,
      account_id: accountId,
      message_id: msg.id,
      from_address: msg.from
        ? `${msg.from.emailAddress.name ?? ''} <${msg.from.emailAddress.address}>`.trim()
        : '',
      to_addresses: (msg.toRecipients ?? []).map(
        (r) => `${r.emailAddress.name ?? ''} <${r.emailAddress.address}>`.trim(),
      ),
      subject: msg.subject ?? '',
      snippet: msg.bodyPreview ?? '',
      date: new Date(msg.receivedDateTime),
      is_read: msg.isRead,
      labels: msg.categories ?? [],
    };
  }
}

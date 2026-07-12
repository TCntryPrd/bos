/**
 * Google Workspace tool definitions for BOS brain tool calling.
 *
 * These are the BrainTool descriptors the brain receives so it knows what
 * Google APIs it can invoke and what parameters each call requires.
 * Execution logic lives in executor.ts.
 */

import type { BrainTool } from '@boss/brain';

// ── Calendar ─────────────────────────────────────────────────────────────────

export const calendarTodayTool: BrainTool = {
  name: 'boss_calendar_today',
  description:
    "Get all calendar events scheduled for today. Returns a formatted list of the user's events including time, title, location, and attendees.",
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          "IANA timezone name to use when determining 'today', e.g. 'America/New_York'. Defaults to UTC.",
      },
    },
    required: [],
  },
};

export const calendarUpcomingTool: BrainTool = {
  name: 'boss_calendar_upcoming',
  description:
    "Get calendar events for the next 7 days starting from now. Returns a formatted list grouped by date.",
  parameters: {
    type: 'object',
    properties: {
      days: {
        type: 'number',
        description: 'Number of days to look ahead (1–30). Defaults to 7.',
      },
      timezone: {
        type: 'string',
        description: "IANA timezone name, e.g. 'America/New_York'. Defaults to UTC.",
      },
    },
    required: [],
  },
};

export const calendarCreateTool: BrainTool = {
  name: 'boss_calendar_create',
  description:
    'Create a new calendar event. Returns the created event details including its ID and link.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Event title / summary.',
      },
      start: {
        type: 'string',
        description: 'Start datetime in ISO 8601 format, e.g. "2025-04-01T14:00:00-04:00".',
      },
      end: {
        type: 'string',
        description: 'End datetime in ISO 8601 format, e.g. "2025-04-01T15:00:00-04:00".',
      },
      description: {
        type: 'string',
        description: 'Optional event description / notes.',
      },
      location: {
        type: 'string',
        description: 'Optional event location or meeting link.',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of attendee email addresses.',
      },
      timezone: {
        type: 'string',
        description: "IANA timezone for the event, e.g. 'America/New_York'. Defaults to UTC.",
      },
    },
    required: ['title', 'start', 'end'],
  },
};

// ── Gmail ─────────────────────────────────────────────────────────────────────

/** Shared param: which connected Google account (inbox) to act on. */
const googleAccountParam = {
  type: 'string',
  description:
    'Which connected Google account (inbox email) to act on, e.g. "kevin@starrpartners.ai" or "d.caine@dcaine.com". Omit to use the default (most recently updated) account. ALWAYS set this when working across multiple inboxes.',
} as const;

export const gmailUnreadTool: BrainTool = {
  name: 'boss_gmail_unread',
  description:
    'Get unread emails currently in the inbox (newest first, no time limit). Returns sender, subject, date, and a short snippet for each message.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      max_results: {
        type: 'number',
        description: 'Maximum number of messages to return (1–50). Defaults to 10.',
      },
    },
    required: [],
  },
};

export const gmailSearchTool: BrainTool = {
  name: 'boss_gmail_search',
  description:
    'Search Gmail using a Gmail search query (same syntax as the Gmail search box). Returns matching messages with sender, subject, date, and snippet.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      query: {
        type: 'string',
        description:
          'Gmail search query string. Examples: "from:alice@example.com", "subject:invoice", "is:unread has:attachment".',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of messages to return (1–50). Defaults to 10.',
      },
    },
    required: ['query'],
  },
};

export const gmailSendTool: BrainTool = {
  name: 'boss_gmail_send',
  description:
    'Send an email via Gmail. Returns confirmation with the sent message ID.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of recipient email addresses.',
      },
      subject: {
        type: 'string',
        description: 'Email subject line.',
      },
      body: {
        type: 'string',
        description: 'Plain-text email body.',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional CC recipients.',
      },
    },
    required: ['to', 'subject', 'body'],
  },
};

export const gmailReadTool: BrainTool = {
  name: 'boss_gmail_read',
  description:
    'Read the full content of a specific email by message ID. Returns headers, body text, and labels.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID to read.' },
    },
    required: ['message_id'],
  },
};

export const gmailArchiveTool: BrainTool = {
  name: 'boss_gmail_archive',
  description:
    'Archive an email (remove from inbox). The email remains searchable but leaves the inbox view.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID to archive.' },
    },
    required: ['message_id'],
  },
};

export const gmailMarkReadTool: BrainTool = {
  name: 'boss_gmail_mark_read',
  description:
    'Mark an email as read (remove UNREAD label).',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID to mark as read.' },
    },
    required: ['message_id'],
  },
};

export const gmailLabelTool: BrainTool = {
  name: 'boss_gmail_label',
  description:
    'Add or remove labels on an email. Use Gmail label IDs (e.g., INBOX, UNREAD, STARRED, IMPORTANT, or custom label IDs).',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID.' },
      add_labels: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add.' },
      remove_labels: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove.' },
    },
    required: ['message_id'],
  },
};

export const gmailReplyTool: BrainTool = {
  name: 'boss_gmail_reply',
  description:
    'Reply to an existing email thread. The reply is sent to the original sender with proper In-Reply-To headers.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID of the email to reply to.' },
      thread_id: { type: 'string', description: 'Gmail thread ID (from the original message).' },
      body: { type: 'string', description: 'Plain-text reply body.' },
    },
    required: ['message_id', 'thread_id', 'body'],
  },
};

// ── Gmail drafting + quick-ack (phased-autonomy surface) ───────────────────────

export const gmailDraftTool: BrainTool = {
  name: 'boss_gmail_draft',
  description:
    'Create a NEW email draft in the account\'s Gmail Drafts folder. Does NOT send — the draft waits for human review and manual send. Use for substantive outgoing email during the review/fine-tuning phase.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      to: { type: 'array', items: { type: 'string' }, description: 'List of recipient email addresses.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body: { type: 'string', description: 'Plain-text email body.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients.' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export const gmailDraftReplyTool: BrainTool = {
  name: 'boss_gmail_draft_reply',
  description:
    'Draft a REPLY to an existing email thread and save it to Gmail Drafts. Does NOT send — the drafted reply waits for human review. This is the primary tool for P1/P2 reply drafting in Kevin\'s voice.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID of the email to reply to.' },
      thread_id: { type: 'string', description: 'Gmail thread ID (from the original message).' },
      body: { type: 'string', description: 'Plain-text reply body, written in Kevin\'s voice.' },
    },
    required: ['message_id', 'thread_id', 'body'],
  },
};

export const gmailQuickAckTool: BrainTool = {
  name: 'boss_gmail_quick_ack',
  description:
    'Auto-SEND a brief acknowledgement reply (length-capped) to an email thread — e.g. "Got it, I\'ll get back to you by Thursday." For short, safe acknowledgements ONLY. Substantive replies must use boss_gmail_draft_reply. The send goes out immediately, so use only when a one-line acknowledgement is clearly appropriate.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      message_id: { type: 'string', description: 'Gmail message ID of the email to acknowledge.' },
      thread_id: { type: 'string', description: 'Gmail thread ID (from the original message).' },
      body: { type: 'string', description: 'Short acknowledgement text (max ~600 chars). Keep it to 1-3 sentences.' },
    },
    required: ['message_id', 'thread_id', 'body'],
  },
};

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const tasksPendingTool: BrainTool = {
  name: 'boss_tasks_pending',
  description:
    'Get all pending (incomplete) tasks from Google Tasks. Returns task title, notes, and due date for each.',
  parameters: {
    type: 'object',
    properties: {
      list_id: {
        type: 'string',
        description:
          'Optional Google Tasks list ID to filter by. Omit to query the default task list.',
      },
    },
    required: [],
  },
};

export const tasksCreateTool: BrainTool = {
  name: 'boss_tasks_create',
  description:
    'Create a new task in Google Tasks. Returns the created task with its ID.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Task title.',
      },
      notes: {
        type: 'string',
        description: 'Optional task notes or description.',
      },
      due_date: {
        type: 'string',
        description: 'Optional due date in ISO 8601 format, e.g. "2025-04-01".',
      },
      list_id: {
        type: 'string',
        description: 'Optional task list ID. Defaults to the primary task list.',
      },
    },
    required: ['title'],
  },
};

export const tasksCompleteTool: BrainTool = {
  name: 'boss_tasks_complete',
  description:
    'Mark a task as complete in Google Tasks. Returns confirmation with the task title.',
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The Google Tasks task ID to mark complete.',
      },
      list_id: {
        type: 'string',
        description: 'Optional task list ID. Defaults to the primary task list.',
      },
    },
    required: ['task_id'],
  },
};

export const tasksDeleteTool: BrainTool = {
  name: 'boss_tasks_delete',
  description: 'Delete a task from Google Tasks permanently.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The Google Tasks task ID to delete.' },
      list_id: { type: 'string', description: 'Optional task list ID. Defaults to the primary task list.' },
    },
    required: ['task_id'],
  },
};

// ── Drive ─────────────────────────────────────────────────────────────────────

export const driveSearchTool: BrainTool = {
  name: 'boss_drive_search',
  description:
    'Search for files in Google Drive by name or content. Returns file name, type, last modified date, and link.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query — matched against file names and content. Example: "Q1 budget" or "meeting notes March".',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of files to return (1–50). Defaults to 10.',
      },
    },
    required: ['query'],
  },
};

export const driveRecentTool: BrainTool = {
  name: 'boss_drive_recent',
  description:
    'Get recently modified files from Google Drive. Returns the most recently changed files with name, type, and link.',
  parameters: {
    type: 'object',
    properties: {
      max_results: {
        type: 'number',
        description: 'Maximum number of files to return (1–25). Defaults to 10.',
      },
    },
    required: [],
  },
};

export const driveReadDocTool: BrainTool = {
  name: 'boss_drive_read_doc',
  description:
    'Read the text content of a Google Doc by its file ID or URL. Extracts all text from the document. Use this when you need to understand or summarize a document found via drive search.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      file_id: {
        type: 'string',
        description:
          'The Google Doc file ID. Extract from URLs like docs.google.com/document/d/{FILE_ID}/edit. Can also be the full URL — the ID will be extracted.',
      },
    },
    required: ['file_id'],
  },
};

export const driveCreateDocTool: BrainTool = {
  name: 'boss_drive_create_doc',
  description:
    'Create a NEW Google Doc with a title and text content, optionally inside a specific Drive folder. Use to save a written summary or report back into Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      google_account: googleAccountParam,
      title: { type: 'string', description: 'The document title / file name.' },
      content: { type: 'string', description: 'Full plain-text content of the document (newlines preserved).' },
      folder_id: { type: 'string', description: 'Optional Drive folder ID to create the doc in. Omit for My Drive root.' },
    },
    required: ['title', 'content'],
  },
};

// ── Contacts ─────────────────────────────────────────────────────────────────

export const contactsSearchTool: BrainTool = {
  name: 'boss_contacts_search',
  description:
    'Search Google Contacts by name or email address. Returns matching contacts with name, email(s), phone(s), and company.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Name or email address to search for.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of contacts to return (1–25). Defaults to 5.',
      },
    },
    required: ['query'],
  },
};

// ── Google platform (steward) ───────────────────────────────────────────────
export const googleRegistryTool: BrainTool = {
  name: 'boss_google_registry',
  description:
    'The Google API registry — for each Google API: how it authenticates (per-account OAuth vs an API key in a specific Cloud project), whether it is enabled, and its cost model. Use to answer which credential/key an agent should use, or which Google surfaces are available.',
  parameters: { type: 'object', properties: {}, required: [] },
};
export const googleUsageTool: BrainTool = {
  name: 'boss_google_usage',
  description:
    'Google API usage + estimated cost rollup (today and last 30 days, by API). Use to report Google platform spend.',
  parameters: { type: 'object', properties: {}, required: [] },
};

// ── Full export list ──────────────────────────────────────────────────────────

// READ-ONLY tools — safe for autonomous use (Confidence Tier 1)
export const READONLY_GOOGLE_TOOLS: BrainTool[] = [
  calendarTodayTool,
  calendarUpcomingTool,
  gmailUnreadTool,
  gmailSearchTool,
  gmailReadTool,
  tasksPendingTool,
  driveSearchTool,
  driveRecentTool,
  driveReadDocTool,
  contactsSearchTool,
  googleRegistryTool,
  googleUsageTool,
];

// WRITE tools — require explicit user request (Confidence Tier 2+)
// DO NOT include these in default tool set until confidence engine is built
export const WRITE_GOOGLE_TOOLS: BrainTool[] = [
  calendarCreateTool,
  gmailSendTool,
  gmailArchiveTool,
  gmailMarkReadTool,
  gmailLabelTool,
  gmailReplyTool,
  gmailDraftTool,
  gmailDraftReplyTool,
  gmailQuickAckTool,
  tasksCreateTool,
  tasksCompleteTool,
  tasksDeleteTool,
  driveCreateDocTool,
];

// Full tool set — the confidence engine (not tool availability) gates autonomous actions.
export const ALL_GOOGLE_TOOLS: BrainTool[] = [...READONLY_GOOGLE_TOOLS, ...WRITE_GOOGLE_TOOLS];

/**
 * Email agent tool definitions for BOS brain tool calling.
 *
 * Reads from the boss_email_log table populated by the n8n email processing
 * workflow. The brain uses these tools to answer questions about email without
 * hitting Gmail directly — the log is the source of truth for processed mail.
 *
 * Tools are always available (no external API key required — reads Postgres).
 * The email log is populated by the n8n workflow via POST /api/email/process.
 */

import type { BrainTool } from '@boss/brain';

export const emailAttentionTool: BrainTool = {
  name: 'boss_email_attention',
  description:
    'Get the emails currently needing your attention, as processed and analysed by BOS\'s email agent. ' +
    'Returns up to 5 unresolved attention items with BOS\'s analysis of each. ' +
    'Use this instead of boss_gmail_unread when the user asks "what emails need my attention?" or ' +
    '"what did BOS flag?" — this reads the processed log, not the raw inbox. ' +
    'Each result includes the sender, subject, category, and BOS\'s summary of why it needs attention.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const emailDigestTool: BrainTool = {
  name: 'boss_email_digest',
  description:
    'Get a summary of email activity processed by the BOS email agent. ' +
    'Returns: total emails processed today, count per category (newsletter/invoice/client/etc), ' +
    'number of open attention items, invoices due in the next 7 days, and golden nuggets ' +
    '(key insights) extracted from newsletters over the last 7 days. ' +
    'Use this when the user asks for an email summary, daily digest, or "what came in today."',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const emailLogWriteTool: BrainTool = {
  name: 'boss_email_log_write',
  description:
    'Record a processed email into the BOS email log so it appears in the dashboard digest + attention list and the COO can see what was handled. ' +
    'Call this once per email you process. Set needs_attention=true for P1/P2 or client items that need Kevin. For bills/invoices, include invoice_amount + invoice_due_date.',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Gmail message ID.' },
      account_email: { type: 'string', description: 'Which inbox this came from (the google_account).' },
      sender: { type: 'string', description: 'Sender name/email.' },
      subject: { type: 'string', description: 'Subject line.' },
      category: { type: 'string', description: 'Your category, e.g. P1_URGENT, P2_REPLY_NEEDED, P3_EYES_ONLY, AUTOMATED, PROMO, BILL.' },
      needs_attention: { type: 'boolean', description: 'true if this needs Kevin (P1/P2/client). Defaults false.' },
      action_taken: { type: 'string', description: 'What you did, e.g. "drafted reply", "archived", "marked read", "quick-ack sent".' },
      draft_created: { type: 'boolean', description: 'true if you created a draft reply.' },
      invoice_amount: { type: 'number', description: 'For BILL: amount in dollars.' },
      invoice_due_date: { type: 'string', description: 'For BILL: due date YYYY-MM-DD.' },
      golden_nugget: { type: 'string', description: 'An insight worth remembering from this email.' },
      boss_notes: { type: 'string', description: 'One line on why it needs attention / what Kevin should know.' },
    },
    required: ['message_id', 'account_email', 'sender', 'subject', 'category'],
  },
};

// All email agent tools — always registered (reads/writes internal Postgres, no external key)
export const ALL_EMAIL_AGENT_TOOLS: BrainTool[] = [
  emailAttentionTool,
  emailDigestTool,
  emailLogWriteTool,
];

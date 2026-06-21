/**
 * Email-draft brain tools: the Email Agent records each reply draft it writes
 * (so it can be rated) and reads recent ratings back to learn. Pair with the
 * "Email Drafts" dashboard tile where Kevin rates 👍/👎 + leaves notes.
 */
import type { BrainTool } from '@boss/brain';
import { recordEmailDraft, recentDraftFeedback } from '../lib/email-drafts.js';

export const emailDraftRecordTool: BrainTool = {
  name: 'boss_email_draft_record',
  description:
    'Record a reply draft you just created (via boss_gmail_draft) so the human can rate it and you can learn. Call this right after drafting each reply.',
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'The email account the draft is for.' },
      toAddr: { type: 'string', description: 'Recipient address.' },
      subject: { type: 'string', description: 'The draft subject line.' },
      replySubject: { type: 'string', description: 'Subject of the email being replied to (context).' },
      body: { type: 'string', description: 'The exact draft body text you wrote.' },
    },
    required: ['account', 'body'],
  },
};

export const emailDraftFeedbackTool: BrainTool = {
  name: 'boss_email_draft_feedback',
  description:
    'Review recent human ratings of your past reply drafts (thumbs up/down + notes). Call this BEFORE drafting replies and apply the lessons — especially fix anything rated down.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'How many recent rated drafts to review (default 12).' } },
  },
};

export const ALL_EMAIL_DRAFT_TOOLS: BrainTool[] = [emailDraftRecordTool, emailDraftFeedbackTool];

async function handleDraftRecord(args: Record<string, unknown>): Promise<string> {
  const account = String(args.account ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (!account || !body) throw new Error('account and body are required');
  const id = await recordEmailDraft({
    account, body,
    toAddr: args.toAddr ? String(args.toAddr) : undefined,
    subject: args.subject ? String(args.subject) : undefined,
    replySubject: args.replySubject ? String(args.replySubject) : undefined,
  });
  return `Draft recorded for rating (id ${id}).`;
}

async function handleDraftFeedback(args: Record<string, unknown>): Promise<string> {
  const limit = typeof args.limit === 'number' ? args.limit : 12;
  const rows = await recentDraftFeedback(limit);
  if (!rows.length) return "No rated drafts yet — no feedback to apply yet. Draft in Kevin's brand voice and record each draft.";
  const lines = rows.map((r) => {
    const v = r.rating && r.rating > 0 ? '👍 GOOD' : '👎 NEEDS WORK';
    const note = r.rating_note ? ` — note: "${r.rating_note}"` : '';
    const subj = r.subject ?? r.reply_subject ?? '';
    return `[${v}] ${r.account} "${subj}"${note}\n   draft: ${r.body.slice(0, 180)}${r.body.length > 180 ? '…' : ''}`;
  });
  return `Recent draft ratings — learn from these (repeat the 👍 patterns, fix the 👎 ones, follow any notes):\n${lines.join('\n')}`;
}

export const EMAIL_DRAFT_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_email_draft_record: handleDraftRecord,
  boss_email_draft_feedback: handleDraftFeedback,
};

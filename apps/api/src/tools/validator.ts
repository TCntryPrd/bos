/**
 * Email-draft VALIDATOR brain tools — the Validator agent's "second pair of eyes."
 * The drafter must not grade its own homework, so a separate agent pulls drafts that
 * have not been judged yet (verdict IS NULL), inspects them, and records a verdict
 * (pass | needs_human | block) plus structured issues + short flags. The verdict shows
 * as a risk badge on the Email Drafts dashboard tile.
 *
 * Pairs with apps/api/src/lib/email-drafts.ts (pendingValidationDrafts, validateEmailDraft).
 * Tool shape + import style mirror apps/api/src/tools/email-drafts.ts exactly.
 *
 * Deploy target: apps/api/src/tools/validator.ts
 */
import type { BrainTool } from '@boss/brain';
import { pendingValidationDrafts, validateEmailDraft, type DraftIssue } from '../lib/email-drafts.js';

export const emailDraftsPendingTool: BrainTool = {
  name: 'boss_email_drafts_pending',
  description:
    'List reply drafts that have NOT been validated yet (no verdict). Call this at the start of each validation run to get the work queue. ' +
    'Returns each draft id, account, subjects, and the full body so you can check it against the source email before recording a verdict.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many pending drafts to pull this run (default 10, max 50). Oldest first.' },
    },
  },
};

export const emailDraftValidateTool: BrainTool = {
  name: 'boss_email_draft_validate',
  description:
    'Record your verdict on ONE reply draft after reviewing it against the source email. ' +
    'verdict: "block" if ANY HIGH-severity issue (hallucinated fact, unauthorized commitment, PII/confidential to wrong recipient, wrong recipient/reply-all risk); ' +
    '"needs_human" if any MEDIUM issue (tone/persona mismatch) or the body contains a [NEEDS KEVIN] flag; "pass" only if zero issues and no [NEEDS KEVIN] flag. ' +
    'Provide the issues you found and short flags. On block/needs_human also send Kevin a Telegram heads-up.',
  parameters: {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'The draft id from boss_email_drafts_pending.' },
      verdict: { type: 'string', enum: ['pass', 'needs_human', 'block'], description: 'pass | needs_human | block.' },
      issues: {
        type: 'array',
        description: 'Findings. Each item is { severity: "HIGH"|"MEDIUM"|"LOW", detail: string }. Plain strings are accepted and treated as MEDIUM.',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            detail: { type: 'string' },
          },
          required: ['detail'],
        },
      },
      flags: {
        type: 'array',
        description: 'Short labels, e.g. ["needs-kevin","unauthorized-commitment","wrong-recipient"].',
        items: { type: 'string' },
      },
    },
    required: ['draftId', 'verdict'],
  },
};

export const ALL_VALIDATOR_TOOLS: BrainTool[] = [emailDraftsPendingTool, emailDraftValidateTool];

// ── Handlers ────────────────────────────────────────────────────────────────

async function handlePendingDrafts(args: Record<string, unknown>): Promise<string> {
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const rows = await pendingValidationDrafts(limit);
  if (!rows.length) return 'No drafts awaiting validation. Nothing to do this run — respond done and exit.';
  const lines = rows.map((r) => {
    const subj = r.subject ?? r.reply_subject ?? '(no subject)';
    return `id=${r.id} | account=${r.account} | to=${r.to_addr ?? '?'} | subject="${subj}"\n   body: ${r.body}`;
  });
  return `Drafts awaiting validation (${rows.length}) — review each against its source email, then call boss_email_draft_validate per draft:\n${lines.join('\n\n')}`;
}

/** Accept either [{severity,detail}] objects or plain strings (strings => MEDIUM). */
function coerceIssues(raw: unknown): DraftIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftIssue[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const detail = item.trim();
      if (detail) out.push({ severity: 'MEDIUM', detail });
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const detail = String(rec.detail ?? '').trim();
      if (!detail) continue;
      const sevRaw = String(rec.severity ?? 'MEDIUM').toUpperCase();
      const severity: DraftIssue['severity'] = sevRaw === 'HIGH' || sevRaw === 'LOW' ? sevRaw : 'MEDIUM';
      out.push({ severity, detail });
    }
  }
  return out;
}

function coerceFlags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => String(f).trim()).filter(Boolean).slice(0, 12);
}

async function handleValidate(args: Record<string, unknown>): Promise<string> {
  const draftId = String(args.draftId ?? '').trim();
  const verdict = String(args.verdict ?? '').trim() as 'pass' | 'needs_human' | 'block';
  if (!draftId) throw new Error('draftId is required');
  if (verdict !== 'pass' && verdict !== 'needs_human' && verdict !== 'block') {
    throw new Error("verdict must be 'pass', 'needs_human', or 'block'");
  }
  const issues = coerceIssues(args.issues);
  const flags = coerceFlags(args.flags);
  const ok = await validateEmailDraft(draftId, verdict, issues, flags);
  if (!ok) return `Draft ${draftId} not found (already removed or wrong id). No verdict recorded.`;
  const issueStr = issues.length ? ` | ${issues.length} issue(s): ${issues.map((i) => `${i.severity}:${i.detail}`).join('; ')}` : '';
  const flagStr = flags.length ? ` | flags: ${flags.join(',')}` : '';
  return `Recorded verdict "${verdict}" on draft ${draftId}.${issueStr}${flagStr}`;
}

export const VALIDATOR_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_email_drafts_pending: handlePendingDrafts,
  boss_email_draft_validate: handleValidate,
};

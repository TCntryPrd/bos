/**
 * Email Triage Background Agent
 *
 * Runs every 15 minutes inside the API container. Process:
 *   1. Fetch unread inbox emails via Gmail API
 *   2. For each email, read full content
 *   3. Classify: newsletter, invoice, personal, client, marketing, other
 *   4. Take action: archive newsletters, flag client/personal for attention,
 *      extract invoice amounts, draft replies where appropriate
 *   5. Log everything to boss_email_log
 *
 * This is NOT an n8n workflow — it's a BOS sub-agent that uses the brain
 * to classify and decide actions, then executes via Gmail API tools directly.
 */

import { getPool } from '../db.js';
import { executeTool } from '../tools/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_EMAILS_PER_PAGE = 100; // Gmail API page size
const MAX_EMAILS_PER_RUN = 500; // Hard cap per run to avoid runaway processing
const TENANT_ID = 'default';

// ── State ────────────────────────────────────────────────────────────────────

let isRunning = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastRunAt: Date | null = null;
let lastRunResults: { processed: number; errors: number } = { processed: 0, errors: 0 };

// ── Types ────────────────────────────────────────────────────────────────────

interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  labels: string[];
}

type EmailCategory = 'newsletter' | 'invoice' | 'personal' | 'client' | 'marketing' | 'other';
type EmailPriority = 'P1_URGENT' | 'P2_REPLY_NEEDED' | 'P3_EYES_ONLY' | 'AUTOMATED' | 'PROMO';

interface TriageDecision {
  category: EmailCategory;
  priority: EmailPriority;
  needsAttention: boolean;
  action: 'archive' | 'mark_read' | 'flag_attention' | 'draft_reply' | 'none';
  notes: string;
  invoiceAmount?: number;
  invoiceDueDate?: string;
  goldenNugget?: string;
}

// Account-specific rules
const PERSONAL_ACCOUNTS = ['absoluterecoverybureau@gmail.com', 'travelcraft.dc@gmail.com'];
const BUSINESS_ACCOUNTS = ['kevin@starrpartners.ai', 'd.caine@dcaine.com'];
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// ── Classification — priority-based triage ───────────────────────────────────
//
// P1_URGENT:       Client reply waiting, urgent keyword, payment issue → Telegram alert + draft
// P2_REPLY_NEEDED: Active conversation, meeting request, question → draft reply
// P3_EYES_ONLY:    FYI client update, invoice, known person non-urgent → keep in inbox, read
// AUTOMATED:       Receipts, confirmations, shipping, system notifications → archive
// PROMO:           Marketing, newsletters, sales pitches → archive (immediate for ARB/TC)
//
// Kevin's directive: only active reply conversations stay in inbox.
// Everything else gets read, logged, and archived.

function classifyEmail(email: ParsedEmail, accountEmail: string): TriageDecision {
  const from = email.from.toLowerCase();
  const subject = email.subject.toLowerCase();
  const body = email.body.toLowerCase().slice(0, 2000);
  const isPersonalAccount = PERSONAL_ACCOUNTS.some(a => accountEmail.toLowerCase().includes(a));

  // ── Signal detection ──────────────────────────────────────
  //
  // CONTENT FIRST, SENDER SECOND.
  // The same person can be a friend, colleague, competitor, client, and project partner.
  // What matters is what the EMAIL is asking Kevin to DO, not who sent it.

  // ── CONTENT-BASED ACTION DETECTION (fires first, overrides sender logic) ────

  // Document action required — signatures, reviews, approvals
  const docActionPatterns = [
    'please sign', 'signature required', 'review and sign', 'sign this',
    'docusign', 'hellosign', 'adobe sign', 'pandadoc', 'signable',
    'e-signature', 'esignature', 'electronically sign',
    'attached for your review', 'please review the attached', 'see attached',
    'find attached', 'attached document', 'attached agreement', 'attached contract',
    'needs your signature', 'awaiting your signature', 'sign and return',
    'review and approve', 'approval needed', 'please approve',
    'for your review', 'for your approval', 'document for review',
    'please complete', 'complete and return', 'fill out',
  ];
  const needsDocAction = docActionPatterns.some(p => subject.includes(p) || body.slice(0, 1000).includes(p));

  // Has attachments (check email labels/structure)
  const hasAttachments = email.labels.includes('has-attachment') ||
    body.includes('attached') || body.includes('attachment') ||
    subject.includes('attached') || subject.includes('document');

  // Contract/legal/money signals — always needs attention regardless of sender
  const contractPatterns = [
    'contract', 'agreement', 'sow', 'statement of work', 'scope of work',
    'proposal', 'engagement letter', 'terms and conditions', 'nda',
    'non-disclosure', 'msa', 'master service', 'addendum', 'amendment',
    'memorandum of understanding', 'mou', 'letter of intent', 'loi',
  ];
  const isContract = contractPatterns.some(p => subject.includes(p) || body.slice(0, 500).includes(p));

  // Deadline signals — time-sensitive regardless of sender
  const deadlinePatterns = [
    'by end of day', 'by eod', 'by tomorrow', 'by friday', 'by monday',
    'due by', 'due date', 'expires', 'expiring', 'last day',
    'deadline', 'time sensitive', 'before the deadline', 'final notice',
    'respond by', 'reply by', 'needed by',
  ];
  const hasDeadline = deadlinePatterns.some(p => subject.includes(p) || body.slice(0, 500).includes(p));

  // Payment/money incoming — someone paying Kevin or discussing payment
  const paymentPatterns = [
    'payment sent', 'wire transfer', 'ach transfer', 'zelle',
    'venmo', 'paypal', 'paid you', 'check is in', 'check mailed',
    'retainer', 'deposit', 'milestone payment',
  ];
  const hasPayment = paymentPatterns.some(p => subject.includes(p) || body.slice(0, 500).includes(p));

  // ── SENDER-BASED SIGNALS (used as context, not as primary classifier) ───────

  // Automated/system signals
  const automatedPatterns = [
    'noreply', 'no-reply', 'donotreply', 'notifications@', 'notification@',
    'eservices@', 'customercare@', 'support@', 'billing@', 'receipt', 'confirmation',
    'your order', 'shipping update', 'delivery notification', 'password reset',
    'two-factor', '2fa', 'verification code', 'sign-in', 'login alert',
    'automated message', 'do not reply to this email',
  ];
  const isAutomated = automatedPatterns.some(p => from.includes(p) || subject.includes(p) || body.slice(0, 300).includes(p));

  // Promo/marketing signals
  const promoPatterns = [
    'unsubscribe', 'opt out', 'email preferences', 'manage subscriptions',
    'promotions@', 'marketing@', 'deals@', 'sales@', 'offer@',
    '% off', 'limited time', 'exclusive offer', 'act now', 'don\'t miss',
    'free trial', 'special price', 'flash sale',
  ];
  const isPromo = promoPatterns.some(p => from.includes(p) || body.includes(p));

  // Newsletter signals (valuable content, not just marketing)
  const isNewsletter = body.includes('unsubscribe') && !isPromo &&
    (from.includes('newsletter') || from.includes('digest') || from.includes('update') ||
     body.includes('this week') || body.includes('top stories') || body.includes('roundup'));

  const isHuman = !isAutomated && !isPromo && !isNewsletter;

  // Conversation signals
  const isReply = subject.startsWith('re:') || subject.startsWith('fwd:');

  // Urgency signals
  const urgentKeywords = ['urgent', 'asap', 'emergency', 'critical', 'deadline today',
    'payment failed', 'account suspended', 'security alert', 'action required immediately'];
  const hasUrgency = urgentKeywords.some(k => subject.includes(k) || body.slice(0, 500).includes(k));

  // Meeting/scheduling signals
  const meetingKeywords = ['meeting', 'calendar invite', 'scheduled call', 'zoom link', 'teams meeting',
    'let\'s meet', 'can we talk', 'available for a call'];
  const isMeeting = meetingKeywords.some(k => subject.includes(k) || body.slice(0, 300).includes(k));

  // Question/request signals (someone wants Kevin to do something)
  const questionSignals = ['?', 'can you', 'could you', 'would you', 'please review',
    'your thoughts', 'what do you think', 'need your input', 'waiting on', 'following up'];
  const hasQuestion = questionSignals.some(k => subject.includes(k) || body.slice(0, 500).includes(k));

  // Invoice signals
  const invoicePatterns = ['invoice', 'payment due', 'amount due', 'statement', 'overdue', 'past due'];
  const isInvoice = invoicePatterns.some(p => subject.includes(p) || body.slice(0, 500).includes(p));

  // ── Priority assignment ──────────────────────────────────
  //
  // RULE: Content determines priority. Sender provides context.
  // A signature request from a friend is still P1.
  // A newsletter from a client is still a newsletter.

  // ══════════════════════════════════════════════════════════
  // TIER 0: CONTENT-BASED OVERRIDES — fire regardless of sender
  // These catch action-required emails no matter who sends them.
  // ══════════════════════════════════════════════════════════

  // P1: Document needs signature or approval — ALWAYS needs attention
  if (needsDocAction && isHuman) {
    return {
      category: 'client', priority: 'P1_URGENT',
      needsAttention: true, action: 'flag_attention',
      notes: `📝 DOCUMENT ACTION REQUIRED: ${email.from}: "${email.subject}" — signature/review/approval needed`,
    };
  }

  // P1: Contract, agreement, SOW — ALWAYS needs attention
  if (isContract && isHuman) {
    return {
      category: 'client', priority: 'P1_URGENT',
      needsAttention: true, action: 'flag_attention',
      notes: `📋 CONTRACT/AGREEMENT: ${email.from}: "${email.subject}" — legal document needs review`,
    };
  }

  // P1: Has deadline — time-sensitive, needs attention
  if (hasDeadline && isHuman) {
    return {
      category: 'client', priority: 'P1_URGENT',
      needsAttention: true, action: 'flag_attention',
      notes: `⏰ DEADLINE: ${email.from}: "${email.subject}" — time-sensitive action required`,
    };
  }

  // P1: Urgency keywords
  if (hasUrgency && isHuman) {
    return {
      category: 'client', priority: 'P1_URGENT',
      needsAttention: true, action: 'flag_attention',
      notes: `🔴 URGENT: ${email.from}: "${email.subject}" — needs reply within 2h`,
    };
  }

  // P2: Payment notification — Kevin should know about incoming money
  if (hasPayment && isHuman) {
    return {
      category: 'invoice', priority: 'P2_REPLY_NEEDED',
      needsAttention: true, action: 'flag_attention',
      notes: `💰 PAYMENT: ${email.from}: "${email.subject}" — payment activity`,
    };
  }

  // ══════════════════════════════════════════════════════════
  // TIER 1: Auto-disposable — clear junk, regardless of content
  // ══════════════════════════════════════════════════════════

  // Personal accounts (ARB/TC): archive ALL promo/automated immediately
  if (isPersonalAccount) {
    if (isPromo || isNewsletter || isAutomated) {
      return {
        category: isPromo || isNewsletter ? 'marketing' : 'other',
        priority: isPromo || isNewsletter ? 'PROMO' : 'AUTOMATED',
        needsAttention: false, action: 'archive',
        notes: `[${accountEmail}] Personal account — auto-archived: ${email.from}`,
      };
    }
    // Personal account, real human email — still P3 archive but log
    return {
      category: 'personal', priority: 'P3_EYES_ONLY', needsAttention: false, action: 'archive',
      notes: `[${accountEmail}] Personal email logged: ${email.from}: "${email.subject}"`,
    };
  }

  // AUTOMATED: System emails, confirmations, receipts (business accounts)
  if (isAutomated) {
    return {
      category: 'other', priority: 'AUTOMATED',
      needsAttention: false, action: 'archive',
      notes: `Automated: ${email.from}: "${email.subject}"`,
    };
  }

  // PROMO: Marketing, newsletters (business accounts)
  if (isPromo || isNewsletter) {
    const nugget = isNewsletter ? extractNugget(email.subject, email.body) : null;
    return {
      category: isNewsletter ? 'newsletter' : 'marketing', priority: 'PROMO',
      needsAttention: false, action: 'archive',
      notes: `${isNewsletter ? 'Newsletter' : 'Promo'}: ${email.from}`,
      goldenNugget: nugget ?? undefined,
    };
  }

  // ══════════════════════════════════════════════════════════
  // TIER 2: Human emails — classify by what they're asking
  // ══════════════════════════════════════════════════════════

  // P2: Active conversation (reply thread from a human)
  if (isReply && isHuman) {
    return {
      category: 'personal', priority: 'P2_REPLY_NEEDED',
      needsAttention: true, action: 'flag_attention',
      notes: `Active conversation: ${email.from}: "${email.subject}"`,
    };
  }

  // P2: Meeting or scheduling request
  if (isMeeting && isHuman) {
    return {
      category: 'personal', priority: 'P2_REPLY_NEEDED',
      needsAttention: true, action: 'flag_attention',
      notes: `Meeting request: ${email.from}: "${email.subject}"`,
    };
  }

  // P2: Direct question or request for Kevin to do something
  if (hasQuestion && isHuman) {
    return {
      category: 'personal', priority: 'P2_REPLY_NEEDED',
      needsAttention: true, action: 'flag_attention',
      notes: `Question/request: ${email.from}: "${email.subject}"`,
    };
  }

  // P2: Human email with attachments — someone sent Kevin files to look at
  if (hasAttachments && isHuman && !isAutomated) {
    return {
      category: 'personal', priority: 'P2_REPLY_NEEDED',
      needsAttention: true, action: 'flag_attention',
      notes: `📎 Has attachments: ${email.from}: "${email.subject}" — documents may need review`,
    };
  }

  // P3: Invoice — process, extract, but keep if from a human
  if (isInvoice) {
    const amount = extractAmount(body);
    const dueDate = extractDueDate(body);
    return {
      category: 'invoice', priority: 'P3_EYES_ONLY',
      needsAttention: true, action: 'flag_attention',
      notes: `Invoice: ${email.from}. ${amount ? `$${amount}` : ''} ${dueDate ? `Due: ${dueDate}` : ''}`,
      invoiceAmount: amount ?? undefined, invoiceDueDate: dueDate ?? undefined,
    };
  }

  // P2: Any remaining human email that isn't promo/automated — err on the side of showing Kevin
  if (isHuman) {
    return {
      category: 'personal', priority: 'P2_REPLY_NEEDED',
      needsAttention: true, action: 'flag_attention',
      notes: `Human email: ${email.from}: "${email.subject}" — needs review`,
    };
  }

  // Everything else — archive
  const nugget = extractNugget(email.subject, email.body);
  return {
    category: 'other', priority: 'P3_EYES_ONLY',
    needsAttention: false, action: 'archive',
    notes: `Processed: ${email.from}: "${email.subject}"`,
    goldenNugget: nugget ?? undefined,
  };
}

// ── Telegram P1 alerting ─────────────────────────────────────────────────────

// ── Triple notification: Telegram + Slack + BOS push ─────────────────────
//
// P1/P2 emails blast all three channels. Kevin ignores one? He'll see the others.

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_ALERT_CHANNEL = 'C0A5BFG0RU7'; // #all-the-kevin-starr-operating-system

async function sendTelegramAlert(message: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn('[email-triage] No TELEGRAM_BOT_TOKEN — skipping Telegram alert');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message.slice(0, 4000),
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      // Retry without parse_mode in case of formatting issues
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message.slice(0, 4000) }),
      });
    }
  } catch (err) {
    console.error('[email-triage] Telegram send failed:', err);
  }
}

async function sendSlackAlert(message: string): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: SLACK_ALERT_CHANNEL,
        text: message.slice(0, 3000),
        unfurl_links: false,
      }),
    });
    if (!res.ok) {
      console.error('[email-triage] Slack send failed:', res.status);
    }
  } catch (err) {
    console.error('[email-triage] Slack send failed:', err);
  }
}

async function sendBossPush(title: string, body: string, priority: string): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO boss_notifications (title, body, priority, channel, created_at, read)
       VALUES ($1, $2, $3, 'email-triage', NOW(), false)`,
      [title.slice(0, 200), body.slice(0, 2000), priority],
    );
  } catch {
    // Table may not exist yet — create it
    try {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_notifications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          body TEXT,
          priority TEXT DEFAULT 'P2',
          channel TEXT DEFAULT 'system',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          read BOOLEAN DEFAULT false
        )
      `);
      await pool.query(
        `INSERT INTO boss_notifications (title, body, priority, channel, created_at, read)
         VALUES ($1, $2, $3, 'email-triage', NOW(), false)`,
        [title.slice(0, 200), body.slice(0, 2000), priority],
      );
    } catch (err) {
      console.error('[email-triage] BOS push failed:', err);
    }
  }
}

/** Blast P1/P2 alert across ALL channels — Telegram, Slack, AND BOS push */
async function notifyKevin(priority: string, subject: string, from: string, account: string, preview: string): Promise<void> {
  const emoji = priority === 'P1_URGENT' ? '🔴' : '🟡';
  const label = priority === 'P1_URGENT' ? 'URGENT' : 'REPLY NEEDED';

  const telegramMsg = `${emoji} ${label}\n\nFrom: ${from}\nSubject: ${subject}\nAccount: ${account}\n\n${preview.slice(0, 300)}`;
  const slackMsg = `${emoji} *${label}*\n>From: ${from}\n>Subject: ${subject}\n>Account: ${account}\n\n${preview.slice(0, 200)}`;
  const pushTitle = `${emoji} ${label}: ${subject.slice(0, 80)}`;
  const pushBody = `From: ${from}\n${preview.slice(0, 500)}`;

  // Fire all three in parallel — don't let one failure block the others
  await Promise.allSettled([
    sendTelegramAlert(telegramMsg),
    sendSlackAlert(slackMsg),
    sendBossPush(pushTitle, pushBody, priority),
  ]);
}

function extractNugget(subject: string, body: string): string | null {
  // Try to find the first interesting fact in a newsletter
  const lines = body.split('\n').filter(l => l.trim().length > 30 && l.trim().length < 200);
  if (lines.length > 0) {
    // Return the first substantive line that looks like content, not navigation
    const content = lines.find(l =>
      !l.includes('unsubscribe') && !l.includes('click') && !l.includes('http') &&
      !l.includes('©') && !l.includes('privacy'),
    );
    return content?.trim() ?? null;
  }
  return null;
}

function safeParseDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();
  // Strip timezone name suffixes like "(UTC)", "(CDT)", "(EST)" that Postgres can't parse
  const cleaned = dateStr.replace(/\s*\([A-Z]{2,5}\)\s*$/, '').trim();
  try {
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) return new Date().toISOString();
    // Sanity check: year must be between 2000 and 2100
    const year = d.getFullYear();
    if (year < 2000 || year > 2100) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function extractAmount(text: string): number | null {
  const match = text.match(/\$[\d,]+\.?\d{0,2}/);
  if (match) {
    return parseFloat(match[0].replace(/[$,]/g, ''));
  }
  return null;
}

function extractDueDate(text: string): string | null {
  // Look for common date patterns near "due" keywords
  const dueSections = text.split(/due|by|before/i);
  for (const section of dueSections.slice(1)) {
    const dateMatch = section.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (dateMatch) {
      const [, m, d, y] = dateMatch;
      const year = y.length === 2 ? `20${y}` : y;
      return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  return null;
}

// ── Core triage loop ─────────────────────────────────────────────────────────

async function runTriage(): Promise<void> {
  if (isRunning) {
    console.log('[email-triage] Already running, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  let processed = 0;
  let errors = 0;

  try {
    console.log('[email-triage] Starting email triage run...');
    const pool = getPool();

    // Process ALL connected Google accounts
    const { getPool: getDbPool } = await import('../db.js');
    const nodeCrypto = await import('node:crypto');
    const dbPool = getDbPool();

    const encKey = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
    if (!encKey) {
      console.log('[email-triage] No encryption key. Skipping.');
      return;
    }

    // Get all Google accounts with valid tokens
    const allTokenRows = await dbPool.query<{ access_token: string; email: string; account_id: string }>(
      `SELECT access_token, COALESCE(email, '') as email, account_id
       FROM boss_oauth_tokens WHERE provider = 'google' AND email IS NOT NULL AND email != ''
       ORDER BY updated_at DESC`,
    );

    if (allTokenRows.rows.length === 0) {
      console.log('[email-triage] No Google OAuth tokens. Skipping.');
      return;
    }

    // Process each account
    for (const tokenRow of allTokenRows.rows) {
      const accountEmail = tokenRow.email;
      console.log(`[email-triage] Processing account: ${accountEmail}`);

      // Decrypt access token
      function decryptToken(encrypted: string): string {
        const parts = encrypted.split(':');
        if (parts.length !== 3) throw new Error('bad format');
        const [ivHex, authTagHex, ciphertext] = parts;
        const decipher = nodeCrypto.createDecipheriv(
          'aes-256-gcm', Buffer.from(encKey!, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength: 16 },
        );
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        return decipher.update(ciphertext, 'hex', 'utf8') + decipher.final('utf8');
      }

      function encryptToken(plaintext: string): string {
        const iv = nodeCrypto.randomBytes(16);
        const cipher = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(encKey!, 'hex'), iv);
        let enc = cipher.update(plaintext, 'utf8', 'hex');
        enc += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${authTag}:${enc}`;
      }

      let accessToken: string;
      try {
        accessToken = decryptToken(tokenRow.access_token);
      } catch {
        console.error(`[email-triage] Token decryption failed for ${accountEmail}. Skipping.`);
        continue;
      }

    // Paginate through all inbox emails
    const messageList: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;

    while (messageList.length < MAX_EMAILS_PER_RUN) {
      // Only process unread emails from the last 24 hours to avoid reprocessing old ones
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const afterDate = since.toISOString().split('T')[0].replace(/-/g, '/');
      const params = new URLSearchParams({ q: `is:unread after:${afterDate}`, maxResults: '50' });
      if (pageToken) params.set('pageToken', pageToken);

      const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`;
      let listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

      // Refresh token on 401
      if (listRes.status === 401) {
        try {
          const refreshRow = await dbPool.query<{ refresh_token: string }>(
            'SELECT refresh_token FROM boss_oauth_tokens WHERE account_id = $1',
            [tokenRow.account_id],
          );
          const refreshToken = decryptToken(refreshRow.rows[0].refresh_token);
          const clientId = process.env.GOOGLE_CLIENT_ID;
          const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

          const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId || '',
              client_secret: clientSecret || '',
              refresh_token: refreshToken,
              grant_type: 'refresh_token',
            }),
          });

          if (refreshRes.ok) {
            const refreshData = await refreshRes.json() as { access_token: string };
            accessToken = refreshData.access_token;
            // Save refreshed token
            await dbPool.query(
              'UPDATE boss_oauth_tokens SET access_token = $1, updated_at = now() WHERE account_id = $2',
              [encryptToken(accessToken), tokenRow.account_id],
            );
            console.log(`[email-triage] Token refreshed for ${accountEmail}`);
            listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          }
        } catch (refreshErr) {
          console.error(`[email-triage] Token refresh failed for ${accountEmail}:`, refreshErr);
        }
      }

      if (!listRes.ok) {
        console.error(`[email-triage] Gmail list failed: ${listRes.status} for ${accountEmail}`);
        break;
      }

      const listData = await listRes.json() as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };

      messageList.push(...(listData.messages ?? []));
      if (!listData.nextPageToken) break;
      pageToken = listData.nextPageToken;
    }

    if (messageList.length === 0) {
      console.log(`[email-triage] No inbox emails for ${accountEmail}. Skipping.`);
      continue;
    }

    console.log(`[email-triage] Found ${messageList.length} inbox emails for ${accountEmail}`);

    // 2. Process each email
    for (const { id: msgId, threadId } of messageList) {
      try {
        // Check if we already processed this message
        const existing = await pool.query<{ id: string; action_taken: string | null; category: string }>(
          'SELECT id, action_taken, category FROM boss_email_log WHERE message_id = $1',
          [msgId],
        );
        // Helper: direct Gmail API calls using this account's token
        const gmailApi = async (endpoint: string, method = 'POST', body?: unknown) => {
          const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/${endpoint}`;
          await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        };
        const markRead = () => gmailApi('modify', 'POST', { removeLabelIds: ['UNREAD'] });
        const archive = () => gmailApi('modify', 'POST', { removeLabelIds: ['INBOX'] });

        if (existing.rows.length > 0) {
          // Already processed — leave flag_attention emails completely alone
          const prev = existing.rows[0];
          if (prev.action_taken === 'flag_attention') {
            // DO NOT touch — Kevin hasn't dealt with it yet. Leave unread, leave in inbox.
            processed++;
            continue;
          }
          // Non-attention emails: make sure they're archived
          try {
            await markRead();
            await archive();
          } catch { /* best effort */ }
          processed++;
          continue;
        }

        // Read full email content using this account's token
        const readUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`;
        const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!readRes.ok) { errors++; continue; }
        const readData = await readRes.json() as any;

        // Parse into structured data
        const getHeader = (name: string) => readData.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        const decodeBody = () => {
          const payload = readData.payload;
          if (payload?.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
          const parts = payload?.parts ?? [];
          const textPart = parts.find((p: any) => p.mimeType === 'text/plain');
          if (textPart?.body?.data) return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
          const htmlPart = parts.find((p: any) => p.mimeType === 'text/html');
          if (htmlPart?.body?.data) return Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          return '';
        };

        const email: ParsedEmail = {
          id: msgId, threadId,
          from: getHeader('From'), to: getHeader('To'),
          subject: getHeader('Subject'), date: getHeader('Date'),
          body: decodeBody().slice(0, 5000),
          labels: readData.labelIds ?? [],
        };

        // 3. Classify with account context
        const decision = classifyEmail(email, accountEmail);

        // 4. Take action based on priority
        //    P1/P2 = STAY UNREAD + STAY IN INBOX — Kevin must see these
        //    P3 and below = mark read + archive
        if (decision.action === 'flag_attention') {
          // DO NOT mark read. DO NOT archive. Kevin needs to see this unread in his inbox.
          console.log(`[email-triage] ⚠️ ATTENTION: ${decision.priority} — ${email.from}: "${email.subject}" — LEFT UNREAD IN INBOX`);
        } else {
          await markRead();
          await archive();
        }

        // 4b. P1/P2 — TRIPLE NOTIFY: Telegram + Slack + BOS push
        if (decision.priority === 'P1_URGENT' || decision.priority === 'P2_REPLY_NEEDED') {
          await notifyKevin(
            decision.priority,
            email.subject,
            email.from,
            accountEmail,
            email.body.slice(0, 500),
          );
        }

        // 5. Store email content to memory for future recall
        if (email.body.length > 50) {
          try {
            const summary = `Email from ${email.from} | Subject: ${email.subject} | ${email.body.slice(0, 500)}`;
            await pool.query(
              `INSERT INTO boss_memory (category, content, source, confidence)
               VALUES ('fact', $1, 'email-triage', 0.8)
               ON CONFLICT DO NOTHING`,
              [summary.slice(0, 2000)],
            );
          } catch { /* non-critical */ }
        }

        // 5. Log to boss_email_log
        const logId = crypto.randomUUID();
        await pool.query(
          `INSERT INTO boss_email_log (
            id, message_id, account_email, sender, subject,
            received_at, category, needs_attention, action_taken,
            golden_nugget, invoice_amount, invoice_due_date, boss_notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            logId, msgId, accountEmail || 'd.caine@dcaine.com', email.from, email.subject,
            safeParseDate(email.date),
            decision.category, decision.needsAttention,
            decision.action === 'archive' ? 'archived' : decision.action === 'flag_attention' ? 'forwarded_to_brain' : 'compiled',
            decision.goldenNugget ?? null,
            decision.invoiceAmount ?? null,
            decision.invoiceDueDate ?? null,
            decision.notes,
          ],
        );

        processed++;
        console.log(`[email-triage] ${decision.priority} | ${decision.category} | ${decision.action} | ${email.from}: ${email.subject.slice(0, 60)}`);
      } catch (err) {
        errors++;
        console.error(`[email-triage] Error processing message ${msgId}:`, err);
      }
    }

    } // end for-each account loop

    const elapsed = Date.now() - startTime;
    console.log(`[email-triage] Complete: ${processed} processed, ${errors} errors in ${elapsed}ms`);

    lastRunAt = new Date();
    lastRunResults = { processed, errors };
  } catch (err) {
    console.error('[email-triage] Triage run failed:', err);
  } finally {
    isRunning = false;
  }
}

function parseReadResult(result: string, msgId: string, threadId: string): ParsedEmail {
  const lines = result.split('\n');
  let from = '', to = '', subject = '', date = '';
  const labels: string[] = [];
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('From: ')) from = line.slice(6);
    else if (line.startsWith('To: ')) to = line.slice(4);
    else if (line.startsWith('Subject: ')) subject = line.slice(9);
    else if (line.startsWith('Date: ')) date = line.slice(6);
    else if (line.startsWith('Labels: ')) labels.push(...line.slice(8).split(', '));
    else if (line === '' && bodyStart === -1 && i > 3) bodyStart = i + 1;
  }

  const body = bodyStart > 0 ? lines.slice(bodyStart).join('\n') : '';

  return { id: msgId, threadId, from, to, subject, date, body, labels };
}

// ── Import crypto for UUID generation ────────────────────────────────────────
import crypto from 'node:crypto';

// ── Public API ───────────────────────────────────────────────────────────────

export function startEmailTriage(): void {
  console.log(`[email-triage] Starting background email triage (every ${POLL_INTERVAL_MS / 60000} min)`);

  // Run once immediately after a short delay (let the server finish starting)
  setTimeout(() => void runTriage(), 30_000);

  // Then schedule periodic runs
  intervalHandle = setInterval(() => void runTriage(), POLL_INTERVAL_MS);
}

export function stopEmailTriage(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[email-triage] Stopped');
  }
}

export function getEmailTriageStatus(): {
  running: boolean;
  lastRunAt: string | null;
  lastResults: { processed: number; errors: number };
  intervalMs: number;
} {
  return {
    running: isRunning,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastResults: lastRunResults,
    intervalMs: POLL_INTERVAL_MS,
  };
}

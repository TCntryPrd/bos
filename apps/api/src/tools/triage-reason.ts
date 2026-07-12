/**
 * boss_triage_reason — the email TRIAGE REASONER tool.
 *
 * Splits decision from execution (Kevin's orchestrator design): the Scanner runs on
 * a clean tool-caller (Llama 3.3 70B) and calls THIS tool to delegate the JUDGEMENT to
 * a reasoning model (NVIDIA NIM Nemotron 3). The reasoning call is single-shot and
 * TOOL-FREE — exactly where reasoning models are reliable (they leak tool-call JSON on
 * multi-step tool loops, so we never let them drive the loop). Nemotron reads one email
 * and returns a structured decision; the Llama Scanner then enacts the `route`.
 *
 * Returns a JSON string: { category, urgency, intent, sensitivity, confidence,
 *   phishing, route, reason }. route is one of:
 *   REVIEW       - high_stakes OR confidence<0.6 OR phishing: escalate to a human, no auto-reply
 *   REPLY_P1     - urgent/personal/needs action from a real person -> queue a priority reply
 *   REPLY_P2     - a real person, FYI or light reply -> queue a normal reply
 *   NUGGETS      - substantive newsletter worth mining -> queue nuggets + archive
 *   ARCHIVE      - promo/automated/no-reply junk -> archive
 */
import type { BrainTool } from '@boss/brain';

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const REASONER_SYSTEM = `You are an elite email triage reasoner for Kevin Starr (Starr & Partners / D. Caine Solutions). You read ONE email and output a single triage decision. You do not write replies and you do not call tools. Output ONLY valid minified JSON, no prose, no markdown.

Classify on these axes:
- category: one of [sales, support, client, vendor, personal, newsletter, receipt, notification, legal_finance, recruiting, other]
- urgency: one of [high, normal, low]
- intent: short phrase for what the sender wants
- sensitivity: one of [routine, confidential, high_stakes]. high_stakes = money, legal, contracts, refunds, deadlines, or anything that could cost or commit Kevin if mishandled. confidential = PII, financials, credentials, or a private matter.
- confidence: 0.0 to 1.0, how sure you are
- phishing: true/false. true = unknown or spoofed sender asking for money, credentials, gift cards, wire/payment changes, urgent action, or with mismatched/suspicious links or display name.
- route: one of [REVIEW, REPLY_P1, REPLY_P2, NUGGETS, ARCHIVE]
- reason: one short sentence

Routing rules (apply in order):
1. If sensitivity == high_stakes OR confidence < 0.6 OR phishing == true -> route = REVIEW.
2. Else if the sender is no-reply / noreply / notifications / automated / a welcome, verification, or receipt (anything you cannot reply to a human on) -> route = ARCHIVE (or NUGGETS if it is a substantive newsletter worth mining).
2a. Else if the email is an automated digest, report, or form-submission summary — even if it comes from a real person's email address — (signals: formulaic subject like "REQUESTS FROM STUDENTS" / "DAILY REPORT" / "WEEKLY DIGEST", body with structured data rows or form submissions, no personal greeting, clearly software-generated) -> route = NUGGETS (if content has value) or ARCHIVE (if routine).
3. Else if a real person who needs action or a real reply, urgent or personal -> route = REPLY_P1.
4. Else if a real person, FYI or light reply -> route = REPLY_P2.
5. Else if a substantive newsletter worth mining for insight -> route = NUGGETS.
6. Else -> route = ARCHIVE.

Output exactly: {"category":"...","urgency":"...","intent":"...","sensitivity":"...","confidence":0.0,"phishing":false,"route":"...","reason":"..."}`;

export const triageReasonTool: BrainTool = {
  name: 'boss_triage_reason',
  description:
    'Delegate the triage JUDGEMENT for one email to the reasoning model (Nemotron). Pass the email fields; get back a structured decision as JSON: {category, urgency, intent, sensitivity, confidence, phishing, route, reason}. ' +
    'route tells you what to do: REVIEW (escalate to human), REPLY_P1 (urgent reply), REPLY_P2 (normal reply), NUGGETS (mine + archive), ARCHIVE (junk). Call this once per email after you read it, then act on the returned route.',
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'The mailbox this email arrived in.' },
      sender: { type: 'string', description: 'Sender name and address.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body: { type: 'string', description: 'The email body text (cleaned). Trimmed automatically if long.' },
    },
    required: ['sender', 'subject', 'body'],
  },
};

export const ALL_TRIAGE_TOOLS: BrainTool[] = [triageReasonTool];

async function handleTriageReason(args: Record<string, unknown>): Promise<string> {
  const key = process.env.NVIDIA_NIM_API_KEY;
  if (!key) return JSON.stringify({ route: 'REVIEW', reason: 'reasoner unavailable (no NIM key); escalate to human', confidence: 0 });
  const model = process.env.TRIAGE_REASONER_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
  const account = String(args.account ?? '');
  const sender = String(args.sender ?? '').slice(0, 300);
  const subject = String(args.subject ?? '').slice(0, 500);
  const body = String(args.body ?? '').slice(0, 6000);
  const userMsg = `Account: ${account}\nFrom: ${sender}\nSubject: ${subject}\n\n${body}`;
  const VALID = new Set(['REVIEW', 'REPLY_P1', 'REPLY_P2', 'NUGGETS', 'ARCHIVE']);

  // Try up to 2 times: a transient NIM blip (429/timeout) should not mis-escalate
  // a benign email to REVIEW. Only fail closed to REVIEW after both attempts fail.
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(NIM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: REASONER_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.1,
          // Nemotron is a reasoning model: it spends tokens on a separate
          // reasoning_content field before the answer. Give enough budget that the
          // final `content` (the JSON) is never truncated away.
          max_tokens: 2000,
          // NO tools here on purpose: a single-shot reasoning call is where the
          // reasoning model is reliable. Ask for a JSON object back.
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) { lastErr = `http ${res.status}`; continue; }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
      const msg0 = data.choices?.[0]?.message ?? {};
      // Prefer the answer channel; fall back to the reasoning channel if content
      // came back empty (budget spent on reasoning) but the JSON is in there.
      const content = ((msg0.content || '').trim()) || ((msg0.reasoning_content || '').trim());
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start === -1 || end === -1) { lastErr = 'no JSON in reply'; continue; }
      let decision: Record<string, unknown>;
      try {
        decision = JSON.parse(content.slice(start, end + 1));
      } catch { lastErr = 'JSON parse failed'; continue; }
      // Fail safe: an unknown/missing route becomes REVIEW so nothing slips through.
      if (!VALID.has(String(decision.route))) decision.route = 'REVIEW';
      return JSON.stringify(decision);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  // Both attempts failed: fail CLOSED to human review (safe default).
  return JSON.stringify({ route: 'REVIEW', reason: `reasoner unavailable (${lastErr}); escalate to human`, confidence: 0 });
}

export const TRIAGE_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_triage_reason: handleTriageReason,
};

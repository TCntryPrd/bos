/**
 * Escalation — notify the human when all 3 diagnostic attempts fail.
 *
 * Channels:
 *   1. Slack — webhook POST with structured message
 *   2. Push notification — via BOS internal API (mobile app delivery)
 *   3. Voice announcement — play message on nearest Voice PE device
 *
 * All three are attempted independently. Partial success is logged but not fatal.
 */

import type { ServiceName, PlaybookSeverity } from '@boss/core';

// ── Escalation types ──────────────────────────────────────────

export interface EscalationReport {
  incidentId: string;
  service: ServiceName;
  severity: PlaybookSeverity;
  /** Human-readable description of what failed. */
  errorSummary: string;
  /** Each fix attempt that was tried and why it failed. */
  attempts: AttemptSummary[];
  /** What BOS recommends the human do to resolve the issue. */
  recommendedAction: string;
  /** Log lines relevant to the failure. */
  logExcerpt: string;
  failedAt: Date;
}

export interface AttemptSummary {
  attemptNumber: number;
  action: string;
  outcome: string;
}

export interface EscalationConfig {
  /** Slack incoming webhook URL. Omit to skip Slack. */
  slackWebhookUrl?: string;
  /** BOS internal API URL for push notifications. Default: http://localhost:3000 */
  apiBaseUrl?: string;
  apiKey?: string;
  /** Voice announcement: if set, will attempt to play message on devices. */
  voiceEnabled?: boolean;
  /** Room to announce in. 'all' broadcasts to every device. Default: 'all' */
  voiceTargetRoom?: string;
  timeoutMs?: number;
}

export interface EscalationResult {
  slackSent: boolean;
  pushSent: boolean;
  voiceAnnounced: boolean;
  errors: string[];
}

// ── EscalationManager ─────────────────────────────────────────

export class EscalationManager {
  private config: EscalationConfig;

  constructor(config: EscalationConfig = {}) {
    this.config = config;
  }

  /**
   * Fire all escalation channels for the given report.
   * Does not throw — failures are captured in the result.
   */
  async escalate(report: EscalationReport): Promise<EscalationResult> {
    const result: EscalationResult = {
      slackSent: false,
      pushSent: false,
      voiceAnnounced: false,
      errors: [],
    };

    const timeout = this.config.timeoutMs ?? 10_000;

    // Run all channels in parallel — partial failure is fine
    const [slackResult, pushResult, voiceResult] = await Promise.allSettled([
      this.sendSlack(report, timeout),
      this.sendPush(report, timeout),
      this.sendVoice(report, timeout),
    ]);

    if (slackResult.status === 'fulfilled') {
      result.slackSent = slackResult.value;
    } else {
      result.errors.push(`Slack: ${slackResult.reason}`);
    }

    if (pushResult.status === 'fulfilled') {
      result.pushSent = pushResult.value;
    } else {
      result.errors.push(`Push: ${pushResult.reason}`);
    }

    if (voiceResult.status === 'fulfilled') {
      result.voiceAnnounced = voiceResult.value;
    } else {
      result.errors.push(`Voice: ${voiceResult.reason}`);
    }

    return result;
  }

  // ── Slack ─────────────────────────────────────────────────

  private async sendSlack(report: EscalationReport, timeoutMs: number): Promise<boolean> {
    if (!this.config.slackWebhookUrl) return false;

    const color = severityColor(report.severity);
    const attemptList = report.attempts
      .map((a) => `• Attempt ${a.attemptNumber}: \`${a.action}\` — ${a.outcome}`)
      .join('\n');

    const payload = {
      attachments: [
        {
          color,
          title: `BOS Self-Healing: Escalation Required`,
          fields: [
            { title: 'Service', value: report.service, short: true },
            { title: 'Severity', value: report.severity.toUpperCase(), short: true },
            { title: 'Error', value: report.errorSummary, short: false },
            { title: 'Fix Attempts', value: attemptList || 'None', short: false },
            { title: 'Recommended Action', value: report.recommendedAction, short: false },
          ],
          footer: `Incident ${report.incidentId} | ${report.failedAt.toISOString()}`,
          text: `\`\`\`\n${report.logExcerpt.slice(0, 500)}\n\`\`\``,
        },
      ],
    };

    const res = await fetch(this.config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return res.ok;
  }

  // ── Push notification ─────────────────────────────────────

  private async sendPush(report: EscalationReport, timeoutMs: number): Promise<boolean> {
    const baseUrl = (this.config.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');

    const res = await fetch(`${baseUrl}/internal/notifications/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { 'x-boss-api-key': this.config.apiKey } : {}),
      },
      body: JSON.stringify({
        title: `[${report.severity.toUpperCase()}] BOS Needs Attention`,
        body: `${report.service}: ${report.errorSummary}`,
        data: {
          incidentId: report.incidentId,
          service: report.service,
          severity: report.severity,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return res.ok;
  }

  // ── Voice announcement ────────────────────────────────────

  private async sendVoice(report: EscalationReport, timeoutMs: number): Promise<boolean> {
    if (!this.config.voiceEnabled) return false;

    const baseUrl = (this.config.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    const room = this.config.voiceTargetRoom ?? 'all';

    const message = buildVoiceMessage(report);

    const res = await fetch(`${baseUrl}/internal/voice/announce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { 'x-boss-api-key': this.config.apiKey } : {}),
      },
      body: JSON.stringify({ room, message }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    return res.ok;
  }
}

// ── Helpers ───────────────────────────────────────────────────

function severityColor(severity: PlaybookSeverity): string {
  switch (severity) {
    case 'critical': return '#cc0000';
    case 'high':     return '#ff6600';
    case 'medium':   return '#ffcc00';
    case 'low':      return '#36a64f';
  }
}

function buildVoiceMessage(report: EscalationReport): string {
  const severityWord =
    report.severity === 'critical' ? 'critical issue' :
    report.severity === 'high' ? 'high severity issue' :
    'issue';

  return (
    `BOS has detected a ${severityWord} with the ${report.service} service. ` +
    `${report.errorSummary}. ` +
    `Three fix attempts were made but the problem persists. ` +
    `${report.recommendedAction}. ` +
    `Please check your phone or computer for the full report.`
  );
}

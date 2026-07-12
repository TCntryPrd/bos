/**
 * Communications Ingest — scans Slack/Teams history for
 * communication style, channel activity, and interaction patterns.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern, ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface CommsIngestConfig {
  /** Months of message history to scan. Default 6. */
  lookbackMonths?: number;
}

export interface CommsMessage {
  id: string;
  channelId: string;
  channelName: string;
  isDM: boolean;
  senderIsUser: boolean;
  wordCount: number;
  hasEmoji: boolean;
  hasAttachment: boolean;
  sentAt: Date;
  responseTimeMinutes?: number;
}

export interface ChannelActivity {
  channelId: string;
  channelName: string;
  messageCount: number;
  isMuted: boolean;
}

// ── Ingester ────────────────────────────────────────────────────────

export class CommsIngester implements PlatformIngester {
  readonly platform: PlatformName = 'comms';
  private lookbackMonths: number;

  constructor(config: CommsIngestConfig = {}) {
    this.lookbackMonths = config.lookbackMonths ?? 6;
  }

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('comms', 0, 0, 'Scanning communication channels...');

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - this.lookbackMonths);

    // Phase 1: Channel inventory
    const channels = await this.fetchChannels(ctx);
    tracker.updateProgress('comms', 0, 0, `Found ${channels.length} channels`);

    // Phase 2: Message history
    const totalMessages = await this.countMessages(ctx, cutoff);
    tracker.updateProgress('comms', 0, totalMessages, `Analyzing ${totalMessages} messages...`);

    const hourDist = new Array<number>(24).fill(0);
    const channelMsgCount = new Map<string, number>();
    const dmContacts = new Map<string, number>();
    let emojiCount = 0;
    let totalWordCount = 0;
    let userMessageCount = 0;
    const responseTimes: number[] = [];
    let processed = 0;

    while (processed < totalMessages) {
      const batch = await this.fetchMessageBatch(ctx, cutoff, processed, 100);
      if (batch.length === 0) break;

      for (const msg of batch) {
        if (msg.senderIsUser) {
          userMessageCount++;
          hourDist[msg.sentAt.getHours()]++;
          totalWordCount += msg.wordCount;
          if (msg.hasEmoji) emojiCount++;
        }

        channelMsgCount.set(
          msg.channelName,
          (channelMsgCount.get(msg.channelName) ?? 0) + 1,
        );

        if (msg.isDM && !msg.senderIsUser && msg.responseTimeMinutes !== undefined) {
          responseTimes.push(msg.responseTimeMinutes);
        }

        if (msg.isDM) {
          dmContacts.set(msg.channelName, (dmContacts.get(msg.channelName) ?? 0) + 1);
        }
      }

      processed += batch.length;
      tracker.updateProgress('comms', processed, totalMessages, `Analyzed ${processed} of ${totalMessages} messages`);
    }

    const patterns = this.buildPatterns(
      channels, hourDist, channelMsgCount, dmContacts,
      emojiCount, totalWordCount, userMessageCount, responseTimes,
    );

    return {
      platform: 'comms',
      itemsProcessed: processed,
      patterns,
      metadata: {
        channelCount: channels.length,
        totalMessages: processed,
        userMessages: userMessageCount,
        uniqueDMContacts: dmContacts.size,
        lookbackMonths: this.lookbackMonths,
      },
    };
  }

  // ── Connector stubs ───────────────────────────────────────────────

  private async fetchChannels(_ctx: TenantContext): Promise<ChannelActivity[]> {
    // TODO: wire to Slack/Teams connector
    return [];
  }

  private async countMessages(_ctx: TenantContext, _since: Date): Promise<number> {
    // TODO: wire to Slack/Teams connector
    return 0;
  }

  private async fetchMessageBatch(
    _ctx: TenantContext,
    _since: Date,
    _offset: number,
    _limit: number,
  ): Promise<CommsMessage[]> {
    // TODO: wire to Slack/Teams connector
    return [];
  }

  // ── Pattern building ──────────────────────────────────────────────

  private buildPatterns(
    channels: ChannelActivity[],
    hourDist: number[],
    channelMsgCount: Map<string, number>,
    dmContacts: Map<string, number>,
    emojiCount: number,
    totalWordCount: number,
    userMessageCount: number,
    responseTimes: number[],
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    // Active vs muted channels
    const active = channels.filter((c) => !c.isMuted);
    const muted = channels.filter((c) => c.isMuted);
    if (channels.length > 0) {
      patterns.push({
        category: 'communication.channels',
        description: `${active.length} active channels, ${muted.length} muted`,
        confidence: 0.9,
        evidence: [
          ...active.slice(0, 5).map((c) => `Active: ${c.channelName} (${c.messageCount} msgs)`),
          ...muted.slice(0, 3).map((c) => `Muted: ${c.channelName}`),
        ],
      });
    }

    // Communication timing
    const peakHours = hourDist
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .filter((h) => h.count > 0);

    if (peakHours.length > 0) {
      patterns.push({
        category: 'communication.timing',
        description: 'Peak messaging hours',
        confidence: 0.8,
        evidence: peakHours.map((h) => `Hour ${h.hour}: ${h.count} messages`),
      });
    }

    // Message style
    if (userMessageCount > 0) {
      const avgWordCount = Math.round(totalWordCount / userMessageCount);
      const emojiRate = Math.round((emojiCount / userMessageCount) * 100);
      patterns.push({
        category: 'communication.style',
        description: 'Messaging style profile',
        confidence: 0.75,
        evidence: [
          `Average message length: ${avgWordCount} words`,
          `Emoji usage: ${emojiRate}% of messages`,
          `Total user messages: ${userMessageCount}`,
        ],
      });
    }

    // Response speed
    if (responseTimes.length > 0) {
      const avgMinutes = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
      patterns.push({
        category: 'communication.responsiveness',
        description: `Average DM response time: ${avgMinutes} minutes`,
        confidence: 0.7,
        evidence: [`Based on ${responseTimes.length} DM conversations`],
      });
    }

    // Top DM contacts
    const topDMs = Array.from(dmContacts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topDMs.length > 0) {
      patterns.push({
        category: 'communication.contacts',
        description: `Top ${topDMs.length} DM contacts`,
        confidence: 0.85,
        evidence: topDMs.map(([name, count]) => `${name}: ${count} messages`),
      });
    }

    return patterns;
  }
}

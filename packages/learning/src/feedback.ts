/**
 * Feedback Loop — reinforcement signals (good/bad) to refine
 * patterns, preferences, and style over time.
 */

// ── Types ───────────────────────────────────────────────────────────

export type FeedbackSignal = 'positive' | 'negative' | 'correction';

export interface FeedbackEntry {
  id: string;
  tenantId: string;
  userId: string;
  /** The action or response this feedback applies to. */
  actionId: string;
  /** Type of action (email_draft, schedule_event, task_create, etc). */
  actionType: string;
  /** The signal from the user. */
  signal: FeedbackSignal;
  /** Optional correction text if signal is 'correction'. */
  correctionText?: string;
  /** Context at the time of the action. */
  context: Record<string, unknown>;
  createdAt: Date;
}

export interface FeedbackStats {
  totalFeedback: number;
  positive: number;
  negative: number;
  corrections: number;
  /** Satisfaction rate (positive / total). */
  satisfactionRate: number;
  /** Most common negative action types. */
  topNegativeActions: Array<{ actionType: string; count: number }>;
}

export interface FeedbackConfig {
  /** After N negative signals on same action type, surface a learning alert. Default 3. */
  negativeThreshold?: number;
}

// ── Feedback Processor ──────────────────────────────────────────────

export class FeedbackProcessor {
  private config: Required<FeedbackConfig>;
  private entries: FeedbackEntry[] = [];
  private actionTypeCounts: Map<string, { positive: number; negative: number; corrections: number }> = new Map();
  private listeners: FeedbackListener[] = [];

  constructor(config: FeedbackConfig = {}) {
    this.config = {
      negativeThreshold: config.negativeThreshold ?? 3,
    };
  }

  /**
   * Register a listener for feedback events.
   */
  onFeedback(listener: FeedbackListener): void {
    this.listeners.push(listener);
  }

  /**
   * Record a feedback signal.
   */
  async record(entry: FeedbackEntry): Promise<void> {
    this.entries.push(entry);

    // Update action type counts
    const counts = this.actionTypeCounts.get(entry.actionType) ?? { positive: 0, negative: 0, corrections: 0 };
    counts[entry.signal === 'correction' ? 'corrections' : entry.signal]++;
    this.actionTypeCounts.set(entry.actionType, counts);

    // Check for negative threshold
    if (
      entry.signal === 'negative' &&
      counts.negative >= this.config.negativeThreshold
    ) {
      await this.triggerLearningAlert(entry.tenantId, entry.userId, entry.actionType, counts.negative);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      await listener(entry);
    }

    // Persist
    await this.persist(entry);
  }

  /**
   * Record positive feedback (shorthand).
   */
  async thumbsUp(
    tenantId: string,
    userId: string,
    actionId: string,
    actionType: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.record({
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      userId,
      actionId,
      actionType,
      signal: 'positive',
      context,
      createdAt: new Date(),
    });
  }

  /**
   * Record negative feedback (shorthand).
   */
  async thumbsDown(
    tenantId: string,
    userId: string,
    actionId: string,
    actionType: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.record({
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      userId,
      actionId,
      actionType,
      signal: 'negative',
      context,
      createdAt: new Date(),
    });
  }

  /**
   * Record a correction (user fixes what BOS did).
   */
  async correct(
    tenantId: string,
    userId: string,
    actionId: string,
    actionType: string,
    correctionText: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.record({
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      userId,
      actionId,
      actionType,
      signal: 'correction',
      correctionText,
      context,
      createdAt: new Date(),
    });
  }

  /**
   * Get stats for a user.
   */
  getStats(tenantId: string, userId: string): FeedbackStats {
    const userEntries = this.entries.filter(
      (e) => e.tenantId === tenantId && e.userId === userId,
    );

    const positive = userEntries.filter((e) => e.signal === 'positive').length;
    const negative = userEntries.filter((e) => e.signal === 'negative').length;
    const corrections = userEntries.filter((e) => e.signal === 'correction').length;
    const total = userEntries.length;

    // Top negative action types
    const negByType = new Map<string, number>();
    for (const e of userEntries.filter((e) => e.signal === 'negative')) {
      negByType.set(e.actionType, (negByType.get(e.actionType) ?? 0) + 1);
    }
    const topNegativeActions = Array.from(negByType.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([actionType, count]) => ({ actionType, count }));

    return {
      totalFeedback: total,
      positive,
      negative,
      corrections,
      satisfactionRate: total > 0 ? positive / total : 0,
      topNegativeActions,
    };
  }

  /**
   * Get the satisfaction rate for a specific action type.
   */
  getActionSatisfaction(actionType: string): number {
    const counts = this.actionTypeCounts.get(actionType);
    if (!counts) return 0;
    const total = counts.positive + counts.negative + counts.corrections;
    return total > 0 ? counts.positive / total : 0;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async triggerLearningAlert(
    _tenantId: string,
    _userId: string,
    actionType: string,
    negativeCount: number,
  ): Promise<void> {
    // TODO: wire to notification/escalation system
    // Alert: "BOS has received ${negativeCount} negative signals on ${actionType}.
    //         Review and adjust behavior."
  }

  private async persist(_entry: FeedbackEntry): Promise<void> {
    // TODO: wire to Postgres data layer
  }
}

// ── Callback Type ───────────────────────────────────────────────────

export type FeedbackListener = (entry: FeedbackEntry) => Promise<void>;

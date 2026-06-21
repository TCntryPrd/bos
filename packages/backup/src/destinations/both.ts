/**
 * Dual Destination — delivers backup files to both Git and S3.
 *
 * Runs deliveries in parallel. If one fails, the other still completes.
 * Reports per-destination results.
 */

import type { BackupDestination } from './git.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DualDestinationConfig {
  /** Primary destination. */
  primary: BackupDestination;
  /** Secondary destination. */
  secondary: BackupDestination;
  /** If true, fail the delivery if either destination fails. Default false. */
  failOnPartial?: boolean;
}

export interface DualDeliveryResult {
  primarySuccess: boolean;
  primaryError?: string;
  secondarySuccess: boolean;
  secondaryError?: string;
}

// ── Destination ─────────────────────────────────────────────────────

export class DualBackupDestination implements BackupDestination {
  readonly name = 'dual';
  private primary: BackupDestination;
  private secondary: BackupDestination;
  private failOnPartial: boolean;
  private lastResult?: DualDeliveryResult;

  constructor(config: DualDestinationConfig) {
    this.primary = config.primary;
    this.secondary = config.secondary;
    this.failOnPartial = config.failOnPartial ?? false;
  }

  /**
   * Deliver to both destinations in parallel.
   */
  async deliver(filePaths: string[]): Promise<void> {
    const result: DualDeliveryResult = {
      primarySuccess: false,
      secondarySuccess: false,
    };

    const [primaryResult, secondaryResult] = await Promise.allSettled([
      this.primary.deliver(filePaths),
      this.secondary.deliver(filePaths),
    ]);

    if (primaryResult.status === 'fulfilled') {
      result.primarySuccess = true;
    } else {
      result.primaryError = primaryResult.reason instanceof Error
        ? primaryResult.reason.message
        : String(primaryResult.reason);
    }

    if (secondaryResult.status === 'fulfilled') {
      result.secondarySuccess = true;
    } else {
      result.secondaryError = secondaryResult.reason instanceof Error
        ? secondaryResult.reason.message
        : String(secondaryResult.reason);
    }

    this.lastResult = result;

    // Check failure conditions
    if (this.failOnPartial && (!result.primarySuccess || !result.secondarySuccess)) {
      const errors: string[] = [];
      if (!result.primarySuccess) errors.push(`Primary (${this.primary.name}): ${result.primaryError}`);
      if (!result.secondarySuccess) errors.push(`Secondary (${this.secondary.name}): ${result.secondaryError}`);
      throw new Error(`Dual delivery partial failure: ${errors.join('; ')}`);
    }

    if (!result.primarySuccess && !result.secondarySuccess) {
      throw new Error(
        `Dual delivery total failure: ` +
        `Primary (${this.primary.name}): ${result.primaryError}; ` +
        `Secondary (${this.secondary.name}): ${result.secondaryError}`,
      );
    }
  }

  /**
   * Get the result of the last delivery attempt.
   */
  getLastResult(): DualDeliveryResult | undefined {
    return this.lastResult ? { ...this.lastResult } : undefined;
  }
}

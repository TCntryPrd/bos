/**
 * Playbook builder — create a new playbook from a successful healing incident.
 *
 * Called by the diagnostic agent after a fix succeeds on attempt 1, 2, or 3.
 * The builder extracts a reusable pattern and codifies the steps so future
 * occurrences are resolved automatically without human review.
 *
 * The builder also deduplicates: if a playbook already matches this incident
 * with a high score, it increments success_count instead of creating a duplicate.
 */

import type { Playbook, ServiceName, PlaybookSeverity } from '@boss/core';
import type { PlaybookStore } from './store.js';
import type { PlaybookMatcher } from './matcher.js';

export interface IncidentRecord {
  id: string;
  service: ServiceName;
  severity: PlaybookSeverity;
  errorMessage: string;
  logExcerpt?: string;
  /** Steps that were diagnosed before the fix was attempted. */
  diagnosisSteps: string[];
  /** The fix steps that succeeded. */
  successfulFixSteps: string[];
  /** How the fix was verified to have worked. */
  verificationMethod: string;
}

export interface BuildPlaybookResult {
  action: 'created' | 'updated_existing';
  playbook: Playbook;
}

export class PlaybookBuilder {
  private store: PlaybookStore;
  private matcher: PlaybookMatcher;

  constructor(store: PlaybookStore, matcher: PlaybookMatcher) {
    this.store = store;
    this.matcher = matcher;
  }

  /**
   * Build or update a playbook from a successfully resolved incident.
   */
  async buildFromIncident(incident: IncidentRecord): Promise<BuildPlaybookResult> {
    // Check if an existing playbook already covers this incident
    const existing = await this.matcher.match({
      service: incident.service,
      errorMessage: incident.errorMessage,
      logExcerpt: incident.logExcerpt,
    });

    if (existing.found && existing.playbook && (existing.score ?? 0) >= 0.6) {
      // High-confidence match — reinforce the existing playbook
      await this.store.incrementSuccess(existing.playbook.id);

      // Return the updated playbook (fetch fresh copy with updated count)
      const updated = await this.store.getById(existing.playbook.id);

      return {
        action: 'updated_existing',
        playbook: updated ?? existing.playbook,
      };
    }

    // No matching playbook — create a new one
    const signature = extractSignature(incident.errorMessage);

    const created = await this.store.create({
      failureSignature: signature,
      service: incident.service,
      severity: incident.severity,
      diagnosisSteps: incident.diagnosisSteps,
      fixSteps: incident.successfulFixSteps,
      verification: incident.verificationMethod,
      createdFromIncident: incident.id,
    });

    return { action: 'created', playbook: created };
  }
}

/**
 * Extract a regex signature from a raw error message.
 *
 * Strategy:
 *   - Escape special regex characters
 *   - Replace dynamic parts (timestamps, UUIDs, IPs, port numbers, hex strings)
 *     with wildcards so the pattern matches future occurrences
 *   - Truncate to 200 chars
 */
function extractSignature(errorMessage: string): string {
  // Strip leading/trailing whitespace
  let msg = errorMessage.trim();

  // Replace UUIDs
  msg = msg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');

  // Replace ISO timestamps
  msg = msg.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<timestamp>');

  // Replace IP addresses
  msg = msg.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>');

  // Replace port numbers (standalone)
  msg = msg.replace(/:\d{4,5}\b/g, ':<port>');

  // Replace long hex strings (e.g. git SHAs, tokens)
  msg = msg.replace(/\b[0-9a-f]{8,}\b/gi, '<hex>');

  // Replace numbers that look like counts or sizes
  msg = msg.replace(/\b\d{3,}\b/g, '<n>');

  // Escape remaining regex special characters
  const escaped = msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Replace the placeholder tokens with regex wildcards
  const withWildcards = escaped
    .replace(/<uuid>/g, '[0-9a-f-]{36}')
    .replace(/<timestamp>/g, '[0-9T:.Z-]+')
    .replace(/<ip>/g, '[\\d.]+')
    .replace(/:<port>/g, ':\\d+')
    .replace(/<hex>/g, '[0-9a-f]+')
    .replace(/<n>/g, '\\d+');

  // Truncate to 200 characters
  return withWildcards.slice(0, 200);
}

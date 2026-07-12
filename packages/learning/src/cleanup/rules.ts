/**
 * File Organization Rules — learned rules for ongoing file management.
 *
 * After initial cleanup, BOS applies these rules automatically
 * (e.g., "auto-clean Downloads weekly", "rename screenshots with date prefix").
 */

// ── Types ───────────────────────────────────────────────────────────

export type RuleAction = 'move' | 'rename' | 'archive' | 'alert';
export type RuleTrigger = 'schedule' | 'file_created' | 'file_modified' | 'manual';
export type RuleFrequency = 'daily' | 'weekly' | 'monthly';

export interface FileRule {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string;
  enabled: boolean;

  /** What triggers this rule. */
  trigger: RuleTrigger;
  /** For scheduled triggers, how often. */
  frequency?: RuleFrequency;

  /** File matching conditions. */
  conditions: RuleCondition[];
  /** What to do with matched files. */
  action: RuleAction;
  /** Configuration for the action. */
  actionConfig: RuleActionConfig;

  /** How this rule was created. */
  source: 'learned' | 'user_defined' | 'suggested';
  /** How many times this rule has fired. */
  executionCount: number;

  createdAt: Date;
  updatedAt: Date;
  lastExecutedAt?: Date;
}

export interface RuleCondition {
  field: 'extension' | 'name_pattern' | 'directory' | 'size' | 'age_days' | 'mime_type';
  operator: 'equals' | 'contains' | 'matches' | 'greater_than' | 'less_than';
  value: string;
}

export interface RuleActionConfig {
  /** Destination directory for move actions. */
  destinationDir?: string;
  /** Naming pattern for rename actions (supports {date}, {original}, {ext}). */
  namePattern?: string;
  /** Alert message for alert actions. */
  alertMessage?: string;
}

export interface RuleMatch {
  rule: FileRule;
  matchedFiles: string[];
}

// ── Rules Engine ────────────────────────────────────────────────────

export class FileRulesEngine {
  private rules: Map<string, FileRule> = new Map();

  /**
   * Add or update a rule.
   */
  async addRule(rule: FileRule): Promise<void> {
    this.rules.set(rule.id, rule);
    await this.persist(rule);
  }

  /**
   * Remove a rule.
   */
  async removeRule(ruleId: string): Promise<boolean> {
    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      await this.deleteFromDb(ruleId);
    }
    return deleted;
  }

  /**
   * Enable/disable a rule.
   */
  async setEnabled(ruleId: string, enabled: boolean): Promise<boolean> {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    rule.enabled = enabled;
    rule.updatedAt = new Date();
    await this.persist(rule);
    return true;
  }

  /**
   * Get all rules for a user.
   */
  getRules(tenantId: string, userId: string): FileRule[] {
    return Array.from(this.rules.values()).filter(
      (r) => r.tenantId === tenantId && r.userId === userId,
    );
  }

  /**
   * Get enabled rules matching a specific trigger.
   */
  getActiveRules(tenantId: string, userId: string, trigger: RuleTrigger): FileRule[] {
    return this.getRules(tenantId, userId).filter(
      (r) => r.enabled && r.trigger === trigger,
    );
  }

  /**
   * Evaluate a file path against all active rules.
   * Returns matching rules.
   */
  evaluate(
    tenantId: string,
    userId: string,
    filePath: string,
    fileMetadata: FileMetadata,
  ): FileRule[] {
    const activeRules = this.getRules(tenantId, userId).filter((r) => r.enabled);

    return activeRules.filter((rule) =>
      rule.conditions.every((condition) =>
        this.evaluateCondition(condition, filePath, fileMetadata),
      ),
    );
  }

  /**
   * Create suggested rules from observed patterns.
   * Called after device ingest to propose initial rules.
   */
  suggestRules(tenantId: string, userId: string, patterns: SuggestablePattern[]): FileRule[] {
    const suggestions: FileRule[] = [];

    for (const pattern of patterns) {
      if (pattern.type === 'downloads_clutter' && pattern.fileCount > 20) {
        suggestions.push(this.createRule(tenantId, userId, {
          name: 'Auto-clean Downloads',
          description: 'Move files in Downloads older than 30 days to review folder',
          trigger: 'schedule',
          frequency: 'weekly',
          conditions: [
            { field: 'directory', operator: 'contains', value: 'Downloads' },
            { field: 'age_days', operator: 'greater_than', value: '30' },
          ],
          action: 'move',
          actionConfig: { destinationDir: '~/BOS Review/Downloads' },
          source: 'suggested',
        }));
      }

      if (pattern.type === 'screenshot_buildup' && pattern.fileCount > 10) {
        suggestions.push(this.createRule(tenantId, userId, {
          name: 'Organize Screenshots',
          description: 'Rename screenshots with date prefix and move to Screenshots folder',
          trigger: 'file_created',
          conditions: [
            { field: 'name_pattern', operator: 'matches', value: '^(screenshot|screen shot|capture)' },
            { field: 'extension', operator: 'equals', value: 'png' },
          ],
          action: 'move',
          actionConfig: {
            destinationDir: '~/Pictures/Screenshots',
            namePattern: '{date}_{original}.{ext}',
          },
          source: 'suggested',
        }));
      }

      if (pattern.type === 'temp_files' && pattern.fileCount > 5) {
        suggestions.push(this.createRule(tenantId, userId, {
          name: 'Clean Temp Files',
          description: 'Remove temporary files weekly',
          trigger: 'schedule',
          frequency: 'weekly',
          conditions: [
            { field: 'extension', operator: 'matches', value: '\\.(tmp|temp|bak|swp)$' },
          ],
          action: 'archive',
          actionConfig: { destinationDir: '~/BOS Review/Temp' },
          source: 'suggested',
        }));
      }
    }

    return suggestions;
  }

  /**
   * Record that a rule was executed.
   */
  async recordExecution(ruleId: string): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (!rule) return;
    rule.executionCount++;
    rule.lastExecutedAt = new Date();
    await this.persist(rule);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private evaluateCondition(
    condition: RuleCondition,
    filePath: string,
    meta: FileMetadata,
  ): boolean {
    switch (condition.field) {
      case 'extension':
        return this.matchString(meta.extension, condition.operator, condition.value);
      case 'name_pattern':
        return this.matchString(meta.name, condition.operator, condition.value);
      case 'directory':
        return this.matchString(filePath, condition.operator, condition.value);
      case 'size':
        return this.matchNumber(meta.size, condition.operator, parseInt(condition.value, 10));
      case 'age_days':
        return this.matchNumber(meta.ageDays, condition.operator, parseInt(condition.value, 10));
      case 'mime_type':
        return this.matchString(meta.mimeType ?? '', condition.operator, condition.value);
      default:
        return false;
    }
  }

  private matchString(value: string, operator: RuleCondition['operator'], pattern: string): boolean {
    switch (operator) {
      case 'equals':
        return value.toLowerCase() === pattern.toLowerCase();
      case 'contains':
        return value.toLowerCase().includes(pattern.toLowerCase());
      case 'matches':
        return new RegExp(pattern, 'i').test(value);
      default:
        return false;
    }
  }

  private matchNumber(value: number, operator: RuleCondition['operator'], threshold: number): boolean {
    switch (operator) {
      case 'greater_than':
        return value > threshold;
      case 'less_than':
        return value < threshold;
      case 'equals':
        return value === threshold;
      default:
        return false;
    }
  }

  private createRule(
    tenantId: string,
    userId: string,
    partial: Omit<FileRule, 'id' | 'tenantId' | 'userId' | 'enabled' | 'executionCount' | 'createdAt' | 'updatedAt'>,
  ): FileRule {
    return {
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      userId,
      enabled: false, // Suggested rules start disabled
      executionCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial,
    };
  }

  private async persist(_rule: FileRule): Promise<void> {
    // TODO: wire to Postgres data layer
  }

  private async deleteFromDb(_ruleId: string): Promise<void> {
    // TODO: wire to Postgres data layer
  }
}

// ── Supporting Types ────────────────────────────────────────────────

export interface FileMetadata {
  name: string;
  extension: string;
  size: number;
  ageDays: number;
  mimeType?: string;
}

export interface SuggestablePattern {
  type: 'downloads_clutter' | 'screenshot_buildup' | 'temp_files' | 'large_files';
  fileCount: number;
}

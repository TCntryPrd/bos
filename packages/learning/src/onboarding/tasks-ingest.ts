/**
 * Tasks Ingest — scans task lists for completion patterns,
 * priority preferences, and recurring task behavior.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern, ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface TaskItem {
  id: string;
  title: string;
  listName: string;
  completed: boolean;
  priority: 'low' | 'medium' | 'high' | 'none';
  createdAt: Date;
  completedAt?: Date;
  dueDate?: Date;
  isRecurring: boolean;
  overdue: boolean;
}

// ── Ingester ────────────────────────────────────────────────────────

export class TasksIngester implements PlatformIngester {
  readonly platform: PlatformName = 'tasks';

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('tasks', 0, 0, 'Scanning task lists...');

    const tasks = await this.fetchAllTasks(ctx);
    const total = tasks.length;
    tracker.updateProgress('tasks', 0, total, `Found ${total} tasks to analyze`);

    // Analyze
    const completed = tasks.filter((t) => t.completed);
    const overdue = tasks.filter((t) => t.overdue);
    const recurring = tasks.filter((t) => t.isRecurring);

    const priorityDist: Record<string, number> = { low: 0, medium: 0, high: 0, none: 0 };
    const listDist = new Map<string, { total: number; completed: number }>();
    const completionTimes: number[] = [];

    for (const task of tasks) {
      priorityDist[task.priority]++;

      const listEntry = listDist.get(task.listName) ?? { total: 0, completed: 0 };
      listEntry.total++;
      if (task.completed) listEntry.completed++;
      listDist.set(task.listName, listEntry);

      if (task.completed && task.completedAt) {
        const timeToComplete = task.completedAt.getTime() - task.createdAt.getTime();
        completionTimes.push(timeToComplete / (1000 * 60 * 60)); // hours
      }
    }

    tracker.updateProgress('tasks', total, total, 'Analysis complete');

    const patterns = this.buildPatterns(
      total, completed.length, overdue.length, recurring.length,
      priorityDist, listDist, completionTimes,
    );

    return {
      platform: 'tasks',
      itemsProcessed: total,
      patterns,
      metadata: {
        totalTasks: total,
        completedTasks: completed.length,
        overdueTasks: overdue.length,
        recurringTasks: recurring.length,
        listCount: listDist.size,
        priorityDistribution: priorityDist,
      },
    };
  }

  // ── Connector stubs ───────────────────────────────────────────────

  private async fetchAllTasks(_ctx: TenantContext): Promise<TaskItem[]> {
    // TODO: wire to @boss/connectors unified tasks.list()
    return [];
  }

  // ── Pattern building ──────────────────────────────────────────────

  private buildPatterns(
    total: number,
    completedCount: number,
    overdueCount: number,
    recurringCount: number,
    priorityDist: Record<string, number>,
    listDist: Map<string, { total: number; completed: number }>,
    completionTimes: number[],
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    if (total === 0) return patterns;

    // Completion rate
    const completionRate = Math.round((completedCount / total) * 100);
    patterns.push({
      category: 'tasks.completion',
      description: `Task completion rate: ${completionRate}%`,
      confidence: 0.85,
      evidence: [
        `${completedCount} of ${total} tasks completed`,
        `${overdueCount} overdue tasks`,
        `${recurringCount} recurring tasks`,
      ],
    });

    // Priority usage
    const topPriority = Object.entries(priorityDist)
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count > 0);

    patterns.push({
      category: 'tasks.priority',
      description: 'Priority usage patterns',
      confidence: 0.8,
      evidence: topPriority.map(([level, count]) => `${level}: ${count} tasks`),
    });

    // List performance
    const lists = Array.from(listDist.entries())
      .sort((a, b) => b[1].total - a[1].total);

    if (lists.length > 0) {
      patterns.push({
        category: 'tasks.lists',
        description: `${lists.length} task lists in use`,
        confidence: 0.9,
        evidence: lists.map(([name, data]) => {
          const rate = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;
          return `${name}: ${data.total} tasks (${rate}% completed)`;
        }),
      });
    }

    // Average completion time
    if (completionTimes.length > 0) {
      const avgHours = Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length);
      const avgDays = Math.round(avgHours / 24);
      patterns.push({
        category: 'tasks.velocity',
        description: `Average task completion time: ${avgDays > 0 ? `${avgDays} days` : `${avgHours} hours`}`,
        confidence: 0.75,
        evidence: [`Based on ${completionTimes.length} completed tasks`],
      });
    }

    return patterns;
  }
}

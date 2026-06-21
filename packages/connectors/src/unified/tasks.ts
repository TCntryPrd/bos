/**
 * Unified Tasks interface — provider-agnostic.
 * addTask(task) -> works with either Google Tasks or Microsoft To Do.
 */

import type {
  Task,
  TaskList,
  CreateTaskParams,
  UpdateTaskParams,
  TaskService,
  ConnectedAccount,
} from '../types.js';
import { GoogleTasksConnector } from '../google/tasks.js';
import { MicrosoftTasksConnector } from '../microsoft/tasks.js';
import type { GoogleClient } from '../google/api-client.js';
import type { GraphClient } from '../microsoft/graph-client.js';
import { logger } from '../logger.js';

export class UnifiedTaskService implements TaskService {
  private googleTasks = new Map<string, GoogleTasksConnector>();
  private msTasks = new Map<string, MicrosoftTasksConnector>();

  constructor(
    accounts: ConnectedAccount[],
    googleClient?: GoogleClient,
    graphClient?: GraphClient,
  ) {
    for (const account of accounts) {
      if (account.provider === 'google' && googleClient) {
        this.googleTasks.set(account.id, new GoogleTasksConnector(googleClient, account.id));
      } else if (account.provider === 'microsoft' && graphClient) {
        this.msTasks.set(account.id, new MicrosoftTasksConnector(graphClient, account.id));
      }
    }
  }

  async listTaskLists(accountId?: string): Promise<TaskList[]> {
    if (accountId) {
      return this.getConnector(accountId).listTaskLists();
    }

    const allLists: TaskList[] = [];
    for (const [, connector] of this.allConnectors()) {
      try {
        allLists.push(...(await connector.listTaskLists()));
      } catch (err) {
        logger.warn({ err }, 'Failed to list task lists');
      }
    }
    return allLists;
  }

  async listTasks(listId?: string, accountId?: string): Promise<Task[]> {
    if (accountId) {
      return this.getConnector(accountId).listTasks(listId);
    }

    const allTasks: Task[] = [];
    for (const [, connector] of this.allConnectors()) {
      try {
        allTasks.push(...(await connector.listTasks(listId)));
      } catch (err) {
        logger.warn({ err }, 'Failed to list tasks');
      }
    }
    return allTasks;
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.createTask(params);
  }

  async updateTask(params: UpdateTaskParams): Promise<Task> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.updateTask(params);
  }

  async completeTask(taskId: string, listId?: string, accountId?: string): Promise<Task> {
    if (accountId) {
      return this.getConnector(accountId).completeTask(taskId, listId);
    }
    return this.tryAll((c) => c.completeTask(taskId, listId));
  }

  async deleteTask(taskId: string, listId?: string, accountId?: string): Promise<void> {
    if (accountId) {
      return this.getConnector(accountId).deleteTask(taskId, listId);
    }
    return this.tryAll((c) => c.deleteTask(taskId, listId));
  }

  // ── Internal ──────────────────────────────────────────────────

  private getConnector(accountId: string): TaskConnector {
    const google = this.googleTasks.get(accountId);
    if (google) return google;
    const ms = this.msTasks.get(accountId);
    if (ms) return ms;
    throw new Error(`No task connector for account ${accountId}`);
  }

  private defaultConnector(): TaskConnector {
    const first =
      this.googleTasks.values().next().value ??
      this.msTasks.values().next().value;
    if (!first) throw new Error('No task accounts connected');
    return first;
  }

  private *allConnectors(): Generator<[string, TaskConnector]> {
    yield* this.googleTasks;
    yield* this.msTasks;
  }

  private async tryAll<T>(fn: (c: TaskConnector) => Promise<T>): Promise<T> {
    for (const [, connector] of this.allConnectors()) {
      try {
        return await fn(connector);
      } catch {
        continue;
      }
    }
    throw new Error('Operation failed across all task accounts');
  }
}

type TaskConnector = GoogleTasksConnector | MicrosoftTasksConnector;

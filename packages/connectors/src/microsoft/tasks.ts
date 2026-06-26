/**
 * Microsoft To Do connector via Graph API.
 * Task lists, CRUD, completion.
 */

import type {
  Task,
  TaskList,
  CreateTaskParams,
  UpdateTaskParams,
  Provider,
} from '../types.js';
import type { GraphClient } from './graph-client.js';

interface GraphTaskList {
  id: string;
  displayName: string;
}

interface GraphTask {
  id: string;
  title: string;
  body?: { content: string; contentType: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  status: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  completedDateTime?: { dateTime: string; timeZone: string };
  importance: 'low' | 'normal' | 'high';
}

export class MicrosoftTasksConnector {
  private readonly provider: Provider = 'microsoft';

  constructor(
    private client: GraphClient,
    private accountId: string,
  ) {}

  async listTaskLists(): Promise<TaskList[]> {
    const data = await this.client.get<{ value: GraphTaskList[] }>(
      '/me/todo/lists',
      undefined,
      { accountId: this.accountId },
    );

    return data.value.map((l) => ({
      id: l.id,
      accountId: this.accountId,
      provider: this.provider,
      name: l.displayName,
    }));
  }

  async listTasks(listId?: string): Promise<Task[]> {
    // If no listId, get tasks from all lists
    if (!listId) {
      const lists = await this.listTaskLists();
      const allTasks: Task[] = [];
      for (const list of lists) {
        const tasks = await this.fetchTasksFromList(list.id, list.name);
        allTasks.push(...tasks);
      }
      return allTasks;
    }

    return this.fetchTasksFromList(listId);
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    let lid = params.listId;
    if (!lid) {
      // Use default task list
      const lists = await this.listTaskLists();
      lid = lists[0]?.id;
      if (!lid) throw new Error('No task lists found');
    }

    const body: Record<string, unknown> = {
      title: params.title,
    };

    if (params.notes) {
      body.body = { content: params.notes, contentType: 'text' };
    }

    if (params.dueDate) {
      body.dueDateTime = {
        dateTime: params.dueDate.toISOString(),
        timeZone: 'UTC',
      };
    }

    if (params.priority) {
      body.importance = params.priority === 'medium' ? 'normal' : params.priority;
    }

    const data = await this.client.post<GraphTask>(
      `/me/todo/lists/${lid}/tasks`,
      body,
      { accountId: params.accountId ?? this.accountId },
    );

    return this.parseTask(data, lid);
  }

  async updateTask(params: UpdateTaskParams): Promise<Task> {
    const lid = params.listId;
    if (!lid) throw new Error('listId is required to update a Microsoft To Do task');

    const body: Record<string, unknown> = {};
    if (params.title !== undefined) body.title = params.title;
    if (params.notes !== undefined) {
      body.body = { content: params.notes, contentType: 'text' };
    }
    if (params.dueDate !== undefined) {
      body.dueDateTime = { dateTime: params.dueDate.toISOString(), timeZone: 'UTC' };
    }
    if (params.priority !== undefined) {
      body.importance = params.priority === 'medium' ? 'normal' : params.priority;
    }

    const data = await this.client.patch<GraphTask>(
      `/me/todo/lists/${lid}/tasks/${params.taskId}`,
      body,
      { accountId: params.accountId ?? this.accountId },
    );

    return this.parseTask(data, lid);
  }

  async completeTask(taskId: string, listId?: string): Promise<Task> {
    if (!listId) throw new Error('listId is required to complete a Microsoft To Do task');

    const data = await this.client.patch<GraphTask>(
      `/me/todo/lists/${listId}/tasks/${taskId}`,
      { status: 'completed' },
      { accountId: this.accountId },
    );

    return this.parseTask(data, listId);
  }

  async deleteTask(taskId: string, listId?: string): Promise<void> {
    if (!listId) throw new Error('listId is required to delete a Microsoft To Do task');

    await this.client.delete(
      `/me/todo/lists/${listId}/tasks/${taskId}`,
      { accountId: this.accountId },
    );
  }

  // ── Internal ──────────────────────────────────────────────────

  private async fetchTasksFromList(listId: string, listName?: string): Promise<Task[]> {
    const data = await this.client.get<{ value: GraphTask[] }>(
      `/me/todo/lists/${listId}/tasks`,
      { $filter: "status ne 'completed'" },
      { accountId: this.accountId },
    );

    return data.value.map((t) => this.parseTask(t, listId, listName));
  }

  private parseTask(task: GraphTask, listId: string, listName?: string): Task {
    return {
      id: task.id,
      accountId: this.accountId,
      provider: this.provider,
      title: task.title,
      notes: task.body?.content,
      dueDate: task.dueDateTime ? new Date(task.dueDateTime.dateTime) : undefined,
      isCompleted: task.status === 'completed',
      completedAt: task.completedDateTime
        ? new Date(task.completedDateTime.dateTime)
        : undefined,
      listId,
      listName,
      priority: task.importance === 'normal' ? 'medium' : task.importance,
      status: task.status,
    };
  }
}

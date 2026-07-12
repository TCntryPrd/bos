/**
 * Google Tasks connector — task lists, CRUD, completion.
 */

import type { Task, TaskList, CreateTaskParams, UpdateTaskParams, Provider } from '../types.js';
import type { GoogleClient } from './api-client.js';

const TASKS = '/tasks/v1';

interface GTask { id: string; title: string; notes?: string; due?: string; status: string; completed?: string }

export class GoogleTasksConnector {
  private readonly provider: Provider = 'google';
  constructor(private client: GoogleClient, private accountId: string) {}

  async listTaskLists(): Promise<TaskList[]> {
    const data = await this.client.get<{ items?: { id: string; title: string }[] }>(
      `${TASKS}/users/@me/lists`, undefined, { accountId: this.accountId },
    );
    return (data.items ?? []).map((l) => ({ id: l.id, accountId: this.accountId, provider: this.provider, name: l.title }));
  }

  async listTasks(listId?: string): Promise<Task[]> {
    const lid = listId ?? '@default';
    const data = await this.client.get<{ items?: GTask[] }>(
      `${TASKS}/lists/${lid}/tasks`, { showCompleted: 'false', showHidden: 'false' }, { accountId: this.accountId },
    );
    return (data.items ?? []).map((t) => this.parse(t, lid));
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    const lid = params.listId ?? '@default';
    const body: Record<string, unknown> = { title: params.title, notes: params.notes };
    if (params.dueDate) body.due = params.dueDate.toISOString();
    const data = await this.client.post<GTask>(`${TASKS}/lists/${lid}/tasks`, body, { accountId: params.accountId ?? this.accountId });
    return this.parse(data, lid);
  }

  async updateTask(params: UpdateTaskParams): Promise<Task> {
    const lid = params.listId ?? '@default';
    const body: Record<string, unknown> = {};
    if (params.title !== undefined) body.title = params.title;
    if (params.notes !== undefined) body.notes = params.notes;
    if (params.dueDate !== undefined) body.due = params.dueDate.toISOString();
    const data = await this.client.patch<GTask>(`${TASKS}/lists/${lid}/tasks/${params.taskId}`, body, { accountId: params.accountId ?? this.accountId });
    return this.parse(data, lid);
  }

  async completeTask(taskId: string, listId?: string): Promise<Task> {
    const lid = listId ?? '@default';
    const data = await this.client.patch<GTask>(`${TASKS}/lists/${lid}/tasks/${taskId}`, { status: 'completed' }, { accountId: this.accountId });
    return this.parse(data, lid);
  }

  async deleteTask(taskId: string, listId?: string): Promise<void> {
    await this.client.delete(`${TASKS}/lists/${listId ?? '@default'}/tasks/${taskId}`, { accountId: this.accountId });
  }

  private parse(task: GTask, listId: string): Task {
    return {
      id: task.id, accountId: this.accountId, provider: this.provider,
      title: task.title, notes: task.notes,
      dueDate: task.due ? new Date(task.due) : undefined,
      isCompleted: task.status === 'completed',
      completedAt: task.completed ? new Date(task.completed) : undefined,
      listId,
    };
  }
}

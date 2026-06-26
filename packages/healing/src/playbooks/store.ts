/**
 * Playbook store — CRUD for playbook entries in Postgres.
 *
 * Playbooks live in the `boss.playbooks` table.
 * Schema (created by the DB migration layer):
 *
 *   CREATE TABLE boss.playbooks (
 *     id TEXT PRIMARY KEY,
 *     failure_signature TEXT NOT NULL,
 *     service TEXT NOT NULL,
 *     severity TEXT NOT NULL,
 *     diagnosis_steps JSONB NOT NULL,
 *     fix_steps JSONB NOT NULL,
 *     verification TEXT NOT NULL,
 *     success_count INTEGER NOT NULL DEFAULT 0,
 *     last_used TIMESTAMPTZ,
 *     created_from_incident TEXT NOT NULL,
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 * This module uses raw HTTP calls to the BOS internal API rather than
 * pulling in a Postgres client, keeping the healing package dependency-light.
 */

import type { Playbook, ServiceName, PlaybookSeverity } from '@boss/core';

export interface PlaybookStoreConfig {
  /** BOS internal API base URL. Default: http://localhost:3000 */
  apiBaseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface CreatePlaybookInput {
  failureSignature: string;
  service: ServiceName;
  severity: PlaybookSeverity;
  diagnosisSteps: string[];
  fixSteps: string[];
  verification: string;
  createdFromIncident: string;
}

export class PlaybookStore {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: PlaybookStoreConfig = {}) {
    this.baseUrl = (config.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'x-boss-api-key': this.apiKey } : {}),
    };
  }

  async create(input: CreatePlaybookInput): Promise<Playbook> {
    const res = await fetch(`${this.baseUrl}/internal/playbooks`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`PlaybookStore.create failed ${res.status}: ${body}`);
    }

    return (await res.json()) as Playbook;
  }

  async getById(id: string): Promise<Playbook | undefined> {
    const res = await fetch(`${this.baseUrl}/internal/playbooks/${id}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 404) return undefined;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`PlaybookStore.getById failed ${res.status}: ${body}`);
    }

    return (await res.json()) as Playbook;
  }

  async list(service?: ServiceName): Promise<Playbook[]> {
    const url = service
      ? `${this.baseUrl}/internal/playbooks?service=${encodeURIComponent(service)}`
      : `${this.baseUrl}/internal/playbooks`;

    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`PlaybookStore.list failed ${res.status}: ${body}`);
    }

    return (await res.json()) as Playbook[];
  }

  async incrementSuccess(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/playbooks/${id}/success`, {
      method: 'POST',
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`PlaybookStore.incrementSuccess failed ${res.status}: ${body}`);
    }
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/playbooks/${id}`, {
      method: 'DELETE',
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '');
      throw new Error(`PlaybookStore.delete failed ${res.status}: ${body}`);
    }
  }
}

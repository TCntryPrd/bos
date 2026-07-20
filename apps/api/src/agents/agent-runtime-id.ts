import { createHash } from 'node:crypto';

export type AgentRuntimeKind = 'rascal' | 'outsider';

function safePart(value: string, fallback: string, max: number): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || fallback;
}

/**
 * Stable composite namespace for host tmux sessions and marker files.
 * Tenant hash prevents two tenants with the same readable slug from sharing a
 * shell; kind prevents a rascal and outsider with the same handle colliding.
 */
export function agentRuntimeId(
  tenantId: string,
  kind: AgentRuntimeKind,
  handle: string,
): string {
  const tenant = safePart(tenantId, 'default', 18);
  const agent = safePart(handle, 'agent', 32);
  const digest = createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
  return `${kind}-${agent}-${tenant}-${digest}`;
}

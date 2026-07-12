/**
 * advisor-memory.ts — cognitive-memory-lite for AI advisors.
 *
 * recallMemories() pulls an advisor's most salient/recent memories (identity always first) and
 * reinforces them on use; memoryBlock() renders them for the system prompt; writeMemory() stores
 * a new durable memory. The brain-driven reflection (extract learnings after an exchange) lives in
 * board.ts (where callBrain is) and calls writeMemory.
 */
import { getPool } from '../db.js';
import { currentTenantId } from './tenant.js';

export interface Memory { id: string; kind: string; content: string; salience: number }

/** Pull an advisor's memories (identity first, then by salience/recency) and reinforce them. */
export async function recallMemories(tenantId: string, advisorId: string, limit = 12): Promise<Memory[]> {
  const t = currentTenantId(tenantId);
  const { rows } = await getPool().query<Memory>(
    `SELECT id, kind, content, salience FROM boss_advisor_memory
     WHERE tenant_id=$1 AND advisor_id=$2
     ORDER BY (kind='identity') DESC, salience DESC, last_used_at DESC NULLS LAST, created_at DESC
     LIMIT $3`,
    [t, advisorId, limit]).catch(() => ({ rows: [] as Memory[] }));
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    // reinforce on recall (salience up, capped), best-effort
    getPool().query(`UPDATE boss_advisor_memory SET use_count=use_count+1, last_used_at=now(), salience=LEAST(salience+0.1, 5.0) WHERE id = ANY($1)`, [ids]).catch(() => { /* noop */ });
  }
  return rows;
}

/** Render recalled memories into a system-prompt block. */
export function memoryBlock(mems: Memory[]): string {
  if (!mems.length) return '';
  const byKind: Record<string, string[]> = {};
  for (const m of mems) (byKind[m.kind] ??= []).push(m.content);
  const order = ['identity', 'knowledge', 'procedure', 'episode'];
  const parts = order.filter((k) => byKind[k]).map((k) => `${k.toUpperCase()}\n` + byKind[k].map((c) => `- ${c}`).join('\n'));
  return `\n\n## Your memory (what you've learned as this advisor — recall and build on it)\n${parts.join('\n')}\n`;
}

/** Store a durable memory for an advisor (deduped against an exact recent match). */
export async function writeMemory(tenantId: string, advisorId: string, kind: string, content: string): Promise<void> {
  const t = currentTenantId(tenantId);
  const c = content.trim().slice(0, 1000);
  if (c.length < 8) return;
  const dup = await getPool().query(`SELECT 1 FROM boss_advisor_memory WHERE tenant_id=$1 AND advisor_id=$2 AND content=$3 LIMIT 1`, [t, advisorId, c]).then((r) => r.rowCount).catch(() => 0);
  if (dup) { await getPool().query(`UPDATE boss_advisor_memory SET salience=LEAST(salience+0.2,5.0), last_used_at=now() WHERE tenant_id=$1 AND advisor_id=$2 AND content=$3`, [t, advisorId, c]).catch(() => {}); return; }
  await getPool().query(`INSERT INTO boss_advisor_memory (tenant_id, advisor_id, kind, content) VALUES ($1,$2,$3,$4)`, [t, advisorId, ['identity', 'knowledge', 'procedure', 'episode'].includes(kind) ? kind : 'knowledge', c]).catch(() => { /* noop */ });
}

/** List an advisor's memories (for a UI). */
export async function listMemories(tenantId: string, advisorId: string): Promise<(Memory & { use_count: number; created_at: string })[]> {
  const { rows } = await getPool().query(
    `SELECT id, kind, content, salience, use_count, created_at FROM boss_advisor_memory WHERE tenant_id=$1 AND advisor_id=$2 ORDER BY (kind='identity') DESC, salience DESC LIMIT 100`,
    [currentTenantId(tenantId), advisorId]).catch(() => ({ rows: [] }));
  return rows as (Memory & { use_count: number; created_at: string })[];
}

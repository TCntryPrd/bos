/**
 * boss_route_client_email — is this email from a known CLIENT? If so, which rascal
 * (client manager) owns them? Client emails are routed to their manager's board (the
 * rascal has that client's full context and drafts the reply), NOT the generic Drafter.
 * Deterministic lookup against boss_rascals.client (the model just acts on the result).
 */
import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

const STOP = new Set([
  'the', 'and', 'ai', 'llc', 'inc', 'ltd', 'co', 'corp', 'brand', 'group', 'team',
  'district', 'productions', 'craft', 'architecture', 'solutions', 'studio', 'agency',
  'industry', 'rockstar', 'trusted', 'gatorpixel',
]);

function tokens(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .split(/[\s@.]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));
}

export const routeClientEmailTool: BrainTool = {
  name: 'boss_route_client_email',
  description:
    'Check whether an email sender is a known CLIENT managed by a rascal (client manager). Pass the sender (name and/or email) and subject. ' +
    'Returns JSON {matched, rascal, manager, client}. If matched, route the reply to that rascal (their board) instead of drafting it generically — they have the client context. If not matched, handle it as a normal reply.',
  parameters: {
    type: 'object',
    properties: {
      sender: { type: 'string', description: 'Sender display name and/or email address.' },
      subject: { type: 'string', description: 'Email subject (optional, helps disambiguate).' },
    },
    required: ['sender'],
  },
};

export const ALL_CLIENT_ROUTING_TOOLS: BrainTool[] = [routeClientEmailTool];

async function handleRouteClientEmail(args: Record<string, unknown>): Promise<string> {
  const hay = `${String(args.sender ?? '')} ${String(args.subject ?? '')}`.toLowerCase();
  if (!hay.trim()) return JSON.stringify({ matched: false });
  const { rows } = await getPool().query<{ handle: string; display_name: string; client: string }>(
    `SELECT handle, display_name, client FROM boss_rascals WHERE enabled = true AND client IS NOT NULL AND client <> ''`,
  );
  let best: { handle: string; display_name: string; client: string } | null = null;
  let bestScore = 0;
  for (const r of rows) {
    const ctoks = tokens(r.client);
    let score = 0;
    for (const t of ctoks) if (hay.includes(t)) score++;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (best && bestScore >= 1) {
    return JSON.stringify({ matched: true, rascal: best.handle, manager: best.display_name, client: best.client });
  }
  return JSON.stringify({ matched: false });
}

export const CLIENT_ROUTING_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_route_client_email: handleRouteClientEmail,
};

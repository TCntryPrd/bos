/**
 * Miro brain tools for BOS.
 *
 * Execution uses MIRO_ACCESS_TOKEN server-side. Tokens are never exposed to the
 * browser or to Codex prompts.
 */

import type { BrainTool } from '@boss/brain';

const MIRO_API = 'https://api.miro.com/v2';

interface MiroFetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

interface BoardListResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    viewLink?: string;
    modifiedAt?: string;
    team?: { id?: string; name?: string };
  }>;
  total?: number;
}

interface BoardDetailResponse {
  id?: string;
  name?: string;
  description?: string;
  viewLink?: string;
  modifiedAt?: string;
}

interface BoardItemsResponse {
  data?: Array<{
    id?: string;
    type?: string;
    data?: Record<string, unknown>;
    position?: { x?: number; y?: number };
    modifiedAt?: string;
  }>;
  total?: number;
  cursor?: string;
}

async function miroFetch<T>(path: string, init: RequestInit = {}): Promise<MiroFetchResult<T>> {
  const token = process.env.MIRO_ACCESS_TOKEN;
  if (!token) return { ok: false, status: 503, error: 'MIRO_ACCESS_TOKEN not configured' };

  try {
    const res = await fetch(`${MIRO_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: (await res.text()).slice(0, 500) };
    }
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

function boardSummary(board: BoardDetailResponse): string {
  return [
    `id: ${board.id ?? '(unknown)'}`,
    `name: ${board.name ?? '(untitled)'}`,
    board.viewLink ? `link: ${board.viewLink}` : null,
    board.modifiedAt ? `modified: ${board.modifiedAt}` : null,
    board.description ? `description: ${board.description}` : null,
  ].filter(Boolean).join('\n');
}

export const miroHealthTool: BrainTool = {
  name: 'boss_miro_health',
  description: 'Check whether the Miro integration token is configured and can reach Miro.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const miroListBoardsTool: BrainTool = {
  name: 'boss_miro_list_boards',
  description: 'List Miro boards visible to the connected Miro account, newest modified first.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum boards to return, 1-50. Defaults to 20.' },
      offset: { type: 'number', description: 'Pagination offset. Defaults to 0.' },
    },
    required: [],
  },
};

export const miroGetBoardTool: BrainTool = {
  name: 'boss_miro_get_board',
  description: 'Get details for one Miro board by board ID.',
  parameters: {
    type: 'object',
    properties: {
      board_id: { type: 'string', description: 'Miro board ID.' },
    },
    required: ['board_id'],
  },
};

export const miroCreateBoardTool: BrainTool = {
  name: 'boss_miro_create_board',
  description: 'Create a new Miro board. Use only when the operator has asked to create one.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Board name.' },
      description: { type: 'string', description: 'Optional board description.' },
    },
    required: ['name'],
  },
};

export const miroListItemsTool: BrainTool = {
  name: 'boss_miro_list_items',
  description: 'List items on a Miro board by board ID.',
  parameters: {
    type: 'object',
    properties: {
      board_id: { type: 'string', description: 'Miro board ID.' },
      limit: { type: 'number', description: 'Maximum items to return, 1-50. Defaults to 20.' },
      cursor: { type: 'string', description: 'Optional Miro pagination cursor.' },
    },
    required: ['board_id'],
  },
};

export const ALL_MIRO_TOOLS: BrainTool[] = [
  miroHealthTool,
  miroListBoardsTool,
  miroGetBoardTool,
  miroCreateBoardTool,
  miroListItemsTool,
];

export async function executeMiroTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'boss_miro_health': {
      const result = await miroFetch<BoardListResponse>('/boards?limit=1');
      if (!result.ok) return `Miro unavailable: HTTP ${result.status} ${result.error ?? ''}`.trim();
      return `Miro connected. Visible boards: ${result.data?.total ?? 0}`;
    }

    case 'boss_miro_list_boards': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const result = await miroFetch<BoardListResponse>(`/boards?limit=${limit}&offset=${offset}&sort=last_modified`);
      if (!result.ok) return `Miro board list failed: HTTP ${result.status} ${result.error ?? ''}`.trim();
      const boards = result.data?.data ?? [];
      if (boards.length === 0) return 'No Miro boards found.';
      return boards.map((board, index) => {
        const team = board.team?.name ? ` team="${board.team.name}"` : '';
        const link = board.viewLink ? ` link=${board.viewLink}` : '';
        return `${index + 1}. ${board.name ?? '(untitled)'} id=${board.id ?? '(unknown)'}${team}${link}`;
      }).join('\n');
    }

    case 'boss_miro_get_board': {
      const boardId = String(args.board_id || '').trim();
      if (!boardId) return 'board_id is required.';
      const result = await miroFetch<BoardDetailResponse>(`/boards/${encodeURIComponent(boardId)}`);
      if (!result.ok) return `Miro board lookup failed: HTTP ${result.status} ${result.error ?? ''}`.trim();
      return boardSummary(result.data ?? {});
    }

    case 'boss_miro_create_board': {
      const name = String(args.name || '').trim();
      if (!name) return 'name is required.';
      const result = await miroFetch<BoardDetailResponse>('/boards', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: String(args.description || ''),
          policy: {
            permissionsPolicy: {
              collaborationToolsStartAccess: 'all_editors',
              copyAccess: 'team_members',
              sharingAccess: 'team_members_with_editing',
            },
          },
        }),
      });
      if (!result.ok) return `Miro board creation failed: HTTP ${result.status} ${result.error ?? ''}`.trim();
      return `Created Miro board:\n${boardSummary(result.data ?? {})}`;
    }

    case 'boss_miro_list_items': {
      const boardId = String(args.board_id || '').trim();
      if (!boardId) return 'board_id is required.';
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const cursor = args.cursor ? `&cursor=${encodeURIComponent(String(args.cursor))}` : '';
      const result = await miroFetch<BoardItemsResponse>(`/boards/${encodeURIComponent(boardId)}/items?limit=${limit}${cursor}`);
      if (!result.ok) return `Miro board item list failed: HTTP ${result.status} ${result.error ?? ''}`.trim();
      const items = result.data?.data ?? [];
      if (items.length === 0) return 'No Miro board items found.';
      const rows = items.map((item, index) => {
        const title = typeof item.data?.title === 'string' ? ` title="${item.data.title.slice(0, 80)}"` : '';
        const content = typeof item.data?.content === 'string' ? ` content="${item.data.content.replace(/<[^>]*>/g, '').slice(0, 80)}"` : '';
        return `${index + 1}. ${item.type ?? 'item'} id=${item.id ?? '(unknown)'}${title}${content}`;
      });
      if (result.data?.cursor) rows.push(`next_cursor: ${result.data.cursor}`);
      return rows.join('\n');
    }

    default:
      return `Unknown Miro tool: ${name}`;
  }
}

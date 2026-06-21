/**
 * Weaviate vector search tools — semantic search across email memory, knowledge base, and project data.
 */

import type { BrainTool } from '@boss/brain';

const WEAVIATE_URL = process.env.WEAVIATE_URL ?? "http://weaviate:8080";
const GEMINI_EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent';

async function getGeminiKey(): Promise<string> {
  // Try env first, then runtime config
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const { getRuntimeConfig } = await import('../config-store.js');
    return await getRuntimeConfig('GEMINI_API_KEY', 'default') || '';
  } catch {
    return '';
  }
}

async function embed(text: string): Promise<number[]> {
  const key = await getGeminiKey();
  if (!key) throw new Error('No GEMINI_API_KEY configured');

  const res = await fetch(`${GEMINI_EMBED_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-2-preview',
      content: { parts: [{ text: text.slice(0, 7500) }] },
    }),
  });

  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = await res.json() as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

async function searchWeaviate(collection: string, query: string, limit: number): Promise<string> {
  try {
    const vector = await embed(query);
    if (vector.length === 0) return 'Embedding failed — no results';

    const graphql = {
      query: `{Get{${collection}(nearVector:{vector:${JSON.stringify(vector)}},limit:${limit}){text${collection === 'Email' ? '' : ' title source'}}}}`,
    };

    const res = await fetch(`${WEAVIATE_URL}/v1/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graphql),
    });

    if (!res.ok) return `Weaviate error: ${res.status}`;
    const data = await res.json() as Record<string, unknown>;
    const results = ((data as any).data?.Get?.[collection] ?? []) as Array<Record<string, string>>;

    if (results.length === 0) return 'No results found.';

    return results.map((r, i) => {
      const text = (r.text || '').slice(0, 600);
      const title = r.title ? `[${r.title}] ` : '';
      return `${i + 1}. ${title}${text}`;
    }).join('\n\n');
  } catch (err) {
    return `Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function keywordSearch(collection: string, query: string, limit: number): Promise<string> {
  try {
    const graphql = {
      query: `{Get{${collection}(bm25:{query:"${query.replace(/"/g, '\\"')}"},limit:${limit}){text${collection === 'Email' ? '' : ' title source'}}}}`,
    };

    const res = await fetch(`${WEAVIATE_URL}/v1/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graphql),
    });

    if (!res.ok) return `Weaviate error: ${res.status}`;
    const data = await res.json() as Record<string, unknown>;
    const results = ((data as any).data?.Get?.[collection] ?? []) as Array<Record<string, string>>;

    if (results.length === 0) return 'No results found.';

    return results.map((r, i) => {
      const text = (r.text || '').slice(0, 600);
      const title = r.title ? `[${r.title}] ` : '';
      return `${i + 1}. ${title}${text}`;
    }).join('\n\n');
  } catch (err) {
    return `Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function ingestKnowledge(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text || '').trim();
  if (!text) return 'Nothing to ingest (empty text).';
  const title = String(args.title || '');
  const source = String(args.source || '');
  const project = args.project ? String(args.project) : '';

  let vector: number[];
  try {
    vector = await embed(text);
  } catch (err) {
    return `Ingest failed (embedding): ${err instanceof Error ? err.message : String(err)}`;
  }
  if (vector.length === 0) return 'Ingest failed — embedding returned no vector.';

  try {
    const res = await fetch(`${WEAVIATE_URL}/v1/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class: 'Knowledge',
        properties: { text: text.slice(0, 20000), title, source, project },
        vector,
      }),
    });
    if (!res.ok) return `Ingest failed: ${res.status} ${(await res.text()).slice(0, 200)}`;
    const d = await res.json() as { id?: string };
    return `Ingested into knowledge base (Knowledge/${d.id ?? '?'}): "${title || source || 'untitled'}"`;
  } catch (err) {
    return `Ingest error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const weaviateEmailSearchTool: BrainTool = {
  name: 'boss_email_search',
  description:
    'Search BOS\'s memory using semantic (meaning-based) search. Searches emails, documents, PDFs, project files — ' +
    'everything that has been ingested. Use when Kevin asks about conversations, people, projects, documents, ' +
    'what someone said, what was discussed, or anything from his history. Returns the most relevant matches by meaning.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for. Describe what you\'re looking for in natural language. Example: "emails about mortgage financing from Chris Pessy" or "conversations about Paperclip production schedule"',
      },
      limit: { type: 'number', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },
};

export const weaviateEmailKeywordTool: BrainTool = {
  name: 'boss_email_keyword_search',
  description:
    'Search BOS\'s memory by exact keyword match (BM25). Use when searching for a specific name, email address, ' +
    'subject line, document title, or exact phrase. Faster than semantic search but only matches exact words.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Exact keywords to search for. Example: "Chris Pessy" or "SOW" or "financing Unit 1706"' },
      limit: { type: 'number', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },
};

export const weaviateKnowledgeSearchTool: BrainTool = {
  name: 'boss_knowledge_search',
  description:
    'Search the shared knowledge base — playbooks, client project files, meeting transcripts, reference documents. ' +
    'Use when Kevin asks about a client project, a process, a tool, or needs to find documentation.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for in the knowledge base' },
      project: { type: 'string', description: 'Optional: filter by project name (e.g., "john-berfelo", "chris-pessy")' },
      limit: { type: 'number', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },
};

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeWeaviateTool(name: string, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || '');
  const limit = Number(args.limit) || 5;

  switch (name) {
    case 'boss_email_search':
      return searchWeaviate('Email', query, limit);

    case 'boss_email_keyword_search':
      return keywordSearch('Email', query, limit);

    case 'boss_knowledge_search': {
      // Search Knowledge collection, optionally filtered by project
      const project = args.project ? String(args.project) : null;
      if (project) {
        // Use a filter + vector search
        try {
          const vector = await embed(query);
          const graphql = {
            query: `{Get{Knowledge(nearVector:{vector:${JSON.stringify(vector)}},where:{path:["project"],operator:Equal,valueText:"${project}"},limit:${limit}){text title source}}}`,
          };
          const res = await fetch(`${WEAVIATE_URL}/v1/graphql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(graphql),
          });
          const data = await res.json() as any;
          const results = data.data?.Get?.Knowledge ?? [];
          if (results.length === 0) return `No results for "${query}" in project "${project}"`;
          return results.map((r: any, i: number) => `${i + 1}. [${r.title}] ${(r.text || '').slice(0, 600)}`).join('\n\n');
        } catch (err) {
          return `Search error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return searchWeaviate('Knowledge', query, limit);
    }

    case 'boss_knowledge_ingest':
      return ingestKnowledge(args);

    default:
      return `Unknown Weaviate tool: ${name}`;
  }
}

export const weaviateKnowledgeIngestTool: BrainTool = {
  name: 'boss_knowledge_ingest',
  description:
    'Add a document, note, or email into the shared knowledge base (Weaviate) so it becomes semantically searchable later via boss_knowledge_search. ' +
    'Use this to ingest important/processed email content, meeting notes, client context, or reference material. Provide the text plus a short title and a source tag.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The full text content to store and index.' },
      title: { type: 'string', description: 'A short title / subject for the entry.' },
      source: { type: 'string', description: 'Where it came from, e.g. "email:d.caine@dcaine.com" or "meeting-notes".' },
      project: { type: 'string', description: 'Optional project/client tag for later filtering.' },
    },
    required: ['text', 'title'],
  },
};

export const ALL_WEAVIATE_TOOLS: BrainTool[] = [
  weaviateEmailSearchTool,
  weaviateEmailKeywordTool,
  weaviateKnowledgeSearchTool,
  weaviateKnowledgeIngestTool,
];

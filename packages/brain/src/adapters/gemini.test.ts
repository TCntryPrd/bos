/**
 * Unit tests — GeminiAdapter
 *
 * All HTTP calls are intercepted via vi.stubGlobal('fetch', ...).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiAdapter } from './gemini.js';
import type { BrainRequest } from '../types.js';

function makeRequest(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    id: 'req-001',
    type: 'chat',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'Explain photosynthesis',
    ...overrides,
  };
}

function makeGeminiResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 15, totalTokenCount: 23 },
  };
}

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(''),
    body: null,
  });
}

describe('GeminiAdapter — construction', () => {
  it('sets correct capabilities', () => {
    const adapter = new GeminiAdapter({ apiKey: 'gk-test' });
    expect(adapter.info.capabilities.canChat).toBe(true);
    expect(adapter.info.capabilities.canExecuteCode).toBe(true);
    expect(adapter.info.capabilities.canSpawnAgents).toBe(false);
    expect(adapter.info.id).toBe('gemini');
  });

  it('uses a custom priority', () => {
    const adapter = new GeminiAdapter({ apiKey: 'gk-test', priority: 7 });
    expect(adapter.info.priority).toBe(7);
  });

  it('starts with status "ready"', () => {
    const adapter = new GeminiAdapter({ apiKey: 'gk-test' });
    expect(adapter.info.status).toBe('ready');
  });
});

describe('GeminiAdapter — execute()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the Gemini generateContent endpoint', async () => {
    const mockFetch = mockFetchOk(makeGeminiResponse('Photosynthesis is...'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    await adapter.execute(makeRequest());

    const [url] = mockFetch.mock.calls[0];
    expect(url as string).toContain('generateContent');
    expect(url as string).toContain('AIza-test');
  });

  it('returns content from the first candidate text part', async () => {
    vi.stubGlobal('fetch', mockFetchOk(makeGeminiResponse('A detailed answer')));

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    const response = await adapter.execute(makeRequest({ id: 'req-g1' }));

    expect(response.content).toBe('A detailed answer');
    expect(response.requestId).toBe('req-g1');
    expect(response.adapterId).toBe('gemini');
  });

  it('maps usageMetadata to response.usage', async () => {
    vi.stubGlobal('fetch', mockFetchOk(makeGeminiResponse('done')));

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    const response = await adapter.execute(makeRequest());

    expect(response.usage?.inputTokens).toBe(8);
    expect(response.usage?.outputTokens).toBe(15);
    expect(response.usage?.totalTokens).toBe(23);
  });

  it('maps functionCall parts to toolCalls', async () => {
    const responseWithFnCall = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { name: 'search_calendar', args: { query: 'standup' } } },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    };
    vi.stubGlobal('fetch', mockFetchOk(responseWithFnCall));

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    const response = await adapter.execute(makeRequest());

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('search_calendar');
    expect(response.toolCalls![0].arguments).toEqual({ query: 'standup' });
  });

  it('includes tools in the request body when provided', async () => {
    const mockFetch = mockFetchOk(makeGeminiResponse('ok'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    await adapter.execute(makeRequest({
      tools: [{
        name: 'list_tasks',
        description: 'Lists tasks',
        parameters: { type: 'object', properties: {} },
      }],
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toBeDefined();
    expect(body.tools[0].functionDeclarations[0].name).toBe('list_tasks');
  });

  it('throws on non-2xx API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('invalid key'),
    }));

    const adapter = new GeminiAdapter({ apiKey: 'bad-key' });
    await expect(adapter.execute(makeRequest())).rejects.toThrow('Gemini API error 400');
  });

  it('omits system role from conversation history', async () => {
    const mockFetch = mockFetchOk(makeGeminiResponse('ok'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    await adapter.execute(makeRequest({
      context: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationHistory: [
          { role: 'system', content: 'You are a helpful assistant', timestamp: 0 },
          { role: 'user', content: 'hi', timestamp: 1 },
          { role: 'assistant', content: 'hello', timestamp: 2 },
        ],
      },
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    // system should be omitted, user + assistant + current prompt = 3 entries
    expect(body.contents).toHaveLength(3);
    expect(body.contents.every((c: { role: string }) => c.role !== 'system')).toBe(true);
  });

  it('maps assistant role to "model" in Gemini API format', async () => {
    const mockFetch = mockFetchOk(makeGeminiResponse('ok'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    await adapter.execute(makeRequest({
      context: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationHistory: [
          { role: 'assistant', content: 'previous reply', timestamp: 1 },
        ],
      },
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const assistantEntry = body.contents.find((c: { role: string }) => c.role === 'model');
    expect(assistantEntry).toBeDefined();
  });

  it('handles empty candidates gracefully', async () => {
    vi.stubGlobal('fetch', mockFetchOk({ candidates: [], usageMetadata: null }));

    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    const response = await adapter.execute(makeRequest());
    expect(response.content).toBe('');
    expect(response.toolCalls).toHaveLength(0);
  });
});

describe('GeminiAdapter — healthCheck()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns "ready" when the models list endpoint responds ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    const status = await adapter.healthCheck();
    expect(status).toBe('ready');
  });

  it('returns "unavailable" on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const adapter = new GeminiAdapter({ apiKey: 'bad-key' });
    const status = await adapter.healthCheck();
    expect(status).toBe('unavailable');
  });

  it('returns "unavailable" on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    const adapter = new GeminiAdapter({ apiKey: 'AIza-test' });
    const status = await adapter.healthCheck();
    expect(status).toBe('unavailable');
  });
});

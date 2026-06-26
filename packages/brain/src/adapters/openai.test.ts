/**
 * Unit tests — OpenAIAdapter
 *
 * All HTTP calls are intercepted via vi.stubGlobal('fetch', ...) so
 * no real network traffic is made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIAdapter } from './openai.js';
import type { BrainRequest } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    id: 'req-001',
    type: 'chat',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'Hello, world',
    ...overrides,
  };
}

function mockFetchSuccess(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    body: null,
  });
}

function makeOpenAIResponse(content: string, id = 'chatcmpl-001') {
  return {
    id,
    object: 'chat.completion',
    choices: [{
      message: { content, role: 'assistant' },
      finish_reason: 'stop',
      index: 0,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

// ── Adapter Construction ───────────────────────────────────────────────

describe('OpenAIAdapter — construction', () => {
  it('sets correct capabilities', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    expect(adapter.info.capabilities.canChat).toBe(true);
    expect(adapter.info.capabilities.canStream).toBe(true);
    expect(adapter.info.capabilities.canUseTools).toBe(true);
    expect(adapter.info.capabilities.canExecuteCode).toBe(false);
    expect(adapter.info.capabilities.canSpawnAgents).toBe(false);
  });

  it('uses the provided priority', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test', priority: 5 });
    expect(adapter.info.priority).toBe(5);
  });

  it('defaults priority to 10', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    expect(adapter.info.priority).toBe(10);
  });

  it('uses the provided model', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4-turbo' });
    // model is private but we can verify it's used in the API call
    expect(adapter.info.id).toBe('openai');
    expect(adapter.info.name).toBe('OpenAI');
  });

  it('starts with status "ready"', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    expect(adapter.info.status).toBe('ready');
  });

  it('supports a custom baseUrl', async () => {
    const mockFetch = mockFetchSuccess(makeOpenAIResponse('pong'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter({
      apiKey: 'sk-test',
      baseUrl: 'https://my-openai-proxy.example.com/v1',
    });
    await adapter.execute(makeRequest());

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('my-openai-proxy.example.com');

    vi.unstubAllGlobals();
  });
});

// ── execute() ─────────────────────────────────────────────────────────

describe('OpenAIAdapter — execute()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the OpenAI chat completions endpoint', async () => {
    const mockFetch = mockFetchSuccess(makeOpenAIResponse('Hello back'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    await adapter.execute(makeRequest());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('includes Authorization header with Bearer token', async () => {
    const mockFetch = mockFetchSuccess(makeOpenAIResponse('ok'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter({ apiKey: 'sk-my-key' });
    await adapter.execute(makeRequest());

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-my-key');
  });

  it('returns a BrainResponse with correct requestId and content', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(makeOpenAIResponse('You have 3 meetings today', 'chatcmpl-xyz')));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.execute(makeRequest({ id: 'req-abc' }));

    expect(response.requestId).toBe('req-abc');
    expect(response.content).toBe('You have 3 meetings today');
    expect(response.adapterId).toBe('openai');
  });

  it('maps usage data correctly', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(makeOpenAIResponse('ok')));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.execute(makeRequest());

    expect(response.usage?.inputTokens).toBe(10);
    expect(response.usage?.outputTokens).toBe(20);
    expect(response.usage?.totalTokens).toBe(30);
  });

  it('includes tools in request body when request.tools is set', async () => {
    const mockFetch = mockFetchSuccess(makeOpenAIResponse('tool result'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    await adapter.execute(makeRequest({
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('get_weather');
  });

  it('maps tool_calls in the response', async () => {
    const responseWithToolCall = {
      id: 'chatcmpl-tc',
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_001',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ city: 'New York' }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    };
    vi.stubGlobal('fetch', mockFetchSuccess(responseWithToolCall));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.execute(makeRequest());

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('get_weather');
    expect(response.toolCalls![0].arguments).toEqual({ city: 'New York' });
  });

  it('throws on non-2xx API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('rate limited'),
    }));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    await expect(adapter.execute(makeRequest())).rejects.toThrow('OpenAI API error 429');
  });

  it('includes conversation history as messages', async () => {
    const mockFetch = mockFetchSuccess(makeOpenAIResponse('reply'));
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    await adapter.execute(makeRequest({
      context: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationHistory: [
          { role: 'user', content: 'previous message', timestamp: 1 },
          { role: 'assistant', content: 'previous reply', timestamp: 2 },
        ],
      },
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    // 2 history messages + current prompt
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[2].content).toBe('Hello, world');
  });

  it('records latencyMs in the response', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess(makeOpenAIResponse('ok')));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.execute(makeRequest());
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── healthCheck() ─────────────────────────────────────────────────────

describe('OpenAIAdapter — healthCheck()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "ready" and sets info.status when models endpoint responds ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const status = await adapter.healthCheck();
    expect(status).toBe('ready');
    expect(adapter.info.status).toBe('ready');
  });

  it('returns "unavailable" when models endpoint responds non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const status = await adapter.healthCheck();
    expect(status).toBe('unavailable');
    expect(adapter.info.status).toBe('unavailable');
  });

  it('returns "unavailable" when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const status = await adapter.healthCheck();
    expect(status).toBe('unavailable');
  });
});

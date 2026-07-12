/**
 * multi-model.test.ts
 *
 * Mocked-fetch tests locking the four provider request shapes and
 * response parsers. Without these, a future "tighten the dispatcher"
 * PR could silently break a provider whose smoke path nobody re-runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  process.env.CLAUDE_API_KEY_DIRECT = 'sk-ant-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.GROK_API_KEY = 'xai-test';
  process.env.GEMINI_API_KEY = 'aiza-test';
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('providerFor', () => {
  it('routes by prefix', async () => {
    const { providerFor } = await import('./multi-model.js');
    expect(providerFor('claude-sonnet-4-6')).toBe('anthropic');
    expect(providerFor('gpt-4o-mini')).toBe('openai');
    expect(providerFor('o1-mini')).toBe('openai');
    expect(providerFor('codex-mini')).toBe('openai');
    expect(providerFor('grok-3-mini')).toBe('xai');
    expect(providerFor('gemini-2.5-flash')).toBe('google');
  });

  it('throws on unknown prefix', async () => {
    const { providerFor } = await import('./multi-model.js');
    expect(() => providerFor('mystery-model-1')).toThrow(/no provider mapping/);
  });
});

describe('dispatch: Anthropic', () => {
  it('builds the messages request and parses content + usage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 17, output_tokens: 1 },
    }));
    const { dispatch } = await import('./multi-model.js');
    const r = await dispatch('claude-haiku-4-5-20251001', 'ping', { maxTokens: 16 });
    expect(r.provider).toBe('anthropic');
    expect(r.text).toBe('OK');
    expect(r.tokensIn).toBe(17);
    expect(r.tokensOut).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });
});

describe('dispatch: OpenAI', () => {
  it('builds chat.completions and parses choices + usage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: 'OK' } }],
      usage: { prompt_tokens: 17, completion_tokens: 1 },
    }));
    const { dispatch } = await import('./multi-model.js');
    const r = await dispatch('gpt-4o-mini', 'ping');
    expect(r.provider).toBe('openai');
    expect(r.text).toBe('OK');
    expect(r.tokensIn).toBe(17);
    expect(r.tokensOut).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer sk-openai-test');
  });
});

describe('dispatch: xAI Grok', () => {
  it('uses the xAI endpoint and Grok key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: 'OK' } }],
      usage: { prompt_tokens: 17, completion_tokens: 1 },
    }));
    const { dispatch } = await import('./multi-model.js');
    const r = await dispatch('grok-3-mini', 'ping');
    expect(r.provider).toBe('xai');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer xai-test');
  });
});

describe('dispatch: Gemini', () => {
  it('builds contents request and parses candidates', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    }));
    const { dispatch } = await import('./multi-model.js');
    const r = await dispatch('gemini-2.5-flash', 'ping', { system: 'be terse' });
    expect(r.provider).toBe('google');
    expect(r.text).toBe('OK');
    expect(r.tokensIn).toBe(5);
    expect(r.tokensOut).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/generativelanguage\.googleapis\.com.*models\/gemini-2.5-flash:generateContent/);
    expect(url).toContain('key=aiza-test');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'ping' }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
  });
});

describe('dispatch: error surfacing', () => {
  it('throws on non-2xx with body excerpt', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate limit' }, 429));
    const { dispatch } = await import('./multi-model.js');
    await expect(dispatch('gpt-4o-mini', 'ping')).rejects.toThrow(/429/);
  });

  it('throws if provider key is unset', async () => {
    delete process.env.OPENAI_API_KEY;
    const { dispatch } = await import('./multi-model.js');
    await expect(dispatch('gpt-4o-mini', 'ping')).rejects.toThrow(/OPENAI_API_KEY not set/);
  });
});

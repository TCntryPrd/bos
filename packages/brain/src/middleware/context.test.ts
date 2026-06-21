/**
 * Unit tests — createContextMiddleware
 */

import { describe, it, expect, vi } from 'vitest';
import { createContextMiddleware } from './context.js';
import type { ContextProvider } from './context.js';
import type { BrainRequest } from '../types.js';

function makeRequest(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    id: 'req-1',
    type: 'chat',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'test',
    ...overrides,
  };
}

const stubCtx = { adapterId: 'a1', startTime: Date.now(), attempt: 0 };

function makeProvider(overrides: Partial<ContextProvider> = {}): ContextProvider {
  return {
    getUserProfile: vi.fn(async () => ({ name: 'Alice', timezone: 'UTC' })),
    getRelevantMemories: vi.fn(async () => ['memory A', 'memory B']),
    ...overrides,
  };
}

describe('createContextMiddleware', () => {
  it('creates a pre-middleware named "context-injection"', () => {
    const mw = createContextMiddleware(makeProvider());
    expect(mw.name).toBe('context-injection');
    expect(mw.phase).toBe('pre');
  });

  it('injects userProfile into request context', async () => {
    const provider = makeProvider({
      getUserProfile: vi.fn(async () => ({ role: 'admin' })),
      getRelevantMemories: vi.fn(async () => []),
    });
    const mw = createContextMiddleware(provider);
    const req = makeRequest({
      context: { tenantId: 'tenant-1', userId: 'user-1' },
    });

    const result = await mw.execute(req, stubCtx) as BrainRequest;
    expect(result.context?.userProfile).toEqual({ role: 'admin' });
  });

  it('injects memories into request context', async () => {
    const provider = makeProvider({
      getUserProfile: vi.fn(async () => undefined),
      getRelevantMemories: vi.fn(async () => ['mem1', 'mem2']),
    });
    const mw = createContextMiddleware(provider);
    const req = makeRequest({
      context: { tenantId: 'tenant-1', userId: 'user-1' },
    });

    const result = await mw.execute(req, stubCtx) as BrainRequest;
    expect(result.context?.memories).toEqual(['mem1', 'mem2']);
  });

  it('preserves existing context fields while injecting new ones', async () => {
    const provider = makeProvider({
      getUserProfile: vi.fn(async () => ({ injected: true })),
      getRelevantMemories: vi.fn(async () => ['m1']),
    });
    const mw = createContextMiddleware(provider);
    const req = makeRequest({
      context: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        conversationHistory: [{ role: 'user', content: 'hi', timestamp: 1 }],
      },
    });

    const result = await mw.execute(req, stubCtx) as BrainRequest;
    expect(result.context?.conversationHistory).toHaveLength(1);
    expect(result.context?.userProfile).toEqual({ injected: true });
  });

  it('does not overwrite existing memories when provider returns empty array', async () => {
    const provider = makeProvider({
      getUserProfile: vi.fn(async () => undefined),
      getRelevantMemories: vi.fn(async () => []),
    });
    const mw = createContextMiddleware(provider);
    const req = makeRequest({
      context: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        memories: ['existing memory'],
      },
    });

    const result = await mw.execute(req, stubCtx) as BrainRequest;
    expect(result.context?.memories).toEqual(['existing memory']);
  });

  it('passes through request unchanged when context has no tenantId/userId', async () => {
    const provider = makeProvider();
    const mw = createContextMiddleware(provider);
    const req = makeRequest({ context: undefined });

    const result = await mw.execute(req, stubCtx);
    expect(result).toBe(req);
    expect(provider.getUserProfile).not.toHaveBeenCalled();
  });

  it('silently handles getUserProfile rejection', async () => {
    const provider = makeProvider({
      getUserProfile: vi.fn(async () => { throw new Error('DB error'); }),
      getRelevantMemories: vi.fn(async () => ['mem1']),
    });
    const mw = createContextMiddleware(provider);
    const req = makeRequest({ context: { tenantId: 't1', userId: 'u1' } });

    const result = await mw.execute(req, stubCtx) as BrainRequest;
    // Should not throw — falls back gracefully
    expect(result.context?.memories).toEqual(['mem1']);
  });

  it('silently handles getRelevantMemories rejection', async () => {
    const provider = makeProvider({
      getUserProfile: vi.fn(async () => ({ name: 'Alice' })),
      getRelevantMemories: vi.fn(async () => { throw new Error('Vector DB down'); }),
    });
    const mw = createContextMiddleware(provider);
    const req = makeRequest({ context: { tenantId: 't1', userId: 'u1' } });

    const result = await mw.execute(req, stubCtx) as BrainRequest;
    // Should not throw — userProfile still injected
    expect(result.context?.userProfile).toEqual({ name: 'Alice' });
  });
});

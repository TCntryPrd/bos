/**
 * Unit tests — BrainRouter
 *
 * Tests cover:
 * - Adapter registration and listing
 * - Capability-based candidate selection
 * - preferredAdapter routing
 * - Pre/post middleware chain execution and ordering
 * - Fallback to second adapter when first throws
 * - errorResponse when no adapters match
 * - Adapter status degradation on failure
 * - stream() path: direct streaming + non-streaming fallback
 * - checkHealth() aggregation
 * - Timeout behaviour
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrainRouter } from './router.js';
import type {
  BrainAdapter,
  BrainAdapterInfo,
  BrainRequest,
  BrainResponse,
  BrainStreamChunk,
  BrainMiddleware,
  AdapterStatus,
} from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeCaps(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    canChat: true,
    canStream: true,
    canUseTools: true,
    canAccessMCP: false,
    canExecuteCode: false,
    canSpawnAgents: false,
    canMaintainMemory: false,
    canProcessVoice: false,
    canProcessImages: false,
    canProcessDocuments: false,
    ...overrides,
  };
}

function makeAdapter(
  id: string,
  capsOverrides: Partial<Record<string, boolean>> = {},
  opts: {
    priority?: number;
    status?: AdapterStatus;
    executeResult?: BrainResponse;
    executeShouldThrow?: boolean | string;
    healthResult?: AdapterStatus;
  } = {},
): BrainAdapter {
  const info: BrainAdapterInfo = {
    id,
    name: id,
    capabilities: makeCaps(capsOverrides),
    status: opts.status ?? 'ready',
    priority: opts.priority ?? 10,
  };

  const defaultResponse: BrainResponse = {
    id: `resp-${id}`,
    requestId: 'req-test',
    adapterId: id,
    content: `Response from ${id}`,
    latencyMs: 5,
  };

  return {
    info,
    execute: vi.fn(async (_req: BrainRequest) => {
      if (opts.executeShouldThrow) {
        throw new Error(
          typeof opts.executeShouldThrow === 'string'
            ? opts.executeShouldThrow
            : `${id} execute failed`,
        );
      }
      return opts.executeResult ?? defaultResponse;
    }),
    healthCheck: vi.fn(async () => opts.healthResult ?? ('ready' as AdapterStatus)),
  };
}

function makeRequest(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    id: 'req-test',
    type: 'chat',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'Hello',
    ...overrides,
  };
}

// ── Adapter Registration ──────────────────────────────────────────────

describe('BrainRouter — adapter registration', () => {
  it('registers an adapter and retrieves it by id', () => {
    const router = new BrainRouter();
    const adapter = makeAdapter('openai');
    router.registerAdapter(adapter);
    expect(router.getAdapter('openai')).toBe(adapter);
  });

  it('lists all registered adapters as AdapterInfo copies', () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('openai'));
    router.registerAdapter(makeAdapter('gemini'));
    const list = router.listAdapters();
    expect(list).toHaveLength(2);
    expect(list.map(a => a.id)).toEqual(expect.arrayContaining(['openai', 'gemini']));
  });

  it('returns undefined for an unregistered adapter id', () => {
    const router = new BrainRouter();
    expect(router.getAdapter('nonexistent')).toBeUndefined();
  });

  it('unregisters an adapter', () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('openai'));
    router.unregisterAdapter('openai');
    expect(router.getAdapter('openai')).toBeUndefined();
    expect(router.listAdapters()).toHaveLength(0);
  });

  it('overwrites an existing adapter registration with the same id', () => {
    const router = new BrainRouter();
    const a1 = makeAdapter('openai', {}, { executeResult: { id: 'v1', requestId: 'r', adapterId: 'openai', content: 'v1', latencyMs: 1 } });
    const a2 = makeAdapter('openai', {}, { executeResult: { id: 'v2', requestId: 'r', adapterId: 'openai', content: 'v2', latencyMs: 1 } });
    router.registerAdapter(a1);
    router.registerAdapter(a2);
    expect(router.getAdapter('openai')).toBe(a2);
    expect(router.listAdapters()).toHaveLength(1);
  });
});

// ── Capability Routing ────────────────────────────────────────────────

describe('BrainRouter — capability routing', () => {
  it('routes chat request to an adapter with canChat', async () => {
    const router = new BrainRouter();
    const adapter = makeAdapter('openai');
    router.registerAdapter(adapter);

    const response = await router.route(makeRequest({ type: 'chat' }));
    expect(response.adapterId).toBe('openai');
    expect(adapter.execute).toHaveBeenCalledOnce();
  });

  it('routes tool_call to an adapter with canUseTools', async () => {
    const router = new BrainRouter();
    const chatOnlyAdapter = makeAdapter('chat-only', { canUseTools: false }, { priority: 1 });
    const toolAdapter = makeAdapter('tool-adapter', { canUseTools: true }, { priority: 5 });
    router.registerAdapter(chatOnlyAdapter);
    router.registerAdapter(toolAdapter);

    const response = await router.route(makeRequest({ type: 'tool_call' }));
    expect(response.adapterId).toBe('tool-adapter');
  });

  it('routes code_execution to an adapter with canExecuteCode', async () => {
    const router = new BrainRouter();
    const noCode = makeAdapter('openai', { canExecuteCode: false }, { priority: 1 });
    const codeAdapter = makeAdapter('claude-code', { canExecuteCode: true }, { priority: 5 });
    router.registerAdapter(noCode);
    router.registerAdapter(codeAdapter);

    const response = await router.route(makeRequest({ type: 'code_execution' }));
    expect(response.adapterId).toBe('claude-code');
  });

  it('routes agent_spawn to an adapter with canSpawnAgents', async () => {
    const router = new BrainRouter();
    const basicAdapter = makeAdapter('basic', { canSpawnAgents: false }, { priority: 1 });
    const agentAdapter = makeAdapter('agent-capable', { canSpawnAgents: true }, { priority: 5 });
    router.registerAdapter(basicAdapter);
    router.registerAdapter(agentAdapter);

    const response = await router.route(makeRequest({ type: 'agent_spawn' }));
    expect(response.adapterId).toBe('agent-capable');
  });

  it('returns error response when no adapter has required capability', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('basic', { canExecuteCode: false }));

    const response = await router.route(makeRequest({ type: 'code_execution' }));
    expect(response.error).toBeDefined();
    expect(response.error).toMatch(/No adapter available/);
    expect(response.adapterId).toBe('router');
  });

  it('returns error response when router has no adapters registered', async () => {
    const router = new BrainRouter();
    const response = await router.route(makeRequest());
    expect(response.error).toBeDefined();
  });

  it('prefers lower-priority-number adapters', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('high-priority', {}, { priority: 1 }));
    router.registerAdapter(makeAdapter('low-priority', {}, { priority: 100 }));

    const response = await router.route(makeRequest());
    expect(response.adapterId).toBe('high-priority');
  });

  it('skips adapters with status=unavailable', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('unavailable', {}, { status: 'unavailable', priority: 1 }));
    router.registerAdapter(makeAdapter('available', {}, { status: 'ready', priority: 10 }));

    const response = await router.route(makeRequest());
    expect(response.adapterId).toBe('available');
  });

  it('prefers ready over degraded adapters', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('degraded', {}, { status: 'degraded', priority: 1 }));
    router.registerAdapter(makeAdapter('ready', {}, { status: 'ready', priority: 10 }));

    const response = await router.route(makeRequest());
    expect(response.adapterId).toBe('ready');
  });
});

// ── preferredAdapter ──────────────────────────────────────────────────

describe('BrainRouter — preferredAdapter routing', () => {
  it('routes to preferred adapter when it has required capabilities', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('first', {}, { priority: 1 }));
    router.registerAdapter(makeAdapter('preferred', {}, { priority: 99 }));

    const response = await router.route(
      makeRequest({ preferredAdapter: 'preferred' }),
    );
    expect(response.adapterId).toBe('preferred');
  });

  it('falls back to best candidate when preferred adapter has wrong capabilities', async () => {
    const router = new BrainRouter();
    const noCode = makeAdapter('no-code', { canExecuteCode: false }, { priority: 1 });
    const withCode = makeAdapter('with-code', { canExecuteCode: true }, { priority: 5 });
    router.registerAdapter(noCode);
    router.registerAdapter(withCode);

    const response = await router.route(
      makeRequest({ type: 'code_execution', preferredAdapter: 'no-code' }),
    );
    // no-code cannot execute code, so it won't be in candidates at all
    expect(response.adapterId).toBe('with-code');
  });

  it('falls back to best candidate when preferred adapter is not registered', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('fallback', {}, { priority: 1 }));

    const response = await router.route(
      makeRequest({ preferredAdapter: 'missing-adapter' }),
    );
    expect(response.adapterId).toBe('fallback');
  });
});

// ── Fallback Behaviour ────────────────────────────────────────────────

describe('BrainRouter — fallback behaviour', () => {
  it('falls back to second adapter when first throws', async () => {
    const router = new BrainRouter({ maxFallbackAttempts: 2 });
    const failing = makeAdapter('failing', {}, { executeShouldThrow: true, priority: 1 });
    const working = makeAdapter('working', {}, { priority: 10 });
    router.registerAdapter(failing);
    router.registerAdapter(working);

    const response = await router.route(makeRequest());
    expect(response.adapterId).toBe('working');
    expect(failing.execute).toHaveBeenCalled();
    expect(working.execute).toHaveBeenCalled();
  });

  it('marks failing adapter as degraded after it throws', async () => {
    const router = new BrainRouter({ maxFallbackAttempts: 2 });
    const failing = makeAdapter('failing', {}, { executeShouldThrow: true, priority: 1 });
    const working = makeAdapter('working', {}, { priority: 10 });
    router.registerAdapter(failing);
    router.registerAdapter(working);

    await router.route(makeRequest());
    expect(failing.info.status).toBe('degraded');
  });

  it('returns error response when all adapters fail', async () => {
    const router = new BrainRouter({ maxFallbackAttempts: 3 });
    router.registerAdapter(makeAdapter('a1', {}, { executeShouldThrow: 'Error A', priority: 1 }));
    router.registerAdapter(makeAdapter('a2', {}, { executeShouldThrow: 'Error B', priority: 2 }));

    const response = await router.route(makeRequest());
    expect(response.error).toBeDefined();
    expect(response.error).toMatch(/All adapters failed/);
  });

  it('respects maxFallbackAttempts limit', async () => {
    const router = new BrainRouter({ maxFallbackAttempts: 0 });
    const failing = makeAdapter('failing', {}, { executeShouldThrow: true, priority: 1 });
    const backup = makeAdapter('backup', {}, { priority: 5 });
    router.registerAdapter(failing);
    router.registerAdapter(backup);

    const response = await router.route(makeRequest());
    // maxFallbackAttempts=0 means only 1 attempt total (index 0)
    expect(backup.execute).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });
});

// ── Middleware Chain ──────────────────────────────────────────────────

describe('BrainRouter — middleware chain', () => {
  it('applies pre-middleware to the request before execution', async () => {
    const router = new BrainRouter();
    const adapter = makeAdapter('openai');
    router.registerAdapter(adapter);

    const preMw: BrainMiddleware = {
      name: 'tagger',
      phase: 'pre',
      execute: vi.fn(async (input) => {
        const req = input as BrainRequest;
        return { ...req, prompt: `[tagged] ${req.prompt}` };
      }),
    };
    router.use(preMw);

    await router.route(makeRequest({ prompt: 'hello' }));

    expect(preMw.execute).toHaveBeenCalledOnce();
    const callArg = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as BrainRequest;
    expect(callArg.prompt).toBe('[tagged] hello');
  });

  it('applies post-middleware to the response before returning', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('openai', {}, {
      executeResult: {
        id: 'r1', requestId: 'req-test', adapterId: 'openai',
        content: 'Original', latencyMs: 5,
      },
    }));

    const postMw: BrainMiddleware = {
      name: 'uppercaser',
      phase: 'post',
      execute: vi.fn(async (input) => {
        const resp = input as BrainResponse;
        return { ...resp, content: resp.content.toUpperCase() };
      }),
    };
    router.use(postMw);

    const response = await router.route(makeRequest());
    expect(postMw.execute).toHaveBeenCalledOnce();
    expect(response.content).toBe('ORIGINAL');
  });

  it('runs multiple pre-middleware in registration order', async () => {
    const router = new BrainRouter();
    const calls: string[] = [];
    router.registerAdapter(makeAdapter('adapter'));

    const mw1: BrainMiddleware = {
      name: 'mw1',
      phase: 'pre',
      execute: vi.fn(async (input) => { calls.push('mw1'); return input; }),
    };
    const mw2: BrainMiddleware = {
      name: 'mw2',
      phase: 'pre',
      execute: vi.fn(async (input) => { calls.push('mw2'); return input; }),
    };
    router.use(mw1);
    router.use(mw2);

    await router.route(makeRequest());
    expect(calls).toEqual(['mw1', 'mw2']);
  });

  it('runs multiple post-middleware in registration order', async () => {
    const router = new BrainRouter();
    const calls: string[] = [];
    router.registerAdapter(makeAdapter('adapter'));

    const pmw1: BrainMiddleware = {
      name: 'pmw1',
      phase: 'post',
      execute: vi.fn(async (input) => { calls.push('pmw1'); return input; }),
    };
    const pmw2: BrainMiddleware = {
      name: 'pmw2',
      phase: 'post',
      execute: vi.fn(async (input) => { calls.push('pmw2'); return input; }),
    };
    router.use(pmw1);
    router.use(pmw2);

    await router.route(makeRequest());
    expect(calls).toEqual(['pmw1', 'pmw2']);
  });

  it('passes MiddlewareContext with correct adapterId to middleware', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('test-adapter'));

    let capturedCtx: unknown = null;
    const mw: BrainMiddleware = {
      name: 'ctx-capture',
      phase: 'pre',
      execute: vi.fn(async (input, ctx) => {
        capturedCtx = ctx;
        return input;
      }),
    };
    router.use(mw);

    await router.route(makeRequest());
    expect(capturedCtx).toMatchObject({
      adapterId: 'test-adapter',
      attempt: 0,
    });
  });
});

// ── Streaming ─────────────────────────────────────────────────────────

describe('BrainRouter — stream()', () => {
  async function collectStream(
    iterable: AsyncIterable<BrainStreamChunk>,
  ): Promise<BrainStreamChunk[]> {
    const chunks: BrainStreamChunk[] = [];
    for await (const chunk of iterable) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('yields a single done chunk when no adapters are registered', async () => {
    const router = new BrainRouter();
    const chunks = await collectStream(router.stream(makeRequest()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].done).toBe(true);
    expect(chunks[0].adapterId).toBe('none');
  });

  it('delegates to adapter.stream() when adapter supports canStream', async () => {
    const router = new BrainRouter();

    async function* mockStream(req: BrainRequest): AsyncIterable<BrainStreamChunk> {
      yield { requestId: req.id, adapterId: 'streaming-adapter', delta: 'hello', done: false };
      yield { requestId: req.id, adapterId: 'streaming-adapter', delta: ' world', done: false };
      yield { requestId: req.id, adapterId: 'streaming-adapter', delta: '', done: true };
    }

    const adapter: BrainAdapter = {
      info: {
        id: 'streaming-adapter',
        name: 'Streaming Adapter',
        capabilities: makeCaps({ canStream: true }),
        status: 'ready',
        priority: 1,
      },
      execute: vi.fn(),
      stream: vi.fn(mockStream),
      healthCheck: vi.fn(async () => 'ready' as AdapterStatus),
    };
    router.registerAdapter(adapter);

    const chunks = await collectStream(router.stream(makeRequest()));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].delta).toBe('hello');
    expect(chunks[2].done).toBe(true);
    expect(adapter.stream).toHaveBeenCalled();
  });

  it('falls back to execute() and emits single chunk when adapter has no stream method', async () => {
    const router = new BrainRouter();
    const adapter = makeAdapter('no-stream', { canStream: false }, {
      executeResult: {
        id: 'r1', requestId: 'req-test', adapterId: 'no-stream',
        content: 'full response', latencyMs: 10,
      },
    });
    router.registerAdapter(adapter);

    const chunks = await collectStream(router.stream(makeRequest()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].delta).toBe('full response');
    expect(chunks[0].done).toBe(true);
    expect(adapter.execute).toHaveBeenCalled();
  });

  it('applies pre-middleware to request before streaming', async () => {
    const router = new BrainRouter();

    async function* mockStream(req: BrainRequest): AsyncIterable<BrainStreamChunk> {
      yield { requestId: req.id, adapterId: 'stream-mw', delta: req.prompt, done: true };
    }

    const streamAdapter: BrainAdapter = {
      info: {
        id: 'stream-mw',
        name: 'Stream MW',
        capabilities: makeCaps({ canStream: true }),
        status: 'ready',
        priority: 1,
      },
      execute: vi.fn(),
      stream: vi.fn(mockStream),
      healthCheck: vi.fn(async () => 'ready' as AdapterStatus),
    };
    router.registerAdapter(streamAdapter);

    const preMw: BrainMiddleware = {
      name: 'injector',
      phase: 'pre',
      execute: vi.fn(async (input) => ({
        ...(input as BrainRequest),
        prompt: 'injected prompt',
      })),
    };
    router.use(preMw);

    const chunks = await collectStream(router.stream(makeRequest({ prompt: 'original' })));
    expect(chunks[0].delta).toBe('injected prompt');
  });
});

// ── Health Check ──────────────────────────────────────────────────────

describe('BrainRouter — checkHealth()', () => {
  it('returns a status map for all registered adapters', async () => {
    const router = new BrainRouter();
    router.registerAdapter(makeAdapter('a1', {}, { healthResult: 'ready' }));
    router.registerAdapter(makeAdapter('a2', {}, { healthResult: 'degraded' }));

    const health = await router.checkHealth();
    expect(health.size).toBe(2);
    expect(health.get('a1')).toBe('ready');
    expect(health.get('a2')).toBe('degraded');
  });

  it('returns "unavailable" for adapters whose healthCheck() throws', async () => {
    const router = new BrainRouter();
    const brokenAdapter: BrainAdapter = {
      info: { id: 'broken', name: 'Broken', capabilities: makeCaps(), status: 'ready', priority: 1 },
      execute: vi.fn(),
      healthCheck: vi.fn(async () => { throw new Error('health check threw'); }),
    };
    router.registerAdapter(brokenAdapter);

    const health = await router.checkHealth();
    expect(health.get('broken')).toBe('unavailable');
  });

  it('returns an empty map when no adapters are registered', async () => {
    const router = new BrainRouter();
    const health = await router.checkHealth();
    expect(health.size).toBe(0);
  });
});

// ── Timeout ───────────────────────────────────────────────────────────

describe('BrainRouter — adapter timeout', () => {
  it('moves to fallback when primary adapter exceeds adapterTimeoutMs', async () => {
    const router = new BrainRouter({ adapterTimeoutMs: 50, maxFallbackAttempts: 2 });

    const slowAdapter = makeAdapter('slow', {}, { priority: 1 });
    // Override execute to stall
    (slowAdapter.execute as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );

    const fastAdapter = makeAdapter('fast', {}, { priority: 10 });
    router.registerAdapter(slowAdapter);
    router.registerAdapter(fastAdapter);

    const response = await router.route(makeRequest());
    expect(response.adapterId).toBe('fast');
  }, 3000);
});

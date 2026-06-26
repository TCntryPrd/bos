/**
 * Brain Router — capability-based request routing.
 * Selects the best adapter for each request and handles fallback.
 */

import type {
  BrainAdapter,
  BrainAdapterInfo,
  BrainMiddleware,
  BrainRequest,
  BrainResponse,
  BrainRouterConfig,
  BrainStreamChunk,
  BrainRequestType,
  BrainCapabilities,
  MiddlewareContext,
  AdapterStatus,
} from './types.js';

const DEFAULT_CONFIG: BrainRouterConfig = {
  maxFallbackAttempts: 2,
  adapterTimeoutMs: 30_000,
  preferStreaming: true,
};

/** Map request types to the capability that must be true. */
const CAPABILITY_REQUIREMENTS: Record<BrainRequestType, (keyof BrainCapabilities)[]> = {
  chat: ['canChat'],
  tool_call: ['canChat', 'canUseTools'],
  code_execution: ['canChat', 'canExecuteCode'],
  agent_spawn: ['canChat', 'canSpawnAgents'],
};

export class BrainRouter {
  private adapters = new Map<string, BrainAdapter>();
  private preMiddleware: BrainMiddleware[] = [];
  private postMiddleware: BrainMiddleware[] = [];
  private config: BrainRouterConfig;

  constructor(config: Partial<BrainRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Adapter Management ────────────────────────────────────

  registerAdapter(adapter: BrainAdapter): void {
    this.adapters.set(adapter.info.id, adapter);
  }

  unregisterAdapter(id: string): void {
    this.adapters.delete(id);
  }

  getAdapter(id: string): BrainAdapter | undefined {
    return this.adapters.get(id);
  }

  listAdapters(): BrainAdapterInfo[] {
    return Array.from(this.adapters.values()).map((a) => ({ ...a.info }));
  }

  // ── Middleware Management ──────────────────────────────────

  use(middleware: BrainMiddleware): void {
    if (middleware.phase === 'pre') {
      this.preMiddleware.push(middleware);
    } else {
      this.postMiddleware.push(middleware);
    }
  }

  // ── Routing ───────────────────────────────────────────────

  /**
   * Route a request to the best available adapter.
   * Applies pre-middleware, executes, applies post-middleware, handles fallback.
   */
  async route(request: BrainRequest): Promise<BrainResponse> {
    const candidates = this.selectCandidates(request);
    if (candidates.length === 0) {
      return this.errorResponse(request, 'No adapter available for this request type');
    }

    let lastError: string | undefined;

    for (let attempt = 0; attempt < Math.min(candidates.length, this.config.maxFallbackAttempts + 1); attempt++) {
      const adapter = candidates[attempt];
      const mwCtx: MiddlewareContext = {
        adapterId: adapter.info.id,
        startTime: Date.now(),
        attempt,
      };

      try {
        // Pre-middleware
        let processed: BrainRequest = request;
        for (const mw of this.preMiddleware) {
          processed = (await mw.execute(processed, mwCtx)) as BrainRequest;
        }

        // Execute with timeout
        const response = await this.executeWithTimeout(adapter, processed);

        // Post-middleware
        let finalResponse: BrainResponse = response;
        for (const mw of this.postMiddleware) {
          finalResponse = (await mw.execute(finalResponse, mwCtx)) as BrainResponse;
        }

        return finalResponse;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Mark adapter degraded and try next candidate
        adapter.info.status = 'degraded';
      }
    }

    return this.errorResponse(request, `All adapters failed. Last error: ${lastError}`);
  }

  /**
   * Stream a response from the best available adapter.
   * Falls back to non-streaming execute if adapter doesn't support streaming.
   */
  async *stream(request: BrainRequest): AsyncIterable<BrainStreamChunk> {
    const candidates = this.selectCandidates(request);
    if (candidates.length === 0) {
      yield {
        requestId: request.id,
        adapterId: 'none',
        delta: '',
        done: true,
      };
      return;
    }

    const adapter = candidates[0];

    // Apply pre-middleware
    const mwCtx: MiddlewareContext = {
      adapterId: adapter.info.id,
      startTime: Date.now(),
      attempt: 0,
    };
    let processed: BrainRequest = request;
    for (const mw of this.preMiddleware) {
      processed = (await mw.execute(processed, mwCtx)) as BrainRequest;
    }

    if (adapter.info.capabilities.canStream && adapter.stream) {
      yield* adapter.stream(processed);
    } else {
      // Fallback: execute and emit as single chunk
      const response = await adapter.execute(processed);
      yield {
        requestId: response.requestId,
        adapterId: response.adapterId,
        delta: response.content,
        done: true,
        toolCalls: response.toolCalls,
        usage: response.usage,
      };
    }
  }

  // ── Health ────────────────────────────────────────────────

  async checkHealth(): Promise<Map<string, AdapterStatus>> {
    const results = new Map<string, AdapterStatus>();
    const checks = Array.from(this.adapters.entries()).map(async ([id, adapter]) => {
      const status = await adapter.healthCheck().catch(() => 'unavailable' as AdapterStatus);
      results.set(id, status);
    });
    await Promise.all(checks);
    return results;
  }

  // ── Internal ──────────────────────────────────────────────

  private selectCandidates(request: BrainRequest): BrainAdapter[] {
    const required = CAPABILITY_REQUIREMENTS[request.type];

    // If user specified a preferred adapter and it's available, try it first
    const preferred = request.preferredAdapter
      ? this.adapters.get(request.preferredAdapter)
      : undefined;

    const candidates = Array.from(this.adapters.values())
      .filter((a) => {
        if (a.info.status === 'unavailable') return false;
        return required.every((cap) => a.info.capabilities[cap]);
      })
      .sort((a, b) => {
        // Prefer ready over degraded
        if (a.info.status !== b.info.status) {
          return a.info.status === 'ready' ? -1 : 1;
        }
        return a.info.priority - b.info.priority;
      });

    // Move preferred adapter to front if it's in the candidates
    if (preferred && candidates.includes(preferred)) {
      const idx = candidates.indexOf(preferred);
      candidates.splice(idx, 1);
      candidates.unshift(preferred);
    }

    return candidates;
  }

  private async executeWithTimeout(
    adapter: BrainAdapter,
    request: BrainRequest,
  ): Promise<BrainResponse> {
    return new Promise<BrainResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Adapter ${adapter.info.id} timed out after ${this.config.adapterTimeoutMs}ms`)),
        this.config.adapterTimeoutMs,
      );
      adapter
        .execute(request)
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private errorResponse(request: BrainRequest, error: string): BrainResponse {
    return {
      id: `err-${Date.now()}`,
      requestId: request.id,
      adapterId: 'router',
      content: '',
      latencyMs: 0,
      error,
    };
  }
}

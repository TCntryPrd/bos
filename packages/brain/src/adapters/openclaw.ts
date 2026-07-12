/**
 * OpenClaw adapter — local AI gateway at http://localhost:64837.
 *
 * The gateway speaks the OpenAI-compatible chat/completions API format.
 * Auth: Authorization: Bearer <gateway-token>
 *
 * healthCheck sends a trivial prompt to /v1/chat/completions rather than
 * hitting a /health path, which may not exist on all gateway versions.
 */

import type {
  BrainAdapter,
  BrainAdapterInfo,
  BrainRequest,
  BrainResponse,
  AdapterStatus,
} from '../types.js';
import { getTextContent } from '../types.js';

export interface OpenClawConfig {
  baseUrl?: string;
  /** Gateway bearer token. Defaults to the shared BOS gateway token. */
  gatewayToken?: string;
  /** Model to request from the gateway. Defaults to whatever the gateway proxies. */
  model?: string;
  maxTokens?: number;
  priority?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:64837';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Resolve the OpenClaw gateway token from (in order):
 *   1. explicit config.gatewayToken
 *   2. OPENCLAW_API_KEY env var
 * Returns '' if neither is set. Callers that actually make requests
 * throw at request time (lazy failure) so unused adapters don't block startup.
 */
function resolveGatewayToken(configToken?: string): string {
  return configToken ?? process.env.OPENCLAW_API_KEY ?? '';
}

export class OpenClawAdapter implements BrainAdapter {
  readonly info: BrainAdapterInfo;
  private baseUrl: string;
  private gatewayToken: string;
  private model: string | undefined;
  private maxTokens: number;

  constructor(config: OpenClawConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.gatewayToken = resolveGatewayToken(config.gatewayToken);
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.info = {
      id: 'openclaw',
      name: 'OpenClaw',
      capabilities: {
        canChat: true,
        canStream: false,
        canUseTools: true,
        canAccessMCP: false,
        canExecuteCode: true,
        canSpawnAgents: true,
        canMaintainMemory: true,
        canProcessVoice: false,
        canProcessImages: false,
        canProcessDocuments: false,
      },
      status: 'ready',
      priority: config.priority ?? 30,
    };
  }

  async execute(request: BrainRequest): Promise<BrainResponse> {
    if (!this.gatewayToken) {
      throw new Error('OpenClaw adapter: gatewayToken not configured. Set OPENCLAW_API_KEY env var or pass config.gatewayToken.');
    }
    const start = Date.now();
    const messages = this.buildMessages(request);
    const body: Record<string, unknown> = {
      messages,
      max_tokens: this.maxTokens,
    };

    if (this.model) {
      body.model = this.model;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    console.log(`[OpenClawAdapter] execute: POST ${this.baseUrl}/v1/chat/completions`);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.gatewayToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenClaw gateway error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OpenAICompatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';

    const toolCalls = choice?.message?.tool_calls?.map((tc) => ({
      name: tc.function.name,
      arguments:
        typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
    }));

    return {
      id: data.id ?? `oc-${Date.now()}`,
      requestId: request.id,
      adapterId: this.info.id,
      content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      latencyMs: Date.now() - start,
    };
  }

  async healthCheck(): Promise<AdapterStatus> {
    if (!this.gatewayToken) {
      console.log('[OpenClawAdapter] healthCheck: gatewayToken not configured — unavailable');
      this.info.status = 'unavailable';
      return 'unavailable';
    }
    try {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: 'respond with ok' }],
        max_tokens: 16,
      };

      if (this.model) {
        body.model = this.model;
      }

      console.log(`[OpenClawAdapter] healthCheck: probing ${this.baseUrl}/v1/chat/completions`);

      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gatewayToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        // 429 = gateway is up but throttling; count as degraded
        if (res.status === 429) {
          console.log('[OpenClawAdapter] healthCheck: rate-limited (429) — degraded');
          this.info.status = 'degraded';
          return 'degraded';
        }
        const errText = await res.text();
        console.log(`[OpenClawAdapter] healthCheck: failed ${res.status}: ${errText}`);
        this.info.status = 'unavailable';
        return 'unavailable';
      }

      console.log('[OpenClawAdapter] healthCheck: OK');
      this.info.status = 'ready';
      return 'ready';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[OpenClawAdapter] healthCheck: error — ${msg}`);
      this.info.status = 'unavailable';
      return 'unavailable';
    }
  }

  private buildMessages(request: BrainRequest): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.context?.conversationHistory) {
      for (const m of request.context.conversationHistory) {
        messages.push({ role: m.role, content: getTextContent(m.content) });
      }
    }
    messages.push({ role: 'user', content: request.prompt });
    return messages;
  }
}

// ── OpenAI-compatible response types (minimal) ────────────────

interface OpenAICompatResponse {
  id?: string;
  choices?: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        function: { name: string; arguments: string | Record<string, unknown> };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

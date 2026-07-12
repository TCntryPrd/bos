/**
 * Custom OpenAPI adapter — connects to any AI endpoint that follows a simple chat contract.
 * Users provide the base URL and optionally an OpenAPI spec for capability detection.
 */

import type {
  BrainAdapter,
  BrainAdapterInfo,
  BrainCapabilities,
  BrainRequest,
  BrainResponse,
  AdapterStatus,
} from '../types.js';
import { getTextContent } from '../types.js';

export interface CustomAdapterConfig {
  id?: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  /** Path to the chat/completions endpoint, appended to baseUrl. */
  chatPath?: string;
  /** Path to the health endpoint. */
  healthPath?: string;
  /** Explicitly declare what this endpoint can do. */
  capabilities?: Partial<BrainCapabilities>;
  priority?: number;
}

const DEFAULT_CAPABILITIES: BrainCapabilities = {
  canChat: true,
  canStream: false,
  canUseTools: false,
  canAccessMCP: false,
  canExecuteCode: false,
  canSpawnAgents: false,
  canMaintainMemory: false,
  canProcessVoice: false,
  canProcessImages: false,
  canProcessDocuments: false,
};

export class CustomAdapter implements BrainAdapter {
  readonly info: BrainAdapterInfo;
  private baseUrl: string;
  private apiKey?: string;
  private chatPath: string;
  private healthPath: string;

  constructor(config: CustomAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.chatPath = config.chatPath ?? '/v1/chat/completions';
    this.healthPath = config.healthPath ?? '/health';

    this.info = {
      id: config.id ?? `custom-${Date.now()}`,
      name: config.name ?? 'Custom Brain',
      capabilities: { ...DEFAULT_CAPABILITIES, ...config.capabilities },
      status: 'ready',
      priority: config.priority ?? 50,
    };
  }

  async execute(request: BrainRequest): Promise<BrainResponse> {
    const start = Date.now();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const messages: Array<{ role: string; content: string }> = [];
    if (request.context?.conversationHistory) {
      for (const m of request.context.conversationHistory) {
        messages.push({ role: m.role, content: getTextContent(m.content) });
      }
    }
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = { messages };
    if (request.tools?.length && this.info.capabilities.canUseTools) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${this.baseUrl}${this.chatPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Custom adapter error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as CustomResponse;

    // Support both OpenAI-style and simple {content} responses
    const content =
      data.choices?.[0]?.message?.content ??
      data.content ??
      data.response ??
      '';

    const toolCalls =
      data.choices?.[0]?.message?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      })) ?? undefined;

    return {
      id: data.id ?? `custom-${Date.now()}`,
      requestId: request.id,
      adapterId: this.info.id,
      content,
      toolCalls,
      latencyMs: Date.now() - start,
    };
  }

  async healthCheck(): Promise<AdapterStatus> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const res = await fetch(`${this.baseUrl}${this.healthPath}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      this.info.status = res.ok ? 'ready' : 'unavailable';
      return this.info.status;
    } catch {
      this.info.status = 'unavailable';
      return 'unavailable';
    }
  }
}

interface CustomResponse {
  id?: string;
  content?: string;
  response?: string;
  choices?: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        function: { name: string; arguments: string | Record<string, unknown> };
      }>;
    };
  }>;
}

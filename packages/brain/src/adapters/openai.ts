/**
 * OpenAI adapter — GPT / Codex via OpenAI API.
 */

import type {
  BrainAdapter,
  BrainAdapterInfo,
  BrainRequest,
  BrainResponse,
  BrainStreamChunk,
  AdapterStatus,
} from '../types.js';
import { getTextContent } from '../types.js';

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  priority?: number;
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TOKENS = 4096;

export class OpenAIAdapter implements BrainAdapter {
  readonly info: BrainAdapterInfo;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';

    this.info = {
      id: 'openai',
      name: 'OpenAI',
      capabilities: {
        canChat: true,
        canStream: true,
        canUseTools: true,
        canAccessMCP: false,
        canExecuteCode: false,
        canSpawnAgents: false,
        canMaintainMemory: false,
        canProcessVoice: false,
        canProcessImages: true,
        canProcessDocuments: false,
      },
      status: 'ready',
      priority: config.priority ?? 10,
    };
  }

  async execute(request: BrainRequest): Promise<BrainResponse> {
    const start = Date.now();
    const messages = this.buildMessages(request);
    const model = this.resolveModel(request);
    const body: Record<string, unknown> = {
      model,
      max_tokens: this.maxTokens,
      messages,
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices[0];

    return {
      id: data.id,
      requestId: request.id,
      adapterId: this.info.id,
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
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

  async *stream(request: BrainRequest): AsyncIterable<BrainStreamChunk> {
    const messages = this.buildMessages(request);
    const model = this.resolveModel(request);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: this.maxTokens,
        messages,
        stream: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok || !res.body) {
      throw new Error(`OpenAI streaming error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') {
            yield { requestId: request.id, adapterId: this.info.id, delta: '', done: true };
            return;
          }
          try {
            const event = JSON.parse(payload) as { choices: Array<{ delta: { content?: string } }> };
            const delta = event.choices[0]?.delta?.content;
            if (delta) {
              yield { requestId: request.id, adapterId: this.info.id, delta, done: false };
            }
          } catch {
            // skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<AdapterStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      this.info.status = res.ok ? 'ready' : 'unavailable';
      return this.info.status;
    } catch {
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

  private resolveModel(request: BrainRequest): string {
    return request.model || this.model;
  }
}

// ── OpenAI response types (minimal) ──────────────────────────

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

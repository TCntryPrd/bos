/**
 * Claude Code adapter — primary brain with full capabilities.
 *
 * Supports two auth modes detected from the credential prefix:
 *   sk-ant-oat01-*  →  Bearer token (OAuth / subscription / setup-token)
 *   anything else   →  x-api-key (standard API key)
 *
 * Bearer-token mode requires specific Anthropic beta headers and a system
 * message prefix to mimic the Claude CLI. The context-1m beta MUST NOT be
 * included — Anthropic rejects OAuth tokens that request it.
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

export interface ClaudeCodeConfig {
  /** 'cli' uses `claude` subprocess, 'api' uses Anthropic HTTP API directly. */
  mode: 'cli' | 'api';
  /** API key (sk-ant-api…) or subscription/setup token (sk-ant-oat01-…). */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  priority?: number;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** True when the credential is a subscription / setup token that needs Bearer auth. */
function isBearerToken(key: string): boolean {
  return key.startsWith('sk-ant-oat01-');
}

/**
 * Build the HTTP headers for an Anthropic Messages API call.
 * Bearer tokens (OAuth) require a different auth header and additional beta flags.
 */
function buildHeaders(apiKey: string): Record<string, string> {
  const bearer = isBearerToken(apiKey);

  if (bearer) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'user-agent': 'claude-cli/2.1.85 (external, cli)',
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };
}

export class ClaudeCodeAdapter implements BrainAdapter {
  readonly info: BrainAdapterInfo;
  private config: Required<Omit<ClaudeCodeConfig, 'apiKey'>> & { apiKey?: string };

  constructor(config: ClaudeCodeConfig) {
    this.config = {
      mode: config.mode,
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      priority: config.priority ?? 0,
    };

    this.info = {
      id: 'claude-code',
      name: 'Claude Code',
      capabilities: {
        canChat: true,
        canStream: true,
        canUseTools: true,
        canAccessMCP: true,
        canExecuteCode: true,
        canSpawnAgents: true,
        canMaintainMemory: true,
        canProcessVoice: false,
        canProcessImages: true,
        canProcessDocuments: true,
      },
      status: 'ready',
      priority: this.config.priority,
    };
  }

  async execute(request: BrainRequest): Promise<BrainResponse> {
    const start = Date.now();

    if (this.config.mode === 'cli') {
      return this.executeCli(request, start);
    }
    return this.executeApi(request, start);
  }

  async *stream(request: BrainRequest): AsyncIterable<BrainStreamChunk> {
    if (this.config.mode === 'api' && this.config.apiKey) {
      yield* this.streamApi(request);
    } else {
      // CLI mode or no API key: execute fully then emit as a single chunk
      const response = await this.execute(request);
      yield {
        requestId: response.requestId,
        adapterId: this.info.id,
        delta: response.content,
        done: true,
        toolCalls: response.toolCalls,
        usage: response.usage,
      };
    }
  }

  async healthCheck(): Promise<AdapterStatus> {
    try {
      if (this.config.mode === 'cli') {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);
        await exec('claude', ['--version'], { timeout: 5000 });
        this.info.status = 'ready';
        return 'ready';
      }

      if (!this.config.apiKey) {
        console.log('[ClaudeCodeAdapter] healthCheck: no API key configured');
        this.info.status = 'unavailable';
        return 'unavailable';
      }

      const apiKey = this.config.apiKey;
      const bearer = isBearerToken(apiKey);
      const headers = buildHeaders(apiKey);
      // Bearer (OAuth/subscription) tokens may not have access to newer model IDs.
      // Use claude-3-haiku for health checks — cheap, fast, and reliably available.
      const healthModel = bearer ? 'claude-haiku-4-5' : this.config.model;
      const body: Record<string, unknown> = {
        model: healthModel,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'respond with ok' }],
      };

      // Bearer (OAuth) tokens require the CLI system prefix
      if (bearer) {
        body.system = [
          { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
        ];
      }

      console.log(
        `[ClaudeCodeAdapter] healthCheck: sending probe (auth=${bearer ? 'bearer' : 'api-key'}, model=${healthModel})`,
      );

      const res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        // 429 = rate-limited but the key is valid; treat as degraded, not dead
        if (res.status === 429) {
          console.log('[ClaudeCodeAdapter] healthCheck: rate-limited (429) — marking degraded');
          this.info.status = 'degraded';
          return 'degraded';
        }
        const errText = await res.text();
        console.log(`[ClaudeCodeAdapter] healthCheck: failed ${res.status}: ${errText}`);
        this.info.status = 'unavailable';
        return 'unavailable';
      }

      console.log('[ClaudeCodeAdapter] healthCheck: OK');
      this.info.status = 'ready';
      return 'ready';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ClaudeCodeAdapter] healthCheck: error — ${msg}`);
      this.info.status = 'unavailable';
      return 'unavailable';
    }
  }

  // ── CLI mode ──────────────────────────────────────────────

  private async executeCli(request: BrainRequest, start: number): Promise<BrainResponse> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const args = ['--print', request.prompt];
    if (request.context?.conversationHistory?.length) {
      const history = request.context.conversationHistory
        .map((m) => `${m.role}: ${getTextContent(m.content)}`)
        .join('\n');
      args.unshift('--system', history);
    }

    const { stdout } = await exec('claude', args, { timeout: 60_000 });

    return {
      id: `cc-${Date.now()}`,
      requestId: request.id,
      adapterId: this.info.id,
      content: stdout.trim(),
      latencyMs: Date.now() - start,
    };
  }

  // ── API mode ──────────────────────────────────────────────

  /**
   * Resolve the model to use for a request.
   * Priority: request.model > BRAIN_MODEL env > config.model > bearer default
   */
  private resolveModel(request: BrainRequest, bearer: boolean): string {
    if (request.model) return request.model;
    if (process.env.BRAIN_MODEL) return process.env.BRAIN_MODEL;
    if (bearer) return 'claude-haiku-4-5';
    return this.config.model;
  }

  private async executeApi(request: BrainRequest, start: number): Promise<BrainResponse> {
    if (!this.config.apiKey) {
      throw new Error('Claude Code API mode requires an API key or subscription token');
    }

    const apiKey = this.config.apiKey;
    const bearer = isBearerToken(apiKey);
    const messages = this.buildMessages(request);

    const model = this.resolveModel(request, bearer);
    const maxTokens = bearer ? Math.min(this.config.maxTokens, 8192) : this.config.maxTokens;

    // Build tools first — system prompt format depends on whether tools are present
    const tools = request.tools?.length
      ? request.tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          input_schema: t.parameters as Record<string, unknown>,
        }))
      : undefined;

    // Build system prompt — for bearer tokens with tools, the system prompt
    // MUST be exactly the identity string. Any additional text causes 400.
    // The BOS context goes into the conversation as a user message instead.
    const IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
    let systemPrompt: string | undefined;
    let bossContextMessage: string | undefined;
    if (bearer) {
      const bossSystemMsg = request.context?.conversationHistory?.find(m => m.role === 'system');
      if (tools && tools.length > 0) {
        systemPrompt = IDENTITY;
        if (bossSystemMsg) bossContextMessage = getTextContent(bossSystemMsg.content);
      } else {
        systemPrompt = bossSystemMsg
          ? `${IDENTITY}\n\n${getTextContent(bossSystemMsg.content)}`
          : IDENTITY;
      }
    }

    console.log(
      `[ClaudeCodeAdapter] execute: model=${model} auth=${bearer ? 'bearer' : 'api-key'} tools=${tools?.length ?? 0}`,
    );

    // Use SDK for bearer tokens — the SDK handles auth headers and request encoding
    // that raw fetch misses. This is required for sonnet/opus to work.
    if (bearer) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({
        apiKey: null as unknown as string,
        authToken: apiKey,
        dangerouslyAllowBrowser: true,
        defaultHeaders: {
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'user-agent': 'claude-cli/2.1.85 (external, cli)',
          'x-app': 'cli',
        },
      });

      // If we have BOS context that couldn't go in system prompt,
      // prepend it as a user message + assistant ack
      const sdkMessages = bossContextMessage
        ? [
            { role: 'user' as const, content: `[System Context]\n${bossContextMessage}` },
            { role: 'assistant' as const, content: 'Understood. I am BOS, ready to assist.' },
            ...messages,
          ]
        : messages;

      const params: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: sdkMessages,
      };
      if (tools) params.tools = tools;

      const stream = client.messages.stream(params as Parameters<typeof client.messages.stream>[0]);
      const data = await stream.finalMessage() as unknown as AnthropicResponse;

      const content = data.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      const textBlocks = content.filter((b) => b.type === 'text');
      const toolBlocks = content.filter((b) => b.type === 'tool_use');

      return {
        id: data.id,
        requestId: request.id,
        adapterId: this.info.id,
        content: textBlocks.map((b) => b.text ?? '').join(''),
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
        toolCalls: toolBlocks.length > 0
          ? toolBlocks.map((b) => ({
              id: b.id ?? '',
              name: b.name ?? '',
              arguments: (b.input ?? {}) as Record<string, unknown>,
            }))
          : undefined,
        latencyMs: Date.now() - start,
      };
    }

    // Non-bearer: use raw fetch with x-api-key header
    const headers = buildHeaders(apiKey);
    const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages };
    if (tools) body.tools = tools;

    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as AnthropicResponse;

    const textBlocks = data.content.filter((b) => b.type === 'text');
    const toolBlocks = data.content.filter((b) => b.type === 'tool_use');

    return {
      id: data.id,
      requestId: request.id,
      adapterId: this.info.id,
      content: textBlocks.map((b) => b.text ?? '').join('\n'),
      toolCalls: toolBlocks.length
        ? toolBlocks.map((b) => ({
            name: b.name!,
            arguments: b.input as Record<string, unknown>,
          }))
        : undefined,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
      latencyMs: Date.now() - start,
    };
  }

  private async *streamApi(request: BrainRequest): AsyncIterable<BrainStreamChunk> {
    if (!this.config.apiKey) throw new Error('API key required for streaming');

    const apiKey = this.config.apiKey;
    const bearer = isBearerToken(apiKey);
    const headers = buildHeaders(apiKey);
    const messages = this.buildMessages(request);

    const model = this.resolveModel(request, bearer);
    const maxTokens = bearer ? Math.min(this.config.maxTokens, 8192) : this.config.maxTokens;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };

    if (bearer) {
      const bossSystemMsg = request.context?.conversationHistory?.find(m => m.role === 'system');
      const identity = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
      body.system = bossSystemMsg
        ? `${identity}\n\n${getTextContent(bossSystemMsg.content)}`
        : identity;
    }

    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Anthropic streaming error ${res.status}`);
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
            const event = JSON.parse(payload) as StreamEvent;
            if (event.type === 'content_block_delta' && event.delta?.text) {
              yield {
                requestId: request.id,
                adapterId: this.info.id,
                delta: event.delta.text,
                done: false,
              };
            }
            if (event.type === 'message_stop') {
              yield { requestId: request.id, adapterId: this.info.id, delta: '', done: true };
              return;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildMessages(request: BrainRequest): Array<{ role: string; content: string | unknown[] }> {
    const messages: Array<{ role: string; content: string | unknown[] }> = [];
    if (request.context?.conversationHistory) {
      for (const m of request.context.conversationHistory) {
        // system messages go in the top-level system field, not the messages array
        if (m.role !== 'system') {
          // Pass content arrays (multi-modal) through directly to Anthropic
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    // If the last message in history is already a user message (e.g. with
    // multi-content blocks for vision), skip appending prompt to avoid duplication.
    const lastHistoryMsg = request.context?.conversationHistory?.at(-1);
    if (!(lastHistoryMsg?.role === 'user' && Array.isArray(lastHistoryMsg.content))) {
      messages.push({ role: 'user', content: request.prompt });
    }
    return messages;
  }
}

// ── Anthropic response types (minimal) ────────────────────────

interface AnthropicResponse {
  id: string;
  content: Array<{
    type: 'text' | 'tool_use';
    text?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: { input_tokens: number; output_tokens: number };
}

interface StreamEvent {
  type: string;
  delta?: { text?: string };
}

/**
 * Gemini adapter — Google Gemini via Generative Language API.
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

export interface GeminiConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  priority?: number;
}

const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_MAX_TOKENS = 4096;
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini's function-calling schema is a strict OpenAPI subset and returns a 400
// ("Unknown name ...") on JSON Schema meta fields it doesn't recognise. Strip
// them recursively so tools that carry e.g. `additionalProperties` (airtable,
// n8n) don't break the Gemini brain — which is the DEFAULT brain for installs.
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties', '$schema', '$ref', '$defs', 'definitions',
  'patternProperties', 'examples',
]);
function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = sanitizeGeminiSchema(v);
    }
    return out;
  }
  return schema;
}

export class GeminiAdapter implements BrainAdapter {
  readonly info: BrainAdapterInfo;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: GeminiConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.info = {
      id: 'gemini',
      name: 'Gemini',
      capabilities: {
        canChat: true,
        canStream: true,
        canUseTools: true,
        canAccessMCP: false,
        canExecuteCode: true,
        canSpawnAgents: false,
        canMaintainMemory: false,
        canProcessVoice: false,
        canProcessImages: true,
        canProcessDocuments: true,
      },
      status: 'ready',
      priority: config.priority ?? 20,
    };
  }

  async execute(request: BrainRequest): Promise<BrainResponse> {
    const start = Date.now();
    const contents = this.buildContents(request);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: this.maxTokens },
    };

    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeGeminiSchema(t.parameters),
          })),
        },
      ];
    }

    // Model fallback chain — free-tier Gemma endpoints intermittently 5xx;
    // fall through siblings before surfacing an error to the user.
    const chain = [...new Set([this.model, 'gemma-4-31b-it', 'gemini-2.5-flash'])];
    let res: Response | null = null;
    let lastErr = '';
    for (const model of chain) {
      const url = `${BASE_URL}/${model}:generateContent?key=${this.apiKey}`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) break;
      lastErr = `Gemini API error ${res.status} (${model}): ${await res.text()}`;
      if (res.status < 500 && res.status !== 429) break; // only chase server-side flakes
    }
    if (!res || !res.ok) {
      throw new Error(lastErr || 'Gemini API error: no response');
    }

    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const textParts = parts.filter((p) => p.text && !(p as { thought?: boolean }).thought);
    const functionParts = parts.filter((p) => p.functionCall);

    return {
      id: `gemini-${Date.now()}`,
      requestId: request.id,
      adapterId: this.info.id,
      content: textParts.map((p) => p.text).join('\n'),
      toolCalls: functionParts.map((p) => ({
        name: p.functionCall!.name,
        arguments: p.functionCall!.args as Record<string, unknown>,
      })),
      usage: data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          }
        : undefined,
      latencyMs: Date.now() - start,
    };
  }

  async *stream(request: BrainRequest): AsyncIterable<BrainStreamChunk> {
    const contents = this.buildContents(request);
    const url = `${BASE_URL}/${this.model}:streamGenerateContent?key=${this.apiKey}&alt=sse`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: this.maxTokens },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Gemini streaming error ${res.status}`);
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
          try {
            const event = JSON.parse(line.slice(6)) as GeminiResponse;
            const text = event.candidates?.[0]?.content?.parts?.find((p) => p.text && !(p as { thought?: boolean }).thought)?.text;
            if (text) {
              yield { requestId: request.id, adapterId: this.info.id, delta: text, done: false };
            }
          } catch {
            // skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { requestId: request.id, adapterId: this.info.id, delta: '', done: true };
  }

  async healthCheck(): Promise<AdapterStatus> {
    try {
      const url = `${BASE_URL}?key=${this.apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      this.info.status = res.ok ? 'ready' : 'unavailable';
      return this.info.status;
    } catch {
      this.info.status = 'unavailable';
      return 'unavailable';
    }
  }

  private buildContents(request: BrainRequest): Array<{ role: string; parts: Array<{ text: string }> }> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    const systemTexts: string[] = [];
    if (request.context?.conversationHistory) {
      for (const m of request.context.conversationHistory) {
        if (m.role === 'system') {
          systemTexts.push(getTextContent(m.content));
          continue;
        }
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: getTextContent(m.content) }],
        });
      }
    }
    // Gemma models reject the systemInstruction field, so deliver the system
    // prompt as a leading user/model turn — works on every Gemini-API model.
    // (Previously system messages were silently dropped: the agent lost its
    // identity, skills, and memory context on this adapter.)
    if (systemTexts.length > 0) {
      contents.unshift(
        {
          role: 'user',
          parts: [{ text: `SYSTEM INSTRUCTIONS (follow for this entire conversation):\n\n${systemTexts.join('\n\n')}` }],
        },
        { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
      );
    }
    contents.push({ role: 'user', parts: [{ text: request.prompt }] });
    return contents;
  }
}

// ── Gemini response types (minimal) ──────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args: unknown };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

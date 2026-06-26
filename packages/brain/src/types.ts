/**
 * Brain Router types — capability-based AI routing for BOS.
 * See design doc Section 3.1.
 *
 * Core types (BrainCapabilities, BrainProvider, BrainConfig) are re-exported
 * from @boss/core to keep a single source of truth.
 */

// Re-export core brain types — single source of truth
export {
  type BrainCapabilities,
  type BrainProvider,
  type BrainConfig,
  type BrainTool,
  type BrainToolCall,
} from '@boss/core';

// ── Request / Response (brain-package-specific) ──────────────

export type BrainRequestType = 'chat' | 'tool_call' | 'code_execution' | 'agent_spawn';

export interface BrainContext {
  tenantId: string;
  userId: string;
  userProfile?: Record<string, unknown>;
  conversationHistory?: ConversationMessage[];
  /** Injected by context middleware */
  memories?: string[];
}

export interface BrainRequest {
  id: string;
  type: BrainRequestType;
  tenantId: string;
  userId: string;
  prompt: string;
  context?: BrainContext;
  tools?: import('@boss/core').BrainTool[];
  stream?: boolean;
  /** If set, route to this specific adapter instead of auto-routing. */
  preferredAdapter?: string;
  /** Override the model used by the adapter for this request. */
  model?: string;
}

// ── Content block types for multi-modal messages ─────────────

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  timestamp: number;
}

/** Extract plain text from a ConversationMessage content field. */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface BrainResponse {
  id: string;
  requestId: string;
  adapterId: string;
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  latencyMs: number;
  error?: string;
}

// ── Streaming ─────────────────────────────────────────────────

export interface BrainStreamChunk {
  requestId: string;
  adapterId: string;
  delta: string;
  done: boolean;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

// ── Adapter Registration ──────────────────────────────────────

export type AdapterStatus = 'ready' | 'degraded' | 'unavailable';

export interface BrainAdapterInfo {
  id: string;
  name: string;
  capabilities: import('@boss/core').BrainCapabilities;
  status: AdapterStatus;
  priority: number; // lower = preferred
}

export interface BrainAdapter {
  readonly info: BrainAdapterInfo;

  /** Send a request and get a full response. */
  execute(request: BrainRequest): Promise<BrainResponse>;

  /** Stream a response chunk by chunk. Adapter must support canStream. */
  stream?(request: BrainRequest): AsyncIterable<BrainStreamChunk>;

  /** Health check — updates info.status. */
  healthCheck(): Promise<AdapterStatus>;
}

// ── Middleware ─────────────────────────────────────────────────

export type MiddlewarePhase = 'pre' | 'post';

export interface BrainMiddleware {
  name: string;
  phase: MiddlewarePhase;
  /** Pre-middleware transforms the request; post-middleware transforms the response. */
  execute(
    input: BrainRequest | BrainResponse,
    context: MiddlewareContext,
  ): Promise<BrainRequest | BrainResponse>;
}

export interface MiddlewareContext {
  adapterId: string;
  startTime: number;
  attempt: number;
}

// ── Router Config ─────────────────────────────────────────────

export interface BrainRouterConfig {
  /** Max retry attempts on fallback adapters before giving up. */
  maxFallbackAttempts: number;
  /** Timeout per adapter call in ms. */
  adapterTimeoutMs: number;
  /** If true, stream responses when adapter supports it. */
  preferStreaming: boolean;
}

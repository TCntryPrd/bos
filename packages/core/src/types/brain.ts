/**
 * Brain capability and routing types.
 * The Brain Router uses these to determine what each brain can do
 * and how to route requests.
 */

export interface BrainCapabilities {
  // Core
  canChat: boolean;
  canStream: boolean;
  canUseTools: boolean;

  // Advanced
  canAccessMCP: boolean;
  canExecuteCode: boolean;
  canSpawnAgents: boolean;
  canMaintainMemory: boolean;

  // Media
  canProcessVoice: boolean;
  canProcessImages: boolean;
  canProcessDocuments: boolean;
}

export type BrainProvider =
  | 'claude-code'
  | 'openai'
  | 'openrouter'
  | 'gemini'
  | 'openclaw'
  | 'custom';

export interface BrainConfig {
  provider: BrainProvider;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  capabilities: BrainCapabilities;
  fallbackProvider?: BrainProvider;
}

export interface BrainRequest {
  id: string;
  tenantId: string;
  userId: string;
  prompt: string;
  context?: Record<string, unknown>;
  tools?: BrainTool[];
  stream?: boolean;
}

export interface BrainTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface BrainResponse {
  id: string;
  requestId: string;
  content: string;
  toolCalls?: BrainToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface BrainToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

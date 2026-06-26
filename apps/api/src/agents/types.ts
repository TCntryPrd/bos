/**
 * Agent system types — sub-agent spawning for BOS v2.
 *
 * Sub-agents are isolated brain instances that execute a single focused task
 * with a restricted tool set and their own conversation history. The main
 * brain orchestrates them via boss_spawn_agent / boss_spawn_parallel tool calls.
 */

export type AgentRole = 'researcher' | 'executor' | 'analyst' | 'writer';

export interface AgentSpec {
  /** Unique identifier for this agent invocation. */
  id: string;
  /** Determines the system prompt and default tool set. */
  role: AgentRole;
  /** Clear description of what the agent should accomplish. */
  task: string;
  /** Conversation ID of the parent brain session — for tracing only, not shared. */
  parentConversationId: string;
  /** Hard cap on tool call iterations before the agent is halted. */
  maxIterations: number;
  /** Explicit whitelist of tool names this agent may call. */
  allowedTools: string[];
}

export interface AgentResult {
  agentId: string;
  status: 'completed' | 'failed' | 'timeout';
  output: string;
  toolsUsed: string[];
  iterations: number;
  latencyMs: number;
}

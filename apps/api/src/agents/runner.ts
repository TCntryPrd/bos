/**
 * Agent runner — executes a single AgentSpec as an isolated brain instance.
 *
 * Mirrors the tool call loop in apps/api/src/routes/brain.ts but runs
 * completely independently: its own conversation history, its own system
 * prompt, and a strict tool whitelist.
 *
 * Agents CAN spawn sub-agents (swarm pattern). A leader agent can
 * delegate to child agents which can delegate further. Depth is
 * naturally bounded by context window and rate limits, not artificial caps.
 */

import crypto from 'node:crypto';
import type { BrainRouter } from '@boss/brain';
import type { BrainRequest, ConversationMessage } from '@boss/brain';
import { executeTool } from '../tools/executor.js';
import { getAvailableTools } from '../tools/index.js';
import type { AgentRole, AgentSpec, AgentResult } from './types.js';

// ── Per-role system prompts ───────────────────────────────────────────────────

const ROLE_PROMPTS: Record<AgentRole, string> = {
  researcher:
    'You are a BOS research agent. Your job is to gather information and report findings. ' +
    'Be thorough but concise. Use only the tools provided to you. ' +
    'When you have collected sufficient information, return a clear summary.',

  executor:
    'You are a BOS execution agent. Your job is to complete the specified task using the ' +
    'available tools. Execute precisely — do not deviate from the task. ' +
    'Report exactly what you did and whether it succeeded.',

  analyst:
    'You are a BOS analysis agent. Your job is to read data, identify patterns, and ' +
    'provide insights. Summarise clearly with supporting evidence from the data you read.',

  writer:
    'You are a BOS writing agent. Your job is to draft content, create records, and ' +
    'produce written output. Be clear and professional. Confirm what was created.',
};

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Execute a single agent task.
 *
 * No artificial timeout or iteration cap — agents run until they produce
 * a final answer. Natural bounds: context window, rate limits, and the
 * maxIterations field on the spec (set by the caller, defaults to 50).
 */
export async function runAgent(spec: AgentSpec, router: BrainRouter): Promise<AgentResult> {
  return _executeAgent(spec, router, Date.now());
}

async function _executeAgent(
  spec: AgentSpec,
  router: BrainRouter,
  startTime: number,
): Promise<AgentResult> {
  const toolsUsed: string[] = [];
  let iterations = 0;

  try {
    // Load the full tool catalogue and filter to what this agent is allowed to use.
    // We use 'default' as tenantId because agents share the parent's credentials.
    const allTools = await getAvailableTools('default');
    const agentTools = allTools.filter((t) => spec.allowedTools.includes(t.name));

    // The agent's conversation starts fresh — isolated from the parent session.
    const systemMessage: ConversationMessage = {
      role: 'system',
      content: ROLE_PROMPTS[spec.role],
      timestamp: Date.now(),
    };

    const userMessage: ConversationMessage = {
      role: 'user',
      content: spec.task,
      timestamp: Date.now(),
    };

    // Build the initial brain request.
    let currentReq: BrainRequest = {
      id: crypto.randomUUID(),
      type: 'tool_call',
      tenantId: 'default',
      userId: `agent-${spec.id}`,
      prompt: spec.task,
      context: {
        tenantId: 'default',
        userId: `agent-${spec.id}`,
        conversationHistory: [systemMessage, userMessage],
      },
      tools: agentTools.length > 0 ? agentTools : undefined,
      stream: false,
    };

    let lastResponse;

    // Tool call loop — identical pattern to the chat handler.
    while (iterations < spec.maxIterations) {
      iterations++;
      lastResponse = await router.route(currentReq);

      if (lastResponse.error) {
        return {
          agentId: spec.id,
          status: 'failed',
          output: `Agent failed at iteration ${iterations}: ${lastResponse.error}`,
          toolsUsed,
          iterations,
          latencyMs: Date.now() - startTime,
        };
      }

      // No tool calls — the agent has produced its final answer.
      if (!lastResponse.toolCalls || lastResponse.toolCalls.length === 0) {
        break;
      }

      // Execute tool calls and accumulate results.
      const toolResults: string[] = [];
      for (const toolCall of lastResponse.toolCalls) {
        // Enforce the allowedTools whitelist at execution time.
        if (!spec.allowedTools.includes(toolCall.name)) {
          toolResults.push(
            `${toolCall.name}:\nDenied — this tool is not in the agent's allowed tool set.`,
          );
          continue;
        }

        const result = await executeTool(toolCall.name, toolCall.arguments, 'default');
        toolResults.push(`${toolCall.name}:\n${result}`);

        if (!toolsUsed.includes(toolCall.name)) {
          toolsUsed.push(toolCall.name);
        }
      }

      // Build the tool results turn and continue the loop.
      const toolResultsPrompt = `Tool results:\n${toolResults.join('\n\n')}`;

      const workingHistory: ConversationMessage[] = [
        ...(currentReq.context?.conversationHistory ?? []),
        ...(lastResponse.content
          ? [{ role: 'assistant' as const, content: lastResponse.content, timestamp: Date.now() }]
          : []),
      ];

      currentReq = {
        ...currentReq,
        id: crypto.randomUUID(),
        prompt: toolResultsPrompt,
        context: {
          tenantId: 'default',
          userId: `agent-${spec.id}`,
          conversationHistory: workingHistory,
        },
        tools: agentTools.length > 0 ? agentTools : undefined,
      };
    }

    if (!lastResponse) {
      return {
        agentId: spec.id,
        status: 'failed',
        output: 'Agent produced no response.',
        toolsUsed,
        iterations,
        latencyMs: Date.now() - startTime,
      };
    }

    return {
      agentId: spec.id,
      status: 'completed',
      output: lastResponse.content || '(no text output)',
      toolsUsed,
      iterations,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      agentId: spec.id,
      status: 'failed',
      output: `Agent threw an unexpected error: ${msg}`,
      toolsUsed,
      iterations,
      latencyMs: Date.now() - startTime,
    };
  }
}

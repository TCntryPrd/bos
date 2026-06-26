/**
 * Learning capture middleware — observes brain responses to capture patterns.
 * Runs as post-middleware after every brain call.
 */

import type {
  BrainMiddleware,
  BrainRequest,
  BrainResponse,
  MiddlewareContext,
} from '../types.js';

export interface LearningCapture {
  /** Record an interaction for behavioral learning. */
  captureInteraction(entry: InteractionEntry): Promise<void>;
}

export interface InteractionEntry {
  tenantId: string;
  userId: string;
  requestType: string;
  prompt: string;
  response: string;
  adapterId: string;
  toolsUsed: string[];
  latencyMs: number;
  timestamp: number;
}

export function createLearningMiddleware(capture: LearningCapture): BrainMiddleware {
  return {
    name: 'learning-capture',
    phase: 'post',
    async execute(
      input: BrainRequest | BrainResponse,
      ctx: MiddlewareContext,
    ): Promise<BrainRequest | BrainResponse> {
      const response = input as BrainResponse;

      // Don't capture error responses
      if (response.error) return response;

      // Fire and forget — don't block the response pipeline
      capture
        .captureInteraction({
          tenantId: '', // Populated from the original request context by the router
          userId: '',
          requestType: '',
          prompt: '',
          response: response.content,
          adapterId: ctx.adapterId,
          toolsUsed: response.toolCalls?.map((tc) => tc.name) ?? [],
          latencyMs: response.latencyMs,
          timestamp: Date.now(),
        })
        .catch(() => {
          // Learning capture failures are non-critical — silently drop
        });

      return response;
    },
  };
}

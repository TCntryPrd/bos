/**
 * Context injection middleware — enriches requests with user profile and memory.
 * Runs as pre-middleware before every brain call.
 */

import type {
  BrainMiddleware,
  BrainRequest,
  BrainResponse,
  MiddlewareContext,
} from '../types.js';

export interface ContextProvider {
  /** Fetch user profile data for context injection. */
  getUserProfile(tenantId: string, userId: string): Promise<Record<string, unknown> | undefined>;
  /** Fetch relevant memories/embeddings for the prompt. */
  getRelevantMemories(tenantId: string, userId: string, query: string): Promise<string[]>;
}

export function createContextMiddleware(provider: ContextProvider): BrainMiddleware {
  return {
    name: 'context-injection',
    phase: 'pre',
    async execute(
      input: BrainRequest | BrainResponse,
      _ctx: MiddlewareContext,
    ): Promise<BrainRequest | BrainResponse> {
      const request = input as BrainRequest;
      if (!request.context?.tenantId || !request.context?.userId) {
        return request;
      }

      const { tenantId, userId } = request.context;

      const [profile, memories] = await Promise.all([
        provider.getUserProfile(tenantId, userId).catch(() => undefined),
        provider.getRelevantMemories(tenantId, userId, request.prompt).catch(() => [] as string[]),
      ]);

      return {
        ...request,
        context: {
          ...request.context,
          userProfile: profile ?? request.context.userProfile,
          memories: memories.length > 0 ? memories : request.context.memories,
        },
      };
    },
  };
}

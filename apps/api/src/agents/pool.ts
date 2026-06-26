/**
 * Agent pool — manages concurrent execution of multiple sub-agents.
 *
 * Runs up to MAX_CONCURRENT agents at the same time to avoid hitting
 * API rate limits. Additional agents are queued and started as slots
 * become available.
 */

import type { BrainRouter } from '@boss/brain';
import { runAgent } from './runner.js';
import type { AgentSpec, AgentResult } from './types.js';

// Keep this low — each agent is an independent Claude call.
// Three concurrent agents = three simultaneous API requests.
const MAX_CONCURRENT = 3;

/**
 * Run multiple agents in parallel with a concurrency cap.
 *
 * Results are returned in the same order as the input specs,
 * regardless of which agent finishes first.
 *
 * @param specs  - Array of AgentSpec objects to execute.
 * @param router - The shared BrainRouter instance.
 * @returns      Array of AgentResult in input order.
 */
export async function runAgentPool(
  specs: AgentSpec[],
  router: BrainRouter,
): Promise<AgentResult[]> {
  if (specs.length === 0) return [];

  // Pre-allocate the results array so we can slot in by index.
  const results: AgentResult[] = new Array(specs.length);

  // Semaphore: track how many agents are currently running.
  let running = 0;
  let nextIndex = 0;

  await new Promise<void>((resolve, reject) => {
    // Attempt to start agents whenever a slot opens up.
    function tick() {
      // If all agents have been dispatched and none are running, we're done.
      if (nextIndex >= specs.length && running === 0) {
        resolve();
        return;
      }

      // Fill available slots.
      while (running < MAX_CONCURRENT && nextIndex < specs.length) {
        const index = nextIndex++;
        running++;

        runAgent(specs[index], router)
          .then((result) => {
            results[index] = result;
          })
          .catch((err) => {
            // runAgent itself shouldn't throw — it catches internally.
            // If it does anyway, record a failed result rather than losing the slot.
            results[index] = {
              agentId: specs[index].id,
              status: 'failed',
              output: `Pool dispatch error: ${err instanceof Error ? err.message : String(err)}`,
              toolsUsed: [],
              iterations: 0,
              latencyMs: 0,
            };
          })
          .finally(() => {
            running--;
            tick();
          });
      }
    }

    try {
      tick();
    } catch (err) {
      reject(err);
    }
  });

  return results;
}

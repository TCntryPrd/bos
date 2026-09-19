/**
 * Managed Agent tool surface — definition and gating checks.
 *
 * These are the descriptors the brain sees, so a rename or a dropped required
 * field silently breaks delegation. Pinned here rather than discovered live.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ALL_MANAGED_AGENT_TOOLS,
  MANAGED_AGENT_TOOL_HANDLERS,
  managedAgentRunTool,
} from './managed-agent.js';

const originalKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe('managed agent tool definitions', () => {
  it('exposes a handler for every declared tool', () => {
    for (const tool of ALL_MANAGED_AGENT_TOOLS) {
      expect(MANAGED_AGENT_TOOL_HANDLERS[tool.name], `missing handler for ${tool.name}`).toBeTypeOf(
        'function',
      );
    }
  });

  it('declares no handler that has no tool', () => {
    const declared = new Set(ALL_MANAGED_AGENT_TOOLS.map((tool) => tool.name));
    for (const name of Object.keys(MANAGED_AGENT_TOOL_HANDLERS)) {
      expect(declared.has(name), `handler ${name} has no tool definition`).toBe(true);
    }
  });

  it('requires a prompt on the run tool', () => {
    expect(managedAgentRunTool.parameters.required).toContain('prompt');
    expect(managedAgentRunTool.parameters.properties).toHaveProperty('prompt');
  });

  it('points the brain away from n8n', () => {
    expect(managedAgentRunTool.description).toMatch(/boss_n8n_delegate/);
  });
});

describe('boss_managed_agent_run gating', () => {
  it('reports the missing API key instead of throwing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await MANAGED_AGENT_TOOL_HANDLERS.boss_managed_agent_run({ prompt: 'do a thing' });
    expect(result).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('rejects an empty prompt', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const result = await MANAGED_AGENT_TOOL_HANDLERS.boss_managed_agent_run({ prompt: '   ' });
    expect(result).toMatch(/requires a "prompt"/);
  });
});

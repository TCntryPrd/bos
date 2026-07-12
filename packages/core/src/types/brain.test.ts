/**
 * Unit tests — @boss/core brain types
 *
 * These tests verify the structural contracts of the type system by
 * constructing valid and invalid objects at runtime and asserting on
 * their shape and values.  TypeScript itself enforces the compile-time
 * contracts; the tests focus on runtime behaviour that downstream code
 * depends on.
 */

import { describe, it, expect } from 'vitest';
import type {
  BrainCapabilities,
  BrainConfig,
  BrainRequest,
  BrainResponse,
  BrainTool,
  BrainToolCall,
} from './brain.js';

// ── BrainCapabilities ────────────────────────────────────────────────

describe('BrainCapabilities', () => {
  it('accepts a full capabilities object with all boolean fields', () => {
    const caps: BrainCapabilities = {
      canChat: true,
      canStream: false,
      canUseTools: true,
      canAccessMCP: false,
      canExecuteCode: true,
      canSpawnAgents: false,
      canMaintainMemory: true,
      canProcessVoice: false,
      canProcessImages: true,
      canProcessDocuments: false,
    };

    expect(caps.canChat).toBe(true);
    expect(caps.canStream).toBe(false);
    expect(Object.keys(caps)).toHaveLength(10);
  });

  it('distinguishes between capability levels — chat-only vs full', () => {
    const chatOnly: BrainCapabilities = {
      canChat: true,
      canStream: true,
      canUseTools: false,
      canAccessMCP: false,
      canExecuteCode: false,
      canSpawnAgents: false,
      canMaintainMemory: false,
      canProcessVoice: false,
      canProcessImages: false,
      canProcessDocuments: false,
    };

    const fullCapabilities: BrainCapabilities = {
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
    };

    // Chat-only should not claim tool use
    expect(chatOnly.canUseTools).toBe(false);
    expect(chatOnly.canExecuteCode).toBe(false);

    // Full should claim everything except voice
    expect(fullCapabilities.canUseTools).toBe(true);
    expect(fullCapabilities.canExecuteCode).toBe(true);
    expect(fullCapabilities.canProcessVoice).toBe(false);
  });

  it('can be used as a filter predicate', () => {
    const adapters: Array<{ id: string; capabilities: BrainCapabilities }> = [
      {
        id: 'claude-code',
        capabilities: {
          canChat: true, canStream: true, canUseTools: true, canAccessMCP: true,
          canExecuteCode: true, canSpawnAgents: true, canMaintainMemory: true,
          canProcessVoice: false, canProcessImages: true, canProcessDocuments: true,
        },
      },
      {
        id: 'openai',
        capabilities: {
          canChat: true, canStream: true, canUseTools: true, canAccessMCP: false,
          canExecuteCode: false, canSpawnAgents: false, canMaintainMemory: false,
          canProcessVoice: false, canProcessImages: true, canProcessDocuments: false,
        },
      },
    ];

    const codeCap = adapters.filter((a) => a.capabilities.canExecuteCode);
    expect(codeCap).toHaveLength(1);
    expect(codeCap[0].id).toBe('claude-code');
  });
});

// ── BrainProvider ────────────────────────────────────────────────────

describe('BrainProvider values', () => {
  it('accepts all defined provider strings', () => {
    const validProviders = ['claude-code', 'openai', 'gemini', 'openclaw', 'custom'] as const;

    for (const provider of validProviders) {
      const config: BrainConfig = {
        provider,
        capabilities: {
          canChat: true, canStream: false, canUseTools: false, canAccessMCP: false,
          canExecuteCode: false, canSpawnAgents: false, canMaintainMemory: false,
          canProcessVoice: false, canProcessImages: false, canProcessDocuments: false,
        },
      };
      expect(config.provider).toBe(provider);
    }
  });
});

// ── BrainRequest ─────────────────────────────────────────────────────

describe('BrainRequest', () => {
  it('requires id, tenantId, userId and prompt', () => {
    const req: BrainRequest = {
      id: 'req-001',
      tenantId: 'tenant-abc',
      userId: 'user-xyz',
      prompt: 'What is on my calendar today?',
    };

    expect(req.id).toBe('req-001');
    expect(req.tenantId).toBe('tenant-abc');
    expect(req.prompt).toBe('What is on my calendar today?');
  });

  it('supports optional tools array', () => {
    const tool: BrainTool = {
      name: 'get_calendar_events',
      description: 'Retrieves calendar events for a date range',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', format: 'date' },
          end: { type: 'string', format: 'date' },
        },
        required: ['start', 'end'],
      },
    };

    const req: BrainRequest = {
      id: 'req-002',
      tenantId: 'tenant-abc',
      userId: 'user-xyz',
      prompt: 'Get my events for next week',
      tools: [tool],
    };

    expect(req.tools).toHaveLength(1);
    expect(req.tools![0].name).toBe('get_calendar_events');
  });

  it('supports optional context as arbitrary record', () => {
    const req: BrainRequest = {
      id: 'req-003',
      tenantId: 't1',
      userId: 'u1',
      prompt: 'Summarise last week',
      context: { timezone: 'America/New_York', locale: 'en-US' },
    };

    expect(req.context?.timezone).toBe('America/New_York');
  });

  it('supports stream flag', () => {
    const req: BrainRequest = {
      id: 'req-004',
      tenantId: 't1',
      userId: 'u1',
      prompt: 'Tell me a story',
      stream: true,
    };

    expect(req.stream).toBe(true);
  });
});

// ── BrainResponse ────────────────────────────────────────────────────

describe('BrainResponse', () => {
  it('links a response back to its request via requestId', () => {
    const resp: BrainResponse = {
      id: 'resp-001',
      requestId: 'req-001',
      content: 'You have 3 meetings today.',
    };

    expect(resp.requestId).toBe('req-001');
    expect(resp.content).toBe('You have 3 meetings today.');
  });

  it('supports optional tool calls', () => {
    const toolCall: BrainToolCall = {
      id: 'tc-001',
      name: 'get_calendar_events',
      arguments: { start: '2026-03-29', end: '2026-03-30' },
      result: [{ id: 'evt-1', title: 'Standup' }],
    };

    const resp: BrainResponse = {
      id: 'resp-002',
      requestId: 'req-002',
      content: '',
      toolCalls: [toolCall],
    };

    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls![0].name).toBe('get_calendar_events');
    expect(resp.toolCalls![0].result).toBeDefined();
  });

  it('supports optional usage metrics', () => {
    const resp: BrainResponse = {
      id: 'resp-003',
      requestId: 'req-003',
      content: 'Done.',
      usage: { inputTokens: 120, outputTokens: 45 },
    };

    expect(resp.usage?.inputTokens).toBe(120);
    expect(resp.usage?.outputTokens).toBe(45);
  });
});

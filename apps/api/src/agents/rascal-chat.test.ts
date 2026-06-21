/**
 * Unit tests for runChatTurn covering the allowAllTools danger flag
 * plumbing through the host-bridge and the turn-end detection on the
 * JSONL tail.
 *
 * Mocks `./host-bridge.js` so we can capture the args passed to the
 * bridge subcommands without running real SSH or touching the host.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridgeCalls: Array<{ subcommand: string; args: string[]; opts: { stdin?: string } }> = [];
const fakeFrames: Array<Record<string, unknown>> = [];

vi.mock('./host-bridge.js', () => ({
  BridgeError: class BridgeError extends Error {},
  callBridge: async (
    subcommand: string,
    args: string[] = [],
    opts: { stdin?: string } = {},
  ) => {
    bridgeCalls.push({ subcommand, args, opts });
    return { ok: true as const };
  },
  jsonlPathFor: (projectDir: string, sessionId: string) =>
    `${projectDir.replace(/\//g, '-')}/${sessionId}.jsonl`,
  jsonlSize: async () => 0,
  waitForJsonl: async () => 0,
  tailJsonlUntil: async (
    _path: string,
    _from: number,
    onFrame: (f: Record<string, unknown>) => void,
    isTurnEnd: (f: Record<string, unknown>) => boolean,
  ) => {
    for (const f of fakeFrames) {
      onFrame(f);
      if (isTurnEnd(f)) return;
    }
  },
}));

describe('runChatTurn allowAllTools flag', () => {
  beforeEach(() => {
    bridgeCalls.length = 0;
    fakeFrames.length = 0;
    // CC writes a `user` frame echoing the prompt, then assistant
    // frames. End-of-turn = assistant with stop_reason AFTER the user
    // echo (matches runChatTurn's isTurnEnd logic).
    fakeFrames.push({ type: 'user', message: { content: 'hi' } });
    fakeFrames.push({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 5, output_tokens: 3 },
        stop_reason: 'end_turn',
      },
    });
  });

  it('omits danger=true on the new-chat bridge call by default', async () => {
    const { runChatTurn } = await import('./rascal-chat.js');
    const fakeSse = { write: () => {} } as unknown as Parameters<typeof runChatTurn>[1];
    await runChatTurn(
      { message: 'hi', projectDir: '/home/tcntryprd/rascals/wheezer', ccSessionId: null },
      fakeSse,
    );
    const newChat = bridgeCalls.find((c) => c.subcommand === 'new-chat');
    expect(newChat).toBeDefined();
    expect(newChat!.args).not.toContain('danger=true');
  });

  it('passes danger=true to the new-chat bridge call when allowAllTools is true', async () => {
    const { runChatTurn } = await import('./rascal-chat.js');
    const fakeSse = { write: () => {} } as unknown as Parameters<typeof runChatTurn>[1];
    await runChatTurn(
      {
        message: 'hi',
        projectDir: '/home/tcntryprd/rascals/wheezer',
        ccSessionId: null,
        allowAllTools: true,
      },
      fakeSse,
    );
    const newChat = bridgeCalls.find((c) => c.subcommand === 'new-chat');
    expect(newChat).toBeDefined();
    expect(newChat!.args).toContain('danger=true');
  });

  it('sends the user message as stdin to the bridge send subcommand', async () => {
    const { runChatTurn } = await import('./rascal-chat.js');
    const fakeSse = { write: () => {} } as unknown as Parameters<typeof runChatTurn>[1];
    await runChatTurn(
      { message: 'test prompt', projectDir: '/home/tcntryprd/rascals/wheezer', ccSessionId: null },
      fakeSse,
    );
    const send = bridgeCalls.find((c) => c.subcommand === 'send');
    expect(send).toBeDefined();
    expect(send!.opts.stdin).toBe('test prompt');
  });

  it('aggregates assistant text from JSONL frames and reports tokens', async () => {
    const { runChatTurn } = await import('./rascal-chat.js');
    const fakeSse = { write: () => {} } as unknown as Parameters<typeof runChatTurn>[1];
    const result = await runChatTurn(
      { message: 'hi', projectDir: '/home/tcntryprd/rascals/wheezer', ccSessionId: null },
      fakeSse,
    );
    expect(result.assistantText).toBe('hello');
    expect(result.tokensIn).toBe(5);
    expect(result.tokensOut).toBe(3);
    expect(result.aborted).toBe(false);
  });
});

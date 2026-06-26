/**
 * chatTurn.ts — Spawn a local AI agent subprocess and yield its result
 * as a sequence of typed events for SSE relay.
 *
 * Runs Gio chat through Codex CLI. BOSS_GIO_BIN is retained as a Gio backend setting and defaults to codex.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnBridgeCommand } from '../agents/host-bridge.js';

const CODEX_BIN      = process.env.BOSS_GIO_BIN ?? 'codex';
const GIO_WORKSPACE = process.env.BOSS_GIO_WORKSPACE ?? '/home/boss/outsiders/gio';
const USE_HOST_BRIDGE = process.env.BOSS_GIO_HOST_BRIDGE === 'true';

export interface ChatTurnEvent {
  type: 'message' | 'interject' | 'error' | 'done';
  payload: Record<string, unknown>;
}

export interface ChatTurnHandle {
  child: ChildProcess;
  interrupt: () => void;
  done: Promise<{ exitCode: number | null; stderrTail: string; assistantText: string; aborted: boolean }>;
}

export interface ChatAttachment {
  path: string;
  mimeType?: string;
  name?: string;
}

// ---- Codex JSONL types ----------------------------------------------------

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    name?: string;
    command?: string;
    call_id?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

// ---- Implementations -------------------------------------------------------

function startCodexTurn(
  message: string,
  attachments: ChatAttachment[],
  onEvent: (event: ChatTurnEvent) => void,
): ChatTurnHandle {
  const baseArgs = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];
  const bridgeArgs = [GIO_WORKSPACE];
  for (const attachment of attachments) {
    if (attachment.mimeType?.startsWith('image/')) {
      baseArgs.push('--image', attachment.path);
      bridgeArgs.push(`image=${attachment.path}`);
    }
  }
  const args = ['exec', ...baseArgs, message];

  const child = USE_HOST_BRIDGE
    ? spawnBridgeCommand('codex-exec', bridgeArgs)
    : spawn(CODEX_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        cwd: GIO_WORKSPACE,
      });
  if (USE_HOST_BRIDGE) {
    child.stdin?.end(message);
  }
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let stderrBuffer = '';
  const startMs = Date.now();
  let assistantText = '';
  let aborted = false;

  let lineBuffer = '';

  const describeInterject = (ev: CodexEvent): string | null => {
    const itemType = ev.item?.type ?? '';
    if (!itemType || itemType === 'agent_message') return null;
    if (itemType === 'reasoning') return 'Gio is reasoning through the next step.';
    if (itemType === 'tool_call') {
      const label = ev.item?.name ?? ev.item?.command ?? 'tool';
      return `Gio is using ${label}.`;
    }
    if (itemType === 'tool_call_output') return 'Gio received tool output and is continuing.';
    if (itemType === 'command_execution') {
      const command = ev.item?.command ? `: ${ev.item.command}` : '';
      return `Gio is running a command${command}`;
    }
    if (ev.type.includes('started')) return `Gio started ${itemType}.`;
    if (ev.type.includes('completed')) return `Gio finished ${itemType}.`;
    return null;
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(trimmed) as CodexEvent;
    } catch {
      return;
    }

    if (
      ev.type === 'item.completed' &&
      ev.item?.type === 'agent_message' &&
      typeof ev.item.text === 'string' &&
      ev.item.text.length > 0
    ) {
      assistantText += ev.item.text;
      onEvent({
        type: 'message',
        payload: { text: ev.item.text, mediaUrl: null },
      });
    } else {
      const text = describeInterject(ev);
      if (text) {
        onEvent({
          type: 'interject',
          payload: { text, eventType: ev.type, itemType: ev.item?.type ?? null },
        });
      }
    }
    // turn.completed and other events are consumed silently; done fires on close.
  };

  child.stdout?.on('data', (chunk: string) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  });

  child.stderr?.on('data', (chunk: string) => { stderrBuffer += chunk; });

  const interrupt = (): void => {
    aborted = true;
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };

  const done = new Promise<{ exitCode: number | null; stderrTail: string; assistantText: string; aborted: boolean }>((resolve) => {
    child.on('error', (err) => {
      resolve({ exitCode: null, stderrTail: `spawn error: ${err.message}`, assistantText, aborted });
    });
    child.on('close', (code) => {
      // Flush any remaining buffered line.
      if (lineBuffer.trim()) processLine(lineBuffer);

      if (code !== 0 && !aborted) {
        onEvent({
          type: 'error',
          payload: {
            exitCode: code,
            stderrTail: stderrBuffer.slice(-2000),
            message: 'codex exec exited non-zero',
          },
        });
      }

      onEvent({
        type: 'done',
        payload: {
          durationMs: Date.now() - startMs,
          aborted,
          usage: null,
          model: null,
          provider: 'codex',
        },
      });

      resolve({ exitCode: code, stderrTail: stderrBuffer.slice(-2000), assistantText, aborted });
    });
  });

  return { child, interrupt, done };
}

// ---- Public API ------------------------------------------------------------

export function startChatTurn(
  message: string,
  attachments: ChatAttachment[],
  onEvent: (event: ChatTurnEvent) => void,
): ChatTurnHandle {
  return startCodexTurn(message, attachments, onEvent);
}

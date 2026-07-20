/**
 * Fresh interactive Claude turn inside a permanent per-agent tmux shell.
 *
 * The shell (`boss-agent-<handle>`) is durable. The Claude process is not:
 * every portal request receives a new session UUID, loads CLAUDE.md normally,
 * receives bounded memory in the prompt, and exits back to the shell after the
 * final response. This preserves interruption and live visibility without
 * carrying dirty CLI conversation history between requests or using `-p`.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import {
  BridgeError,
  callBridge,
  jsonlPathFor,
  jsonlSize,
  tailJsonlUntil,
  waitForJsonl,
} from './host-bridge.js';
import { builderSnapshot, builderStatus } from '../lib/builder-stream.js';

export interface AgentInteractiveTurnInput {
  runtimeId: string;
  handle: string;
  message: string;
  projectDir: string;
  /** Caller-generated fresh UUID, also recorded in boss_agent_turns. */
  ccSessionId?: string;
  model?: string;
  abortSignal?: AbortSignal;
  allowAllTools?: boolean;
  onStarted?: (ccSessionId: string) => void | Promise<void>;
  onPartial?: (
    text: string,
    tokensIn: number | null,
    tokensOut: number | null,
  ) => void | Promise<void>;
}

export interface AgentInteractiveTurnResult {
  ccSessionId: string;
  assistantText: string;
  tokensIn: number | null;
  tokensOut: number | null;
  aborted: boolean;
  timedOut?: boolean;
}

interface FinalAssistantFrame {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Read only the final text-bearing end_turn frame from this fresh session. */
export async function recoverFinalAssistantFrame(
  path: string,
  sendIsoMs: number,
): Promise<FinalAssistantFrame> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { return { text: '', tokensIn: null, tokensOut: null }; }
  let sawUserEcho = false;
  let result: FinalAssistantFrame = { text: '', tokensIn: null, tokensOut: null };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (frame.type === 'user') {
      const timestamp = typeof frame.timestamp === 'string' ? frame.timestamp : '';
      const timestampMs = timestamp ? Date.parse(timestamp) : 0;
      if (!timestamp || timestampMs >= sendIsoMs) sawUserEcho = true;
      continue;
    }
    if (!sawUserEcho || frame.type !== 'assistant') continue;
    const message = frame.message as {
      stop_reason?: string | null;
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
      };
    } | undefined;
    if (message?.stop_reason !== 'end_turn') continue;
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    if (!text) continue;
    const usage = message.usage;
    const inputTotal = usage
      ? (usage.input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
      : 0;
    result = {
      text,
      tokensIn: inputTotal > 0 ? inputTotal : result.tokensIn,
      tokensOut: typeof usage?.output_tokens === 'number' ? usage.output_tokens : result.tokensOut,
    };
  }
  return result;
}

function startAgentActivityMirror(
  runtimeId: string,
  handle: string,
  sessionId: string,
  baselinePane: string,
): () => void {
  const label = `claude:${handle}`;
  const baselineLines = baselinePane.split('\n');
  let stopped = false;
  let inFlight = false;
  let lastSnapshot = '';

  const capture = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await callBridge('agent-capture', [runtimeId], { timeoutMs: 4_000 });
      const pane = typeof result.pane === 'string' ? result.pane : '';
      if (!pane) return;
      const paneLines = pane.split('\n');
      let common = 0;
      while (
        common < baselineLines.length
        && common < paneLines.length
        && baselineLines[common] === paneLines[common]
      ) common += 1;
      const snapshot = paneLines.slice(common).slice(-160).join('\n').trimEnd();
      if (snapshot && snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        builderSnapshot(sessionId, label, snapshot);
      }
    } catch {
      // JSONL remains authoritative; a transient pane capture failure is safe.
    } finally {
      inFlight = false;
    }
  };

  void capture();
  const timer = setInterval(() => { void capture(); }, 1_500);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function runAgentInteractiveTurn(
  input: AgentInteractiveTurnInput,
  sseRes: ServerResponse,
): Promise<AgentInteractiveTurnResult> {
  const ccSessionId = input.ccSessionId ?? randomUUID();
  const label = `claude:${input.handle}`;
  const jsonlPath = jsonlPathFor(input.projectDir, ccSessionId);
  const sendIsoMs = Date.now() - 2_000;
  let startAttempted = false;
  let stopMirror = () => {};
  let assistantText = '';
  let finalAssistantText = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let aborted = input.abortSignal?.aborted ?? false;

  const writeSSE = (event: string, data: unknown) => {
    try { sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { /* browser left; host turn continues */ }
  };

  if (aborted) {
    return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: true };
  }

  const internalAbort = new AbortController();
  const onExternalAbort = () => {
    aborted = true;
    internalAbort.abort();
    void callBridge('agent-interrupt', [input.runtimeId, ccSessionId], { timeoutMs: 5_000 }).catch(() => {});
    writeSSE('aborted', { ccSessionId, handle: input.handle });
  };
  input.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const throwIfAborted = () => {
    if (internalAbort.signal.aborted) {
      throw Object.assign(new Error('aborted'), { aborted: true });
    }
  };

  try {
    await callBridge('agent-ensure', [input.runtimeId, input.projectDir], { timeoutMs: 10_000 });
    throwIfAborted();
    let baselinePane = '';
    try {
      const capture = await callBridge('agent-capture', [input.runtimeId], { timeoutMs: 4_000 });
      if (typeof capture.pane === 'string') baselinePane = capture.pane;
    } catch { /* baseline is optional */ }
    throwIfAborted();

    const cursor = await jsonlSize(jsonlPath);
    const args = [input.runtimeId, input.projectDir, ccSessionId];
    if (input.model?.trim()) args.push(`model=${input.model.trim()}`);
    if (input.allowAllTools) args.push('danger=true');
    startAttempted = true;
    await callBridge('agent-start', args, { stdin: input.message, timeoutMs: 75_000 });
    throwIfAborted();
    await input.onStarted?.(ccSessionId);
    stopMirror = startAgentActivityMirror(input.runtimeId, input.handle, ccSessionId, baselinePane);
    builderStatus(ccSessionId, label, 'live', 'fresh interactive Claude connected');

    if (cursor === 0) {
      await waitForJsonl(jsonlPath, 20_000, internalAbort.signal);
    }

    const onFrame = (frame: Record<string, unknown>) => {
      writeSSE('frame', frame);
      if (frame.type !== 'assistant') return;
      const message = frame.message as {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string | null;
        usage?: {
          input_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          output_tokens?: number;
        };
      } | undefined;
      const frameText = (message?.content ?? [])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text ?? '')
        .join('');
      if (frameText) assistantText += frameText;
      if (message?.stop_reason === 'end_turn' && frameText.trim()) {
        finalAssistantText = frameText.trim();
      }
      const usage = message?.usage;
      if (usage) {
        const inputTotal = (usage.input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0);
        if (inputTotal > 0) tokensIn = inputTotal;
        if (typeof usage.output_tokens === 'number') tokensOut = usage.output_tokens;
      }
      if (frameText && input.onPartial) {
        try {
          const pending = input.onPartial(assistantText, tokensIn, tokensOut);
          if (pending instanceof Promise) pending.catch(() => {});
        } catch { /* persistence failure must not break the live turn */ }
      }
    };

    let sawUserEcho = false;
    const isTurnEnd = (frame: Record<string, unknown>): boolean => {
      if (frame.type === 'user') {
        const timestamp = typeof frame.timestamp === 'string' ? frame.timestamp : '';
        const timestampMs = timestamp ? Date.parse(timestamp) : 0;
        if (!timestamp || timestampMs >= sendIsoMs) sawUserEcho = true;
        return false;
      }
      if (!sawUserEcho || frame.type !== 'assistant') return false;
      const message = frame.message as {
        stop_reason?: string | null;
        content?: Array<{ type?: string }>;
      } | undefined;
      return message?.stop_reason === 'end_turn'
        && (message.content ?? []).some((block) => block.type === 'text');
    };

    try {
      await tailJsonlUntil(jsonlPath, cursor, onFrame, isTurnEnd, {
        signal: internalAbort.signal,
        idleTimeoutMs: 600_000,
        projectDir: input.projectDir,
        pivotSinceMs: sendIsoMs,
      });
    } catch (error) {
      if ((error as { aborted?: boolean }).aborted) {
        builderStatus(ccSessionId, label, 'finished', 'interrupted');
        return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: true };
      }
      const detail = error instanceof Error ? error.message : String(error);
      writeSSE('error', { message: `interactive turn tail failed: ${detail}` });
      const recovered = await recoverFinalAssistantFrame(jsonlPath, sendIsoMs);
      if (recovered.text) {
        assistantText = recovered.text;
        tokensIn = recovered.tokensIn ?? tokensIn;
        tokensOut = recovered.tokensOut ?? tokensOut;
        try { await input.onPartial?.(assistantText, tokensIn, tokensOut); } catch { /* logged by route */ }
      }
      builderStatus(ccSessionId, label, 'error', 'interactive JSONL tail timed out');
      return { ccSessionId, assistantText, tokensIn, tokensOut, aborted, timedOut: true };
    }

    const recovered = await recoverFinalAssistantFrame(jsonlPath, sendIsoMs);
    assistantText = recovered.text || finalAssistantText || assistantText;
    tokensIn = recovered.tokensIn ?? tokensIn;
    tokensOut = recovered.tokensOut ?? tokensOut;
    try { await input.onPartial?.(assistantText, tokensIn, tokensOut); } catch { /* logged by route */ }

    writeSSE('frame', {
      type: 'result',
      usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      result: assistantText,
    });
    writeSSE('done', { ccSessionId, tokensIn, tokensOut });
    builderStatus(ccSessionId, label, 'finished');
    return { ccSessionId, assistantText, tokensIn, tokensOut, aborted };
  } catch (error) {
    if ((error as { aborted?: boolean }).aborted || aborted) {
      builderStatus(ccSessionId, label, 'finished', 'interrupted');
      return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: true };
    }
    const detail = error instanceof Error ? error.message : String(error);
    builderStatus(ccSessionId, label, 'error', detail);
    writeSSE('error', { message: error instanceof BridgeError ? error.message : detail });
    throw error;
  } finally {
    stopMirror();
    input.abortSignal?.removeEventListener('abort', onExternalAbort);
    if (startAttempted) {
      try {
        await callBridge('agent-finish', [input.runtimeId, ccSessionId], { timeoutMs: 120_000 });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        builderStatus(ccSessionId, label, 'error', `cleanup failed: ${detail}`);
        writeSSE('error', { message: `Claude finished, but its shell cleanup failed: ${detail}` });
      }
    }
  }
}

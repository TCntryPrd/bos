/**
 * rascal-chat.ts
 *
 * Drives one chat turn against a rascal/outsider/COO CC session that
 * lives in a host tmux (created via the host-bridge). Forwards JSONL
 * session frames as SSE to the connected client; aggregates assistant
 * text + token counts for DB persistence.
 *
 * Architecture (BOS handoff v2.1, section 2.2): the rascal CC
 * process runs on host inside tmux session boss-chat-<ccSessionId>.
 * Input goes through the host bridge (tmux paste-buffer + send-keys
 * Enter). Output comes from tailing the CC session JSONL at
 * ~/.claude/projects/<slug>/<ccSessionId>.jsonl, which is bind-mounted
 * into the container at the same path.
 *
 * One chatId per chat session row. The chatId IS the ccSessionId
 * (UUID); the tmux session name is boss-chat-<uuid>. Two chats with
 * the same rascal get two tmux sessions, two CC processes, two UUIDs.
 * No cross-talk.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import {
  callBridge,
  jsonlPathFor,
  jsonlSize,
  waitForJsonl,
  tailJsonlUntil,
  BridgeError,
} from './host-bridge.js';
import { builderTap, builderStatus } from '../lib/builder-stream.js';

/**
 * Safety-net text recovery. Read the JSONL between `cursor` and EOF and
 * extract all assistant text that arrived after our send (timestamp ≥
 * sendIsoMs). Used as a final ground-truth check before runChatTurn
 * returns — if the live tail missed anything (early exit, detector bug,
 * tail crash), this catches it. Returns the concatenated text and the
 * latest token usage seen.
 *
 * Why this exists: the live tail's end-of-turn detector has cut turns
 * off early at least twice (2026-05-18 Darla SSH incident). The JSONL
 * on disk is authoritative; the tail is just a stream view. Always
 * reconcile against disk before declaring a turn persisted.
 */
/** Tool names invoked in this turn (frames at/after sendIsoMs) — the essential
 *  tool info for the cleaned conversation log. Compact + capped (token-aware). */
export async function extractToolTrace(jsonlPath: string, sendIsoMs: number): Promise<string[]> {
  let raw: string;
  try { raw = await readFile(jsonlPath, 'utf8'); } catch { return []; }
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const ts = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : 0;
    if (ts && ts < sendIsoMs) continue;
    if (frame.type !== 'assistant') continue;
    const content = (frame.message as { content?: Array<{ type: string; name?: string }> } | undefined)?.content ?? [];
    for (const b of content) if (b.type === 'tool_use' && b.name) names.add(String(b.name));
  }
  return [...names].slice(0, 12);
}

export async function recoverTurnFromJsonl(
  jsonlPath: string,
  sendIsoMs: number,
): Promise<{ text: string; tokensIn: number | null; tokensOut: number | null }> {
  let raw: string;
  try {
    raw = await readFile(jsonlPath, 'utf8');
  } catch {
    return { text: '', tokensIn: null, tokensOut: null };
  }
  const lines = raw.split('\n');
  let sawUserAfterSend = false;
  let text = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  for (const line of lines) {
    if (!line) continue;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const ts = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : 0;
    if (frame.type === 'user') {
      if (!frame.timestamp || ts >= sendIsoMs) sawUserAfterSend = true;
      continue;
    }
    if (!sawUserAfterSend) continue;
    if (frame.type !== 'assistant') continue;
    const message = frame.message as
      | {
          content?: Array<{ type: string; text?: string }>;
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
          };
        }
      | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && block.text) text += block.text;
    }
    const usage = message?.usage;
    if (usage) {
      const inTok =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (inTok > 0) tokensIn = inTok;
      if (typeof usage.output_tokens === 'number') tokensOut = usage.output_tokens;
    }
  }
  return { text, tokensIn, tokensOut };
}

export interface ChatTurnInput {
  message: string;
  projectDir: string;
  ccSessionId: string | null;
  model?: string;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  /** Pass --dangerously-skip-permissions through to the host CC.
   *  All chat surfaces (rascal/outsider/COO) set this true since
   *  2026-05-18 — the web has no UI for CC's interactive permission
   *  prompts, and rascals were freezing on every Bash/Edit/Skill
   *  consent. The "only COO" rule was retired; Kevin's protection
   *  now comes from the per-rascal Standing rules section in CLAUDE.md
   *  (drafts only, no $$/scope without Kevin) rather than CC's
   *  runtime prompts. */
  allowAllTools?: boolean;
  /** Persist-on-frame callback. Fired by runChatTurn after every
   *  assistant frame with the latest aggregated text + token counts.
   *  The route handler uses this to UPSERT the assistant row in
   *  boss_chat_messages on-the-fly, so a dropped SSE / API restart /
   *  idle timeout still leaves the latest partial in the DB. The route
   *  is responsible for throttling its own writes; runChatTurn calls
   *  this unconditionally on every assistant frame. */
  onPartial?: (
    text: string,
    tokensIn: number | null,
    tokensOut: number | null,
  ) => void | Promise<void>;
}

export interface ChatTurnResult {
  ccSessionId: string;
  assistantText: string;
  tokensIn: number | null;
  tokensOut: number | null;
  aborted: boolean;
  /** True when the tail timed out before declaring end-of-turn. The
   *  accumulated text is still valid and should be persisted; the agent
   *  may have finished but our detector missed the boundary. */
  timedOut?: boolean;
  /** Tool names invoked this turn (frame-captured) for the cleaned conversation log. */
  toolNames?: string[];
}

/**
 * Run one chat turn. Ensures a host tmux running claude exists for
 * this chat, pastes the message in, tails the JSONL session log for
 * output, forwards frames to the SSE client, and resolves with the
 * aggregated assistant text + token counters.
 *
 * If `abortSignal` fires, the host tmux session is killed and the
 * promise resolves with whatever was aggregated so far (aborted: true).
 */
export async function runChatTurn(
  input: ChatTurnInput,
  sseRes: ServerResponse,
): Promise<ChatTurnResult> {
  if (process.env.BOSS_CHAT_RUNNER === 'local') {
    return runLocalChatTurn(input, sseRes);
  }

  const ccSessionId = input.ccSessionId ?? randomUUID();

  const writeSSE = (event: string, data: unknown) => {
    try {
      sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* connection closed */
    }
  };

  // 1. Ensure the host tmux + CC for this chat is up. new-chat is
  // idempotent: reuses the tmux if present, resumes the CC session if
  // its JSONL exists, otherwise creates fresh with --session-id. The
  // bridge waits for CC to reach its REPL prompt before returning.
  const newChatArgs = [ccSessionId, input.projectDir, ccSessionId];
  if (input.model && input.model.length > 0) {
    newChatArgs.push(`model=${input.model}`);
  }
  if (input.allowAllTools) {
    newChatArgs.push('danger=true');
  }
  try {
    await callBridge('new-chat', newChatArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSSE('error', { message: `bridge new-chat failed: ${msg}` });
    throw err;
  }

  // 2. Snapshot JSONL size BEFORE send. CC writes the file lazily on
  // first user input, so size is 0 (or file missing) on a brand-new
  // session; on resume it is the current size of accumulated history.
  // Also record a wall-clock cutoff so the tail can pivot to any
  // newer JSONL CC creates (e.g. after /compact).
  const jsonlPath = jsonlPathFor(input.projectDir, ccSessionId);
  const cursor = await jsonlSize(jsonlPath);
  const pivotSinceMs = Date.now() - 2_000; // small back-window for clock skew

  // 3. Send the message into the tmux pane.
  try {
    await callBridge('send', [ccSessionId], { stdin: input.message });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSSE('error', { message: `bridge send failed: ${msg}` });
    throw err;
  }

  // 4. For a brand-new session the JSONL file appears only after CC
  // accepts the first message; poll until it exists, then tail.
  if (cursor === 0) {
    try {
      await waitForJsonl(jsonlPath, 15_000);
    } catch (err) {
      writeSSE('error', { message: `JSONL session never appeared: ${jsonlPath}` });
      throw err;
    }
  }

  // 4. Tail JSONL until we see the end-of-turn frame, an abort, or an
  // idle timeout (CC crashed / wedged).
  let assistantText = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let aborted = false;

  const onFrame = (frame: Record<string, unknown>) => {
    writeSSE('frame', frame);
    if (frame.type === 'assistant') {
      const message = frame.message as
        | {
            content?: Array<{ type: string; text?: string }>;
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              output_tokens?: number;
            };
            stop_reason?: string | null;
          }
        | undefined;
      let textAccrued = false;
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          assistantText += block.text;
          textAccrued = true;
        }
      }
      const usage = message?.usage;
      if (usage) {
        const inTok =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        if (inTok > 0) tokensIn = inTok;
        if (typeof usage.output_tokens === 'number') tokensOut = usage.output_tokens;
      }
      // Fire persist-on-frame for any assistant frame that contributed
      // new text. Skip thinking-only frames (no text accrued) — they
      // don't change what the user would see in the DB. The route handler
      // throttles writes so this is cheap to call.
      if (textAccrued && input.onPartial) {
        try {
          const maybePromise = input.onPartial(assistantText, tokensIn, tokensOut);
          if (maybePromise instanceof Promise) {
            // Don't await — keep onFrame synchronous so we never block
            // the JSONL tail. Swallow rejections so a transient DB blip
            // never aborts the whole turn.
            maybePromise.catch(() => { /* logged by the route */ });
          }
        } catch { /* never crash the frame loop */ }
      }
    }
  };

  // End-of-turn: track whether we have seen a `user` frame written
  // *after* our send (the JSONL echo of the message we just pasted).
  // Historical user frames carry old timestamps — they appear in
  // post-/compact JSONLs as replayed context and must not count as
  // the echo. Until we see a fresh user frame, any assistant
  // stop_reason belongs to either scheduled-task background work or
  // the compact summary's own ack, not to our turn.
  const sendIsoMs = Date.now() - 2_000;
  let sawUserEcho = false;
  const isTurnEnd = (frame: Record<string, unknown>): boolean => {
    if (frame.type === 'user') {
      const tsStr = typeof frame.timestamp === 'string' ? frame.timestamp : null;
      const tsMs = tsStr ? Date.parse(tsStr) : 0;
      // Accept user frames without a timestamp (legacy) so we never hang.
      if (!tsStr || tsMs >= sendIsoMs) sawUserEcho = true;
      return false;
    }
    if (!sawUserEcho) return false;
    if (frame.type !== 'assistant') return false;
    const message = frame.message as
      | { stop_reason?: string | null; content?: Array<{ type?: string }> }
      | undefined;
    // 2026-05-18 (post-Darla-SSH-fix-incident): only stop_reason='end_turn'
    // marks the actual end of the model's response. Within a single user→model
    // exchange the model emits multiple assistant frames separated by tool-use
    // cycles, each with stop_reason='tool_use' meaning "I have more tool calls
    // to make before I'm done." The previous logic ended on ANY non-empty
    // stop_reason that also carried text or tool_use blocks, which cut the
    // turn off at the first tool call. Darla's 1195-char SSH-not-responding
    // analysis (after a Bash tool call) and her 349-char follow-up were both
    // orphaned this way until I tightened this check.
    if (message?.stop_reason !== 'end_turn') return false;
    // Extended thinking emits a thinking-only assistant frame with
    // stop_reason='end_turn' just before the real text frame. Require a real
    // text block so we don't end on that stub. (tool_use never co-occurs with
    // end_turn in the protocol — if it does, the next frame will catch us.)
    const blocks = message?.content ?? [];
    return blocks.some((b) => b.type === 'text');
  };

  const internalAbort = new AbortController();
  const onExternalAbort = () => {
    aborted = true;
    internalAbort.abort();
    // Send Escape to the CC pane: interrupts the current tool / subagent
    // without killing the tmux session. The CC process keeps running so
    // chat continuity is preserved and any queued user message goes
    // through cleanly on the next turn. Killing the whole tmux used to
    // be the behavior here, but that lost CC's --continue context.
    callBridge('interrupt', [ccSessionId]).catch(() => { /* best-effort */ });
    writeSSE('aborted', { ccSessionId });
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) onExternalAbort();
    else input.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    await tailJsonlUntil(jsonlPath, cursor, onFrame, isTurnEnd, {
      signal: internalAbort.signal,
      // 2026-05-18: bumped 120s → 600s. Darla emitted intermediate text +
      // tool_use at 18:58:55, then thought silently for 3m26s before the
      // next frame at 19:02:21. The 120s timeout fired mid-cogitation and
      // cut the SSE off, persisting only the partial response. Deep CC
      // thinking can easily go 3-5 min between frames; 10 min gives a real
      // safety margin while still catching truly hung processes.
      idleTimeoutMs: 600_000,
      projectDir: input.projectDir,
      pivotSinceMs,
    });
  } catch (err) {
    if ((err as { aborted?: boolean }).aborted) {
      // Aborted is the expected control flow for client disconnect.
      return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: true };
    }
    if (err instanceof BridgeError) {
      writeSSE('error', { message: err.message });
      throw err;
    }
    // Tail timeout / read error: surface to SSE then fall through to the
    // safety-net JSONL scan below so partial state on disk still lands.
    const msg = (err as Error).message ?? String(err);
    writeSSE('error', { message: `tail failed: ${msg}` });
    const recovered = await recoverTurnFromJsonl(jsonlPath, sendIsoMs);
    if (recovered.text.length > assistantText.length) {
      assistantText = recovered.text;
      if (recovered.tokensIn != null) tokensIn = recovered.tokensIn;
      if (recovered.tokensOut != null) tokensOut = recovered.tokensOut;
      if (input.onPartial) {
        try { await input.onPartial(assistantText, tokensIn, tokensOut); } catch { /* logged by route */ }
      }
    }
    return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: false, timedOut: true };
  } finally {
    if (input.abortSignal) {
      input.abortSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  // Belt-and-suspenders: reconcile against the JSONL on disk before we
  // declare the turn done. If the live tail's detector ended early (or
  // missed frames), the on-disk scan catches the missing text and
  // re-fires onPartial so the route's persist closure writes the full
  // response. Cheap: one fs read per turn, only meaningful when the live
  // pass left text behind.
  const recovered = await recoverTurnFromJsonl(jsonlPath, sendIsoMs);
  if (recovered.text.length > assistantText.length) {
    assistantText = recovered.text;
    if (recovered.tokensIn != null) tokensIn = recovered.tokensIn;
    if (recovered.tokensOut != null) tokensOut = recovered.tokensOut;
    if (input.onPartial) {
      try { await input.onPartial(assistantText, tokensIn, tokensOut); } catch { /* logged by route */ }
    }
  }

  // Synthesize a `result` frame so SSE consumers expecting the old
  // stream-json shape see a turn boundary. UI compat.
  writeSSE('frame', {
    type: 'result',
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
    result: assistantText,
  });
  writeSSE('done', { ccSessionId, tokensIn, tokensOut });

  return { ccSessionId, assistantText, tokensIn, tokensOut, aborted };
}

export async function runLocalChatTurn(
  input: ChatTurnInput,
  sseRes: ServerResponse,
): Promise<ChatTurnResult> {
  const ccSessionId = input.ccSessionId ?? randomUUID();
  let assistantText = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let aborted = false;

  const writeSSE = (event: string, data: unknown) => {
    try {
      sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* connection closed */
    }
  };

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];
  // Resume an existing CC session; --session-id only works for brand-new ids.
  if (input.ccSessionId) args.push('--resume', ccSessionId);
  else args.push('--session-id', ccSessionId);
  // BOS default: Sonnet 5 at high reasoning effort. A caller-supplied model wins;
  // otherwise fall back to CLAUDE_MODEL, then the hard default.
  const model = (input.model && input.model.length > 0)
    ? input.model
    : (process.env.CLAUDE_MODEL || 'claude-sonnet-5');
  args.push('--model', model);
  args.push('--effort', process.env.CLAUDE_EFFORT || 'high');
  if (input.systemPrompt && input.systemPrompt.trim().length > 0) {
    args.push('--append-system-prompt', input.systemPrompt);
  }
  args.push(input.message);
  const toolNames = new Set<string>();

  const proc = spawn('claude', args, {
    cwd: input.projectDir,
    env: {
      ...process.env,
      HOME: process.env.HOME ?? '/home/boss',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onExternalAbort = () => {
    aborted = true;
    try { proc.kill('SIGINT'); } catch { /* gone */ }
    writeSSE('aborted', { ccSessionId });
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) onExternalAbort();
    else input.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const handleFrame = (frame: Record<string, unknown>) => {
    writeSSE('frame', frame);
    if (frame.type !== 'assistant') return;
    const message = frame.message as
      | {
          content?: Array<{ type: string; text?: string }>;
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
          };
        }
      | undefined;
    let textAccrued = false;
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && block.text) {
        assistantText += block.text;
        textAccrued = true;
      } else if (block.type === 'tool_use') {
        const tn = (block as { name?: string }).name;
        if (tn) toolNames.add(tn);
      }
    }
    const usage = message?.usage;
    if (usage) {
      const inTok =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (inTok > 0) tokensIn = inTok;
      if (typeof usage.output_tokens === 'number') tokensOut = usage.output_tokens;
    }
    if (textAccrued && input.onPartial) {
      try {
        const maybePromise = input.onPartial(assistantText, tokensIn, tokensOut);
        if (maybePromise instanceof Promise) maybePromise.catch(() => { /* logged by route */ });
      } catch { /* never crash the stream */ }
    }
  };

  const parseChunk = (() => {
    let buffer = '';
    return (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          builderTap(ccSessionId, builderChatLabel, line);
          try { handleFrame(JSON.parse(line) as Record<string, unknown>); }
          catch { /* ignore non-json noise */ }
        }
        nl = buffer.indexOf('\n');
      }
    };
  })();

  const builderChatLabel = `claude:${input.projectDir.split('/').pop() ?? 'agent'}`;
  let stderr = '';
  proc.stdout.on('data', parseChunk);
  proc.on('close', (code) => {
    builderStatus(ccSessionId, builderChatLabel, code === 0 ? 'finished' : 'error', `exit ${code}`);
  });
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', resolve);
  }).finally(() => {
    if (input.abortSignal) input.abortSignal.removeEventListener('abort', onExternalAbort);
  });

  if (aborted) return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: true, toolNames: [...toolNames] };
  if (code !== 0) {
    const detail = stderr.trim() || `claude exited ${code}`;
    writeSSE('error', { message: detail });
    throw new Error(detail);
  }

  if (input.onPartial) {
    try { await input.onPartial(assistantText, tokensIn, tokensOut); } catch { /* logged by route */ }
  }
  writeSSE('frame', {
    type: 'result',
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
    result: assistantText,
  });
  writeSSE('done', { ccSessionId, tokensIn, tokensOut });

  return { ccSessionId, assistantText, tokensIn, tokensOut, aborted: false, toolNames: [...toolNames] };
}

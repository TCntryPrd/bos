/**
 * host-bridge.ts
 *
 * SSH wrapper around ~/bin/boss-host-bridge.sh on the host. Lets the
 * boss_api container run tmux + claude operations as user tcntryprd
 * on host, so rascal/outsider/COO chat CC processes always live in
 * host PID namespace (BOS handoff v2.1 section 2.2).
 *
 * Why SSH and not a Unix socket: the host already has openssh running
 * for Kevin. The container has openssh-client. Adding a Unix socket
 * daemon would be one more thing to maintain. SSH is a single
 * authorized_keys entry with command restriction; the bridge script
 * validates its own args. Per-call SSH handshake adds ~80ms latency
 * which is invisible against chat turn cost.
 *
 * The key is mounted into the container via the existing
 * /home/tcntryprd -> /data/home bind. Reachable inside container at
 * /data/home/.ssh/boss-host-bridge.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SSH_KEY = process.env.BOSS_HOST_BRIDGE_KEY ?? '/data/home/.ssh/boss-host-bridge';
const SSH_HOST = process.env.BOSS_HOST_BRIDGE_HOST ?? 'tcntryprd@host.docker.internal';
const KNOWN_HOSTS = process.env.BOSS_HOST_BRIDGE_KNOWN_HOSTS ?? '/tmp/boss-known-hosts';

function sshArgs(): string[] {
  return [
    '-i', SSH_KEY,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    SSH_HOST,
  ];
}

export interface BridgeOk {
  ok: true;
  [key: string]: unknown;
}
export interface BridgeErr {
  ok: false;
  error: string;
}
export type BridgeResult = BridgeOk | BridgeErr;

export class BridgeError extends Error {
  constructor(public readonly subcommand: string, public readonly detail: string) {
    super(`boss-host-bridge ${subcommand} failed: ${detail}`);
  }
}

/**
 * Run a one-shot bridge subcommand. Returns the parsed JSON line the
 * bridge prints to stdout. Throws BridgeError on non-zero exit or
 * malformed output.
 */
export function callBridge(
  subcommand: string,
  args: string[] = [],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<BridgeOk> {
  return new Promise<BridgeOk>((resolve, reject) => {
    // SSH passes the full command word as SSH_ORIGINAL_COMMAND. The
    // bridge script word-splits it, so positional args go in directly.
    // No metacharacters allowed by the bridge validator.
    const remoteCmd = [subcommand, ...args].join(' ');
    const proc = spawn('ssh', [...sshArgs(), remoteCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeout = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    }, timeout);
    timer.unref();

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new BridgeError(subcommand, err.message));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new BridgeError(subcommand, `timed out after ${timeout}ms`));
      }
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      let parsed: BridgeResult;
      try {
        parsed = JSON.parse(lastLine) as BridgeResult;
      } catch {
        return reject(new BridgeError(subcommand, `bad JSON from bridge (exit=${code}, stderr=${stderr.slice(0, 200)})`));
      }
      if (!parsed.ok) {
        return reject(new BridgeError(subcommand, parsed.error));
      }
      resolve(parsed);
    });
  });
}

/**
 * Spawn an SSH process running an arbitrary remote command. Returns
 * the child so the caller can stream stdin/stdout/stderr. Used for
 * legacy print-mode spawns that still need stream-json input from CC.
 */
export function spawnBridgeRaw(remoteArgs: string[]): ChildProcess {
  return spawn('ssh', [...sshArgs(), ...remoteArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Spawn a host bridge subcommand and keep its stdio streaming. This is
 * for native CLI turns where the long-running process must live outside
 * the API container, but the API still needs JSONL stdout/stderr.
 */
export function spawnBridgeCommand(subcommand: string, args: string[] = []): ChildProcess {
  const remoteCmd = [subcommand, ...args].join(' ');
  return spawn('ssh', [...sshArgs(), remoteCmd], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Encode a host project dir into the slug Claude Code uses for its
 *  ~/.claude/projects/<slug>/ subdir. Replicates CC's "slash to dash"
 *  encoding (verified against existing rascal session files). */
export function encodeJsonlSlug(projectDir: string): string {
  return projectDir.replace(/\//g, '-');
}

/** Directory under ~/.claude/projects/ where CC writes JSONLs for a project. */
export function jsonlDirFor(projectDir: string): string {
  const home = process.env.CLAUDE_HOME ?? process.env.HOME ?? '/home/tcntryprd';
  return `${home}/.claude/projects/${encodeJsonlSlug(projectDir)}`;
}

/** Full path to a CC session JSONL file given a project dir + session UUID. */
export function jsonlPathFor(projectDir: string, sessionId: string): string {
  return join(jsonlDirFor(projectDir), `${sessionId}.jsonl`);
}

/**
 * Find the newest JSONL in a project dir whose mtimeMs is >= `sinceMs`.
 * CC starts a new JSONL when /compact runs (and on some branch flows), so
 * the file we started tailing is not necessarily where CC ends up writing.
 * Returns null if no JSONL is newer than the cutoff.
 */
export async function newestJsonlSince(projectDir: string, sinceMs: number): Promise<{ path: string; mtimeMs: number } | null> {
  let entries: string[];
  try {
    entries = await readdir(jsonlDirFor(projectDir));
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(jsonlDirFor(projectDir), name);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue;
      if (s.mtimeMs < sinceMs) continue;
      if (!best || s.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: s.mtimeMs };
    } catch {
      // file went away mid-scan, skip
    }
  }
  return best;
}

/** Resolve once the JSONL file appears, polling every 100ms. Rejects after timeout. */
export async function waitForJsonl(path: string, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await stat(path);
      return s.size;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`JSONL never appeared at ${path} after ${timeoutMs}ms`);
}

/** Current size of a JSONL file. Returns 0 if missing. */
export async function jsonlSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Tail a CC session JSONL file from `fromByte`, parsing each new line
 * as JSON and yielding it. Resolves when the caller-provided
 * `isTurnEnd` predicate returns true on a frame, or when `signal` fires.
 *
 * If `projectDir` is supplied, the tail watches the *project* — not just
 * the single file path. When CC compacts (or otherwise rotates session
 * id), a brand new JSONL appears alongside the original; this function
 * detects that and pivots its tail target to the newer file so the
 * post-compact response still streams. Without this, the post-compact
 * answer lands in a file no one is reading and the UI hangs.
 *
 * If the active file isn't growing for `idleTimeoutMs` and no end-of-turn
 * detected, rejects (likely crash or wedged CC).
 */
export async function tailJsonlUntil(
  path: string,
  fromByte: number,
  onFrame: (frame: Record<string, unknown>) => void,
  isTurnEnd: (frame: Record<string, unknown>) => boolean,
  opts: {
    signal?: AbortSignal;
    idleTimeoutMs?: number;
    pollMs?: number;
    /** Project dir; if set, the tail will pivot to the newest JSONL in
     *  this dir when CC starts writing to a different file (compact/branch). */
    projectDir?: string;
    /** Pivot detection cutoff: only consider JSONLs with mtimeMs >= this.
     *  Typically set to the turn-start timestamp by the caller. */
    pivotSinceMs?: number;
    /** Debounce window after isTurnEnd returns true. The turn only truly
     *  ends if no new frames arrive within this window. Catches the case
     *  where the model writes a brief acknowledgment with stop_reason=
     *  end_turn and then auto-continues with tool calls + a real final
     *  response. Default 4000ms. Set to 0 to disable. */
    endDebounceMs?: number;
  } = {},
): Promise<void> {
  const idleTimeout = opts.idleTimeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 120;
  // "Pivot probe" runs cheaper than the main poll — once per second is
  // plenty since /compact is a multi-second event.
  const pivotProbeMs = 1_000;
  const pivotSinceMs = opts.pivotSinceMs ?? 0;
  const endDebounceMs = opts.endDebounceMs ?? 4_000;

  let activePath = path;
  let cursor = fromByte;
  let lastActivity = Date.now();
  let lastPivotProbe = 0;
  // Candidate-end timestamp. When isTurnEnd matches we don't return
  // immediately — we record the time. If new frames arrive before
  // endDebounceMs elapses, we reset and keep going. Otherwise the
  // turn is genuinely over.
  let candidateEndAt: number | null = null;
  let aborted = false;

  const onAbort = () => { aborted = true; };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!aborted) {
      let size: number;
      try {
        size = (await stat(activePath)).size;
      } catch {
        size = 0;
      }

      if (size > cursor) {
        // Read the new chunk, split into lines, parse each.
        const chunk: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          const s = createReadStream(activePath, { start: cursor, end: size - 1 });
          s.on('data', (b) => { chunk.push(b as Buffer); });
          s.on('end', resolve);
          s.on('error', reject);
        });
        cursor = size;
        const text = Buffer.concat(chunk).toString('utf-8');
        // The last line may be partial. Process complete lines; hold
        // the remainder for the next poll.
        const lines = text.split('\n');
        const completed = text.endsWith('\n') ? lines : lines.slice(0, -1);
        const leftover = text.endsWith('\n') ? '' : (lines[lines.length - 1] ?? '');
        if (leftover.length > 0) {
          // Roll cursor back so we re-read the partial line next iter.
          cursor -= Buffer.byteLength(leftover, 'utf-8');
        }
        for (const line of completed) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          // Only assistant / user frames signal the agent is still working
          // and should reset a pending end-debounce. CC writes passive
          // boundary frames (system, attachment, file-history-snapshot,
          // last-prompt, permission-mode) right after the final response;
          // those must NOT reset the debounce or the turn never ends.
          const frameType = typeof frame.type === 'string' ? frame.type : '';
          const isActive = frameType === 'assistant' || frameType === 'user';
          if (isActive && candidateEndAt !== null) candidateEndAt = null;
          onFrame(frame);
          if (isTurnEnd(frame)) {
            if (endDebounceMs <= 0) return;
            candidateEndAt = Date.now();
          }
        }
        lastActivity = Date.now();
      } else {
        // No new bytes. If a candidate end is pending and the debounce
        // window has fully elapsed, the turn is truly over.
        if (candidateEndAt !== null && Date.now() - candidateEndAt >= endDebounceMs) {
          return;
        }
        // Pivot probe DISABLED 2026-05-18 — was grabbing heartbeat-spawned
        // JSONLs that landed in the same project_dir, splicing heartbeat
        // output into the active chat's persisted response. Heartbeats
        // fire every ~13min in each rascal's project_dir, each creating
        // a fresh CC session JSONL — exactly what newestJsonlSince picks up.
        //
        // The pivot was originally for /compact, but /compact is rare and
        // the cost of false positives (corrupted chat history, 100KB+
        // spurious assistant text) is much higher than losing /compact
        // recovery. Re-enable only with a strict guard: require the new
        // JSONL's first frame to declare itself a continuation of the
        // current cc_session_id (e.g. via summary.session_id link).
        //
        // Keeping the probe loop alive so we still notice file rotations,
        // just no auto-pivot.
        if (opts.projectDir && (Date.now() - lastPivotProbe) > pivotProbeMs) {
          lastPivotProbe = Date.now();
          // const newest = await newestJsonlSince(opts.projectDir, pivotSinceMs);
          // (intentionally no pivot — see comment above)
        }
        if (Date.now() - lastActivity > idleTimeout) {
          throw new Error(`tail timed out: no JSONL growth for ${idleTimeout}ms (active=${activePath})`);
        }
        await delay(pollMs);
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (aborted) {
    throw Object.assign(new Error('aborted'), { aborted: true });
  }
}

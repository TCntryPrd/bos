/**
 * rascal-files.ts — Path-safe file access scoped to a rascal's
 * projectDir. The Rascal Workspace's file tree + editor (v1.6.5) and
 * write endpoint (v1.6.6) both go through these helpers so the
 * security check lives in one place.
 *
 * Security model:
 *   - The query `path` is treated as relative-to-projectDir.
 *   - We `realpath` both the projectDir root and the resolved
 *     candidate, then assert the candidate is at or below the root.
 *     This catches `..` segments AND symlink escapes.
 *   - Binary files (null bytes in first 1KB) are rejected.
 *   - Reads above 1 MB are rejected.
 */
import { stat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';

export const MAX_READ_BYTES = 1_000_000;
export const BINARY_SNIFF_BYTES = 1024;

export class PathEscapeError extends Error {
  constructor(public readonly attemptedPath: string) {
    super(`path escapes project root: ${attemptedPath}`);
    this.name = 'PathEscapeError';
  }
}

export class FileTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`file too large: ${bytes} bytes (cap ${MAX_READ_BYTES})`);
    this.name = 'FileTooLargeError';
  }
}

export class BinaryFileError extends Error {
  constructor() {
    super('binary file rejected');
    this.name = 'BinaryFileError';
  }
}

export class IfMatchFailedError extends Error {
  constructor(public readonly currentEtag: string) {
    super('If-Match precondition failed');
    this.name = 'IfMatchFailedError';
  }
}

/**
 * Resolve a user-supplied relative path against a rascal's projectDir
 * and confirm it stays inside the root. Returns the absolute path.
 *
 * Throws PathEscapeError if the resolved path is outside projectDir
 * (including via `..` segments or symlinks).
 */
export async function safePath(projectDir: string, requestedRelative: string): Promise<string> {
  const root = await realpath(projectDir);
  const candidate = resolve(root, requestedRelative);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    // Not yet existing (e.g. a write target that doesn't exist) — fall
    // back to the lexical resolution. v1.6.6 may need this; for v1.6.5
    // reads, the caller will hit ENOENT downstream.
    resolved = candidate;
  }
  // path.relative returns '..'-prefixed when escaping; rooted path
  // means inside; empty string means equal to root.
  const rel = resolved === root ? '' : resolved.startsWith(root + sep) ? resolved.slice(root.length + 1) : '..';
  if (rel.startsWith('..')) {
    throw new PathEscapeError(requestedRelative);
  }
  return resolved;
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
  size: number | null;
  modifiedAt: string | null;
}

/**
 * List one directory level. Hides dotfiles other than `.boss` (the
 * agenda lives there) and `.gitignore` so the tree isn't dominated by
 * editor / VCS noise.
 */
export async function listDirectory(projectDir: string, requestedRelative: string): Promise<DirEntry[]> {
  const abs = await safePath(projectDir, requestedRelative || '.');
  const root = await realpath(projectDir);
  const entries = await readdir(abs, { withFileTypes: true });
  const visibleDotfiles = new Set(['.boss', '.gitignore', '.env.example', 'CLAUDE.md', 'SOUL.md']);
  const out: DirEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && !visibleDotfiles.has(e.name)) continue;
    const childAbs = join(abs, e.name);
    let size: number | null = null;
    let modifiedAt: string | null = null;
    let type: DirEntry['type'] = 'other';
    try {
      const s = await stat(childAbs);
      if (s.isDirectory()) type = 'directory';
      else if (s.isFile()) { type = 'file'; size = s.size; }
      modifiedAt = s.mtime.toISOString();
    } catch {
      /* dangling symlink or perms — skip stat */
    }
    out.push({
      name: e.name,
      path: childAbs.startsWith(root + sep) ? childAbs.slice(root.length + 1) : e.name,
      type,
      size,
      modifiedAt,
    });
  }
  // Directories first, then alphabetical.
  out.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'directory') return -1;
      if (b.type === 'directory') return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * The etag is the file's mtime in milliseconds-since-epoch as a string.
 * Same FS / same host so mtime is reliable; if a concurrent writer
 * touches the file, mtime advances and stale clients fail If-Match.
 */
function etagFor(s: { mtime: Date }): string {
  return String(s.mtime.getTime());
}

/**
 * Read a text file under the rascal's projectDir. Rejects files
 * larger than MAX_READ_BYTES or that look binary.
 */
export async function readTextFile(projectDir: string, requestedRelative: string): Promise<{ content: string; bytes: number; modifiedAt: string; etag: string }> {
  const abs = await safePath(projectDir, requestedRelative);
  const s = await stat(abs);
  if (!s.isFile()) throw new Error('not a file');
  if (s.size > MAX_READ_BYTES) throw new FileTooLargeError(s.size);
  const buf = await readFile(abs);
  // Binary sniff: any null byte in the first KB → reject.
  const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, buf.length));
  for (let i = 0; i < sniff.length; i++) {
    if (sniff[i] === 0) throw new BinaryFileError();
  }
  return {
    content: buf.toString('utf-8'),
    bytes: s.size,
    modifiedAt: s.mtime.toISOString(),
    etag: etagFor(s),
  };
}

/**
 * Write a text file under the rascal's projectDir, with optimistic
 * concurrency via If-Match. If `ifMatch` is provided and doesn't
 * match the current file's etag, throws IfMatchFailedError so the
 * route can return 412 with the live etag (frontend can then offer a
 * conflict resolution flow).
 *
 * Refuses to write a file >MAX_READ_BYTES (1 MB cap matches the read
 * side). Creates parent directories if needed (so writing
 * `.boss/agenda.md` works even when `.boss/` doesn't exist yet).
 */
export async function writeTextFile(
  projectDir: string,
  requestedRelative: string,
  content: string,
  ifMatch?: string,
): Promise<{ bytes: number; modifiedAt: string; etag: string }> {
  if (Buffer.byteLength(content, 'utf-8') > MAX_READ_BYTES) {
    throw new FileTooLargeError(Buffer.byteLength(content, 'utf-8'));
  }
  const abs = await safePath(projectDir, requestedRelative);
  if (ifMatch !== undefined) {
    try {
      const current = await stat(abs);
      const currentEtag = etagFor(current);
      if (currentEtag !== ifMatch) throw new IfMatchFailedError(currentEtag);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      // File doesn't exist yet — caller asserted "If-Match: <etag>"
      // implies the file existed; treat absence as a mismatch.
      if (ifMatch !== '') throw new IfMatchFailedError('');
    }
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  const s = await stat(abs);
  return {
    bytes: s.size,
    modifiedAt: s.mtime.toISOString(),
    etag: etagFor(s),
  };
}

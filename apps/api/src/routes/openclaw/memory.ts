import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const GIO_WORKSPACE = process.env.BOSS_GIO_WORKSPACE ?? '/home/tcntryprd/outsiders/gio';
const MEMORY_ROOT = path.join(GIO_WORKSPACE, 'memory');
const ALLOWED_ROOT_FILES = new Set(['MEMORY.md', 'AGENTS.md']);

function normalizeMemoryPath(name: string): string | null {
  const decoded = name.replace(/\\/g, '/');
  if (decoded.includes('..')) return null;
  if (ALLOWED_ROOT_FILES.has(decoded)) return path.join(GIO_WORKSPACE, decoded);
  if (!decoded.startsWith('memory/') || !decoded.endsWith('.md')) return null;
  const full = path.join(GIO_WORKSPACE, decoded);
  if (!full.startsWith(MEMORY_ROOT)) return null;
  return full;
}

async function listMarkdownFiles(dir: string, prefix: string): Promise<Array<{ name: string; size: number; mtime: number }>> {
  const out: Array<{ name: string; size: number; mtime: number }> = [];
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await listMarkdownFiles(full, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = await fs.stat(full);
      out.push({ name: rel, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return out;
}

export async function memoryRoute(server: FastifyInstance): Promise<void> {
  server.get('/api/openclaw/memory', async (_request, reply) => {
    const files = await listMarkdownFiles(GIO_WORKSPACE, '');
    return reply.send([{ agentId: 'gio', status: { backend: 'cognitive-memory-lite', files: files.length } }]);
  });

  server.get('/api/openclaw/memory/files', async (_request, reply) => {
    const files = await listMarkdownFiles(GIO_WORKSPACE, '');
    files.sort((a, b) => a.name.localeCompare(b.name));
    return reply.send({ files });
  });

  server.get<{ Params: { name: string } }>('/api/openclaw/memory/files/:name', async (request, reply) => {
    const full = normalizeMemoryPath(request.params.name);
    if (!full) return reply.status(400).send({ error: 'invalid-filename', name: request.params.name });
    try {
      const content = await fs.readFile(full, 'utf8');
      return reply.send({ name: request.params.name, content });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reply.status(404).send({ error: 'not-found', name: request.params.name });
      return reply.status(502).send({ error: 'read-failed', message: (err as Error).message });
    }
  });
}

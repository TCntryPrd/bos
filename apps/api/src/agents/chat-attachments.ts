/**
 * chat-attachments — shared attachment handling for the Claude (COO) and
 * Hermes (zucchi) chat backends. Mirrors the Codex/openclaw flow: decode each
 * uploaded file into a 0600 temp file under `rootDir`, then return a prompt
 * suffix that points the CLI at those paths (Claude bypass / Gemini
 * trust-workspace can read them directly).
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface IncomingAttachment {
  name?: string;
  mimeType?: string;
  dataUrl?: string;
  text?: string;
}

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

function safeName(name: string | undefined, index: number): string {
  const cleaned = (name || `attachment-${index}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return cleaned || `attachment-${index}`;
}

/**
 * Write attachments to a temp dir under rootDir and produce a prompt suffix
 * listing the absolute paths. Returns an empty suffix when nothing usable
 * arrived. Best-effort: a failure to write one file degrades to a note.
 */
export async function materializeAttachments(
  attachments: IncomingAttachment[] | undefined,
  rootDir: string,
): Promise<{ promptSuffix: string; tempDir: string | null }> {
  const incoming = (attachments ?? []).slice(0, MAX_ATTACHMENTS);
  if (incoming.length === 0) return { promptSuffix: '', tempDir: null };

  await mkdir(rootDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(rootDir, 'boss-chat-'));
  const notes: string[] = [];

  for (const [index, attachment] of incoming.entries()) {
    const name = safeName(attachment.name, index + 1);
    const mimeType = attachment.mimeType || 'application/octet-stream';
    try {
      if (attachment.dataUrl) {
        const comma = attachment.dataUrl.indexOf(',');
        const b64 = comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1);
        const bytes = Buffer.from(b64, 'base64');
        const maxBytes = mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (bytes.byteLength > maxBytes) {
          notes.push(`- ${name}: skipped, file exceeded ${Math.round(maxBytes / 1024 / 1024)}MB.`);
          continue;
        }
        const ext = path.extname(name) || (
          mimeType === 'image/png' ? '.png'
            : mimeType === 'image/webp' ? '.webp'
              : mimeType.startsWith('image/') ? '.jpg'
                : '.bin'
        );
        const filePath = path.join(tempDir, `${index + 1}-${name}${path.extname(name) ? '' : ext}`);
        await writeFile(filePath, bytes, { mode: 0o600 });
        notes.push(`- ${name} (${mimeType}, ${bytes.byteLength} bytes) at ${filePath} — read this path directly if relevant; do not quote sensitive contents back unless asked.`);
      } else if (typeof attachment.text === 'string' && attachment.text.trim()) {
        const bytes = Buffer.byteLength(attachment.text, 'utf8');
        if (bytes > MAX_FILE_BYTES) {
          notes.push(`- ${name}: skipped, text exceeded ${MAX_FILE_BYTES / 1024}KB.`);
          continue;
        }
        const filePath = path.join(tempDir, `${index + 1}-${name}${path.extname(name) ? '' : '.txt'}`);
        await writeFile(filePath, attachment.text, { mode: 0o600 });
        notes.push(`- ${name} (text, ${bytes} bytes) at ${filePath} — read this path directly if relevant.`);
      } else {
        notes.push(`- ${name}: metadata only (${mimeType}); no readable payload arrived.`);
      }
    } catch {
      notes.push(`- ${name}: failed to store on the server.`);
    }
  }

  const promptSuffix = notes.length > 0
    ? `\n\nAttached files from the operator:\n${notes.join('\n')}`
    : '';
  return { promptSuffix, tempDir };
}

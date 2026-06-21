/**
 * attachments — shared chat file-attachment helpers for the Claude (COO) and
 * Hermes composers. Mirrors the Codex composer: read picked files into data
 * URLs, cap at 4, enforce size limits.
 */

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export const MAX_ATTACHMENTS = 4;

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / 1024 / 1024).toFixed(1)}m`;
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

/** Convert a FileList into PendingAttachments, honoring the remaining slots + size caps. */
export async function filesToAttachments(files: FileList, existingCount: number): Promise<PendingAttachment[]> {
  const slots = Math.max(0, MAX_ATTACHMENTS - existingCount);
  const selected = Array.from(files).slice(0, slots);
  const out: PendingAttachment[] = [];
  for (const file of selected) {
    const maxBytes = file.type.startsWith('image/') ? 8 * 1024 * 1024 : 512 * 1024;
    if (file.size > maxBytes) throw new Error(`${file.name} is larger than ${bytesLabel(maxBytes)}`);
    out.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: await readFileDataUrl(file),
    });
  }
  return out;
}

/** Strip the heavy dataUrl down to what the API needs. */
export function toWire(a: PendingAttachment): { name: string; mimeType: string; dataUrl: string } {
  return { name: a.name, mimeType: a.mimeType, dataUrl: a.dataUrl };
}

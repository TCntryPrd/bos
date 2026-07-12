/**
 * Shared SSE consumer for `POST /api/coo/threads/:id/chat`.
 *
 * Used by both the COO surface (ChatPane) and the global BossOrb so they
 * share one battle-tested stream parser. Parses `event: frame` (raw
 * stream-json passthrough) and aggregates assistant text blocks.
 */

interface StreamFrame {
  type?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
}

export interface StreamCooChatOptions {
  threadId: string;
  message: string;
  attachments?: Array<{ name: string; mimeType: string; dataUrl: string }>;
  authToken?: string;
  onAssistantText: (aggregate: string) => void;
  onDone?: () => void;
  onError?: (msg: string) => void;
  signal?: AbortSignal;
}

export async function streamCooChat(opts: StreamCooChatOptions): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;

  const res = await fetch(`api/coo/threads/${opts.threadId}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: opts.message, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }),
    signal: opts.signal,
  });
  if (!res.body) throw new Error('no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;
  let aggregate = '';

  while (!done) {
    const r = await reader.read();
    done = r.done;
    if (!r.value) continue;
    buf += decoder.decode(r.value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const lines = event.split('\n');
      let evType = '';
      let dataStr = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) evType = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
      }
      if (evType === 'frame' && dataStr) {
        try {
          const frame = JSON.parse(dataStr) as StreamFrame;
          if (frame.type === 'assistant') {
            for (const block of frame.message?.content ?? []) {
              if (block.type === 'text' && block.text) aggregate += block.text;
            }
            opts.onAssistantText(aggregate);
          }
        } catch {
          /* skip malformed */
        }
      } else if (evType === 'done') {
        opts.onDone?.();
      } else if (evType === 'error' && dataStr) {
        opts.onError?.(dataStr);
      }
    }
  }
}

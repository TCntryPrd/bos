interface OfficeThread {
  id: string;
  conversationId?: string;
  title: string;
  lastUser: string;
  lastAssistant: string;
  updatedAt: number;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

// One attachment sent alongside a message. Images -> dataUrl (base64), text
// files -> text. Shape mirrors the /api/openclaw/chat backend contract.
export interface OfficeAttachment {
  name?: string;
  mimeType?: string;
  dataUrl?: string;
  text?: string;
}

export interface StreamOfficeEaChatOptions {
  message: string;
  attachments?: OfficeAttachment[];
  onAssistantText: (aggregate: string) => void;
  onDone?: () => void;
  onError?: (msg: string) => void;
  signal?: AbortSignal;
}

const THREADS_KEY = 'boss_office_threads_v1';
const ACTIVE_THREAD_KEY = 'boss_office_active_thread_v1';
const OFFICE_THREADS_UPDATED_EVENT = 'boss-office-threads-updated';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function loadThreads(): OfficeThread[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(THREADS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Office conversation';
  return clean.length > 48 ? `${clean.slice(0, 45)}...` : clean;
}

function buildOfficeInstruction(text: string): string {
  const request = text.trim() || 'Review the attached files or screenshots and use them as context.';
  return [
    "You are the Executive Assistant in the owner's Office inside BOS.",
    'Speak as one EA coordinating work, not as Claude, Codex, Hermes, Gio, or a developer console.',
    'For every request: clarify only if needed, decide the next useful step, route work to BOS tools or specialist agents when appropriate, and report the handoff or result in plain executive language.',
    'If the request is planning or brainstorming, stay in conversation and structure the thinking. If it is execution, create or route concrete next actions.',
    'Start the final response with a section exactly titled "Voice summary:" followed by 1-3 concise, human spoken sentences.',
    'Do not read out internal reasoning, tool use, commands, logs, or implementation play-by-play. The Voice summary should say what was done, what changed, and any result the CEO needs.',
    '',
    `CEO request: ${request}`,
  ].join('\n');
}

function dispatchOfficeThreadsUpdated(): void {
  window.dispatchEvent(new Event(OFFICE_THREADS_UPDATED_EVENT));
}

function updateOfficeThread(patch: Partial<OfficeThread>): OfficeThread {
  const threads = loadThreads();
  const activeThreadId = localStorage.getItem(ACTIVE_THREAD_KEY) || '';
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
  const base: OfficeThread = activeThread ?? {
    id: `office-${Date.now()}`,
    title: 'Office conversation',
    lastUser: '',
    lastAssistant: '',
    updatedAt: Date.now(),
  };
  const nextThread = { ...base, ...patch, updatedAt: Date.now() };
  const clipped = [
    nextThread,
    ...threads.filter((thread) => thread.id !== nextThread.id),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);

  localStorage.setItem(THREADS_KEY, JSON.stringify(clipped));
  localStorage.setItem(ACTIVE_THREAD_KEY, nextThread.id);
  dispatchOfficeThreadsUpdated();
  return nextThread;
}

function parseSseEvents(chunk: string): SseEvent[] {
  return chunk
    .split('\n\n')
    .map((block) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) return null;
      try {
        return { event, data: JSON.parse(data) as Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SseEvent => entry !== null);
}

export async function streamOfficeEaChat(opts: StreamOfficeEaChatOptions): Promise<void> {
  const visibleUserText = opts.message.trim();
  let thread = updateOfficeThread({
    title: titleFrom(visibleUserText),
    lastUser: visibleUserText,
  });

  const res = await fetch('api/openclaw/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      message: buildOfficeInstruction(visibleUserText),
      conversationId: thread.conversationId,
      newConversation: !thread.conversationId,
      attachments: opts.attachments ?? [],
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Office request failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aggregate = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf('\n\n');
    if (boundary === -1) continue;
    const complete = buffer.slice(0, boundary + 2);
    buffer = buffer.slice(boundary + 2);
    for (const item of parseSseEvents(complete)) {
      if (item.event === 'conversation' && typeof item.data.conversationId === 'string') {
        thread = updateOfficeThread({ conversationId: item.data.conversationId });
      }
      if (item.event === 'message' && typeof item.data.text === 'string') {
        aggregate += item.data.text;
        opts.onAssistantText(aggregate);
        updateOfficeThread({ conversationId: thread.conversationId, lastAssistant: aggregate });
      }
      if (item.event === 'error') {
        const detail = String(item.data.message ?? item.data.stderrTail ?? 'Office turn failed');
        updateOfficeThread({ lastAssistant: detail });
        opts.onError?.(detail);
      }
    }
  }

  const finalText = aggregate.trim() || 'Done.';
  updateOfficeThread({ conversationId: thread.conversationId, lastAssistant: finalText });
  opts.onDone?.();
}

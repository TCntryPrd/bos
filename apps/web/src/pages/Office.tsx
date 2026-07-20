import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  History,
  Image as ImageIcon,
  Mic,
  MicOff,
  Paperclip,
  Phone,
  PhoneIncoming,
  Plus,
  Radio,
  Send,
  UserRound,
  Volume2,
  X,
} from 'lucide-react';
import { humanizeSpokenBrief } from '../lib/spokenBrief';

type SpeechRecognitionAlternative = { transcript: string };
type SpeechRecognitionResult = { isFinal: boolean; 0: SpeechRecognitionAlternative };
type SpeechRecognitionResultList = { length: number; [index: number]: SpeechRecognitionResult };
type SpeechRecognitionEventLike = { resultIndex: number; results: SpeechRecognitionResultList };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  abort: () => void;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

interface OfficeThread {
  id: string;
  conversationId?: string;
  title: string;
  lastUser: string;
  lastAssistant: string;
  updatedAt: number;
}

interface TwilioStatus {
  configured: boolean;
  accountSidConfigured: boolean;
  apiKeySidConfigured: boolean;
  outboundReady: boolean;
  allowedCaller: string | null;
  inboundWebhookPath: string;
}

interface OfficeAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  text?: string;
}

const THREADS_KEY = 'boss_office_threads_v1';
const ACTIVE_THREAD_KEY = 'boss_office_active_thread_v1';
const AVATAR_KEY = 'boss_office_avatar_v1';
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const IMAGE_FILE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i;
const TEXT_FILE_EXTENSIONS = /\.(txt|md|csv|json|log|html|css|js|jsx|ts|tsx|py|sql|xml|yaml|yml)$/i;

const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

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

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isTextFile(file: File): boolean {
  return file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/xml' ||
    file.type === 'application/yaml' ||
    TEXT_FILE_EXTENSIONS.test(file.name);
}

function inferMimeType(file: File): string {
  if (file.type) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  if (TEXT_FILE_EXTENSIONS.test(file.name)) return 'text/plain';
  return 'application/octet-stream';
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXTENSIONS.test(file.name);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

async function fileToOfficeAttachment(file: File): Promise<OfficeAttachment> {
  const mimeType = inferMimeType(file);
  const image = isImageFile(file);
  const maxBytes = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (file.size > maxBytes) {
    throw new Error(`${file.name} is larger than ${formatFileSize(maxBytes)}.`);
  }
  const base = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    mimeType,
    size: file.size,
  };
  if (image) {
    return { ...base, dataUrl: await readFileAsDataUrl(file) };
  }
  if (isTextFile(file)) {
    return { ...base, text: await readFileAsText(file) };
  }
  return { ...base, dataUrl: await readFileAsDataUrl(file) };
}

function parseSseEvents(chunk: string): Array<{ event: string; data: Record<string, unknown> }> {
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
    .filter((entry): entry is { event: string; data: Record<string, unknown> } => entry !== null);
}

export default function Office() {
  const [threads, setThreads] = useState<OfficeThread[]>(() => loadThreads());
  const [activeThreadId, setActiveThreadId] = useState(() => localStorage.getItem(ACTIVE_THREAD_KEY) || '');
  const [avatar, setAvatar] = useState(() => localStorage.getItem(AVATAR_KEY) || '');
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [assistantText, setAssistantText] = useState('I am here.');
  const [activity, setActivity] = useState<string[]>(['Office opened']);
  const [twilio, setTwilio] = useState<TwilioStatus | null>(null);
  const [attachments, setAttachments] = useState<OfficeAttachment[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? threads[0] ?? null,
    [activeThreadId, threads],
  );

  const persistThreads = useCallback((next: OfficeThread[]) => {
    const clipped = next
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    setThreads(clipped);
    localStorage.setItem(THREADS_KEY, JSON.stringify(clipped));
    if (clipped[0]) {
      setActiveThreadId(clipped[0].id);
      localStorage.setItem(ACTIVE_THREAD_KEY, clipped[0].id);
    }
  }, []);

  const pushActivity = useCallback((label: string) => {
    setActivity((prev) => [`${formatTime(Date.now())}  ${label}`, ...prev].slice(0, 8));
  }, []);

  useEffect(() => {
    const syncOfficeThreads = () => {
      setThreads(loadThreads());
      setActiveThreadId(localStorage.getItem(ACTIVE_THREAD_KEY) || '');
    };
    window.addEventListener('storage', syncOfficeThreads);
    window.addEventListener('boss-office-threads-updated', syncOfficeThreads);
    return () => {
      window.removeEventListener('storage', syncOfficeThreads);
      window.removeEventListener('boss-office-threads-updated', syncOfficeThreads);
    };
  }, []);

  useEffect(() => {
    fetch('api/voice/twilio/status', { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setTwilio(data as TwilioStatus | null))
      .catch(() => setTwilio(null));
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      audioRef.current?.pause();
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  const createThread = useCallback(() => {
    const thread: OfficeThread = {
      id: `office-${Date.now()}`,
      title: 'New Office conversation',
      lastUser: '',
      lastAssistant: 'Ready',
      updatedAt: Date.now(),
    };
    persistThreads([thread, ...threads]);
    setTranscript('');
    setInterim('');
    setAssistantText('I am ready.');
    pushActivity('New conversation');
  }, [persistThreads, pushActivity, threads]);

  const startListening = useCallback(() => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      pushActivity('Speech recognition unavailable');
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (finalText.trim()) setTranscript((prev) => `${prev}${prev ? ' ' : ''}${finalText.trim()}`);
      setInterim(interimText.trim());
    };
    recognition.onerror = () => {
      setListening(false);
      pushActivity('Microphone stopped');
    };
    recognition.onend = () => {
      setListening(false);
      setInterim('');
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
    pushActivity('Listening');
  }, [pushActivity]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
    setInterim('');
    pushActivity('Captured voice');
  }, [pushActivity]);

  const browserSpeak = useCallback((text: string) => {
    const brief = humanizeSpokenBrief(text);
    if (!window.speechSynthesis || !brief) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(brief.slice(0, 1200));
    utterance.rate = 0.96;
    utterance.pitch = 0.95;
    window.speechSynthesis.speak(utterance);
  }, []);

  const speak = useCallback(async (text: string) => {
    const clean = humanizeSpokenBrief(text);
    if (!clean) return;
    try {
      const res = await fetch('api/tts/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          text: clean,
          surface: 'office',
          handle: 'office',
          displayName: 'Office EA',
          title: 'Executive Assistant',
        }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      audioRef.current?.pause();
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      audioRef.current = audio;
      await audio.play();
    } catch {
      browserSpeak(clean);
    }
  }, [browserSpeak]);

  const updateCurrentThread = useCallback((patch: Partial<OfficeThread>) => {
    const base = activeThread ?? {
      id: `office-${Date.now()}`,
      title: 'Office conversation',
      lastUser: '',
      lastAssistant: '',
      updatedAt: Date.now(),
    };
    const nextThread = { ...base, ...patch, updatedAt: Date.now() };
    const others = threads.filter((thread) => thread.id !== nextThread.id);
    persistThreads([nextThread, ...others]);
    return nextThread;
  }, [activeThread, persistThreads, threads]);

  const addAttachments = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (slots === 0) {
      pushActivity('Attachment limit reached');
      return;
    }
    const picked = files.slice(0, slots);
    const accepted: OfficeAttachment[] = [];
    for (const file of picked) {
      try {
        accepted.push(await fileToOfficeAttachment(file));
      } catch (err) {
        pushActivity(err instanceof Error ? err.message : 'Attachment skipped');
      }
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
      pushActivity(accepted.length === 1 ? 'Attachment added' : `${accepted.length} attachments added`);
    }
    if (files.length > picked.length) pushActivity('Attachment limit reached');
  }, [attachments.length, pushActivity]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) void addAttachments(files);
    };
    const handleDragOver = (event: DragEvent) => {
      if ((event.dataTransfer?.files.length ?? 0) > 0) event.preventDefault();
    };
    const handleDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void addAttachments(files);
    };
    window.addEventListener('paste', handlePaste);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [addAttachments]);

  const sendToEa = useCallback(async () => {
    const spoken = transcript.trim();
    if ((!spoken && attachments.length === 0) || sending) return;
    setSending(true);
    setAssistantText('');
    pushActivity('EA coordinating');
    const outboundAttachments = attachments.map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataUrl: attachment.dataUrl,
      text: attachment.text,
    }));
    const visibleUserText = spoken || 'Attached files';
    let thread = updateCurrentThread({ title: titleFrom(visibleUserText), lastUser: visibleUserText });
    if (outboundAttachments.length > 0) {
      pushActivity(`Sending ${outboundAttachments.length} attachment${outboundAttachments.length === 1 ? '' : 's'}`);
    }

    try {
      const res = await fetch('api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          message: buildOfficeInstruction(spoken),
          conversationId: thread.conversationId,
          newConversation: !thread.conversationId,
          attachments: outboundAttachments,
        }),
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
            thread = updateCurrentThread({ conversationId: item.data.conversationId });
          }
          if (item.event === 'attachment') {
            const count = Number(item.data.count ?? 0);
            const imageCount = Number(item.data.imageCount ?? 0);
            if (count > 0) {
              pushActivity(imageCount > 0 ? `Server received ${imageCount} image${imageCount === 1 ? '' : 's'}` : `Server received ${count} file${count === 1 ? '' : 's'}`);
            }
          }
          if (item.event === 'message' && typeof item.data.text === 'string') {
            aggregate += item.data.text;
            setAssistantText(aggregate);
            updateCurrentThread({ conversationId: thread.conversationId, lastAssistant: aggregate });
          }
          if (item.event === 'error') {
            const detail = String(item.data.message ?? item.data.stderrTail ?? 'Office turn failed');
            setAssistantText(detail);
            updateCurrentThread({ lastAssistant: detail });
          }
        }
      }
      const finalText = aggregate.trim() || 'Done.';
      setAssistantText(finalText);
      updateCurrentThread({ conversationId: thread.conversationId, lastAssistant: finalText });
      void speak(finalText);
      setTranscript('');
      setInterim('');
      setAttachments([]);
      pushActivity('EA responded');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setAssistantText(detail);
      updateCurrentThread({ lastAssistant: detail });
      pushActivity('Office request failed');
    } finally {
      setSending(false);
    }
  }, [attachments, pushActivity, sending, speak, transcript, updateCurrentThread]);

  const callOwner = useCallback(async () => {
    const res = await fetch('api/voice/twilio/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: 'This is your Office EA calling from BOS.' }),
    });
    if (res.ok) pushActivity('Call started');
    else pushActivity('Call not ready');
  }, [pushActivity]);

  const saveAvatar = useCallback((file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      setAvatar(value);
      localStorage.setItem(AVATAR_KEY, value);
      pushActivity('Avatar updated');
    };
    reader.readAsDataURL(file);
  }, [pushActivity]);

  const phoneReady = !!twilio?.configured;
  const outboundReady = !!twilio?.outboundReady;

  return (
    <div className="relative h-full min-h-0 overflow-hidden text-[#f6f1e8]">
      <div className="absolute inset-0 bg-gradient-to-r from-black/34 via-black/0 to-black/18" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/48 to-transparent" />

      <main className="office-room-grid relative z-10 grid h-full min-h-0 gap-3 overflow-x-hidden overflow-y-auto p-3 lg:overflow-hidden">
        <aside className="min-h-0 space-y-3 overflow-y-auto">
          <section className="aios-frost-surface--dark rounded-lg border border-white/16 bg-black/42 p-3 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="h-16 w-16 overflow-hidden rounded-lg border border-white/20 bg-white/10"
                onClick={() => avatarInputRef.current?.click()}
                title="Add avatar"
              >
                {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : <UserRound className="m-auto mt-4 h-8 w-8 text-white/70" />}
              </button>
              <div className="min-w-0">
                <div className="text-sm font-semibold">Office</div>
                <div className="text-xs text-white/62">Executive Assistant</div>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/72">
                  <span className={`h-2 w-2 rounded-full ${phoneReady ? 'bg-emerald-400' : 'bg-amber-300'}`} />
                  <span>{phoneReady ? 'Phone connected' : 'Phone pending'}</span>
                </div>
              </div>
            </div>
            <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => saveAvatar(e.target.files?.[0] ?? null)} />
          </section>

          <section className="aios-frost-surface--dark rounded-lg border border-white/16 bg-black/42 p-3 backdrop-blur-md">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold"><History className="h-4 w-4" /> Conversations</div>
              <button type="button" onClick={createThread} className="rounded-md border border-white/14 p-1.5 text-white/78" title="New conversation">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-2">
              {threads.length === 0 ? (
                <div className="rounded-lg border border-white/10 bg-white/8 p-3 text-xs text-white/58">No recent conversations</div>
              ) : threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => {
                    setActiveThreadId(thread.id);
                    localStorage.setItem(ACTIVE_THREAD_KEY, thread.id);
                    setAssistantText(thread.lastAssistant || 'Ready.');
                    setTranscript('');
                  }}
                  className={`w-full rounded-lg border p-2 text-left ${thread.id === activeThread?.id ? 'border-emerald-300/60 bg-emerald-300/12' : 'border-white/10 bg-white/8'}`}
                >
                  <div className="truncate text-xs font-medium">{thread.title}</div>
                  <div className="mt-1 truncate text-[11px] text-white/56">{thread.lastAssistant || thread.lastUser || 'Ready'}</div>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="flex min-h-0 flex-col justify-end">
          <div className="aios-frost-surface--dark mb-3 max-w-3xl rounded-lg border border-white/16 bg-black/38 p-4 shadow-2xl backdrop-blur-md">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-white/78">
              <Radio className="h-4 w-4 text-emerald-300" />
              Live Office
            </div>
            <div className="min-h-[110px] whitespace-pre-wrap text-[15px] leading-relaxed text-white/88">
              {assistantText || (sending ? 'Coordinating...' : 'I am here.')}
            </div>
          </div>

          <div className="aios-frost-surface--dark max-w-3xl rounded-lg border border-white/16 bg-[#0d1114]/86 p-3 shadow-2xl backdrop-blur-xl">
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendToEa();
                }
              }}
              placeholder="Speak or type to your EA."
              disabled={sending}
              className="mb-3 h-[78px] w-full resize-none overflow-y-auto rounded-lg border border-white/10 bg-white/8 p-3 text-sm leading-relaxed text-white/82 placeholder:text-white/45 focus:border-emerald-300/50 focus:outline-none disabled:opacity-60"
            />
            {interim && (
              <div className="-mt-2 mb-3 px-1 text-xs text-white/45">{interim}</div>
            )}
            {attachments.length > 0 && (
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                {attachments.map((attachment) => {
                  const image = attachment.mimeType.startsWith('image/');
                  return (
                    <div key={attachment.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/8 p-2">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/20">
                        {image && attachment.dataUrl ? (
                          <img src={attachment.dataUrl} alt="" className="h-full w-full object-cover" />
                        ) : image ? (
                          <ImageIcon className="h-5 w-5 text-white/68" />
                        ) : (
                          <FileText className="h-5 w-5 text-white/68" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-white/82">{attachment.name}</div>
                        <div className="text-[11px] text-white/50">{formatFileSize(attachment.size)}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(attachment.id)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/8 text-white/66 hover:text-white"
                        title="Remove attachment"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={listening ? stopListening : startListening}
                className={`h-12 w-12 rounded-lg border flex items-center justify-center ${listening ? 'border-red-300/70 bg-red-500/20 text-red-100' : 'border-emerald-300/70 bg-emerald-400/18 text-emerald-100'}`}
                title={listening ? 'Stop listening' : 'Start listening'}
              >
                {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>
              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={attachments.length >= MAX_ATTACHMENTS || sending}
                className="h-12 w-12 rounded-lg border border-white/14 bg-white/10 text-white/78 disabled:opacity-35 flex items-center justify-center"
                title="Add files"
              >
                <Paperclip className="h-5 w-5" />
              </button>
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.csv,.json,.log,.pdf,.html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.xml,.yaml,.yml"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.currentTarget.value = '';
                  void addAttachments(files);
                }}
              />
              <button
                type="button"
                onClick={sendToEa}
                disabled={(!transcript.trim() && attachments.length === 0) || sending}
                className="h-12 w-12 rounded-lg bg-emerald-500 text-white disabled:opacity-35 flex items-center justify-center"
                title="Send to EA"
              >
                <Send className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => void speak(assistantText)}
                disabled={!assistantText.trim()}
                className="h-12 w-12 rounded-lg border border-white/14 bg-white/10 text-white/78 disabled:opacity-35 flex items-center justify-center"
                title="Read response"
              >
                <Volume2 className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setTranscript('');
                  setInterim('');
                  setAttachments([]);
                }}
                disabled={!transcript && !interim && attachments.length === 0}
                className="ml-auto rounded-lg border border-white/14 px-3 py-2 text-xs text-white/68 disabled:opacity-35"
              >
                Clear
              </button>
            </div>
          </div>
        </section>

        <aside className="min-h-0 space-y-3 overflow-y-auto">
          <section className="aios-frost-surface--dark rounded-lg border border-white/16 bg-black/42 p-3 backdrop-blur-md">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold"><PhoneIncoming className="h-4 w-4" /> Phone</div>
            <div className="space-y-2 text-xs text-white/68">
              <div className="flex items-center justify-between"><span>Inbound</span><span className={phoneReady ? 'text-emerald-300' : 'text-amber-200'}>{phoneReady ? 'ready' : 'pending'}</span></div>
              <div className="flex items-center justify-between"><span>Outbound</span><span className={outboundReady ? 'text-emerald-300' : 'text-amber-200'}>{outboundReady ? 'ready' : 'needs number'}</span></div>
              <div className="flex items-center justify-between"><span>Caller</span><span>{twilio?.allowedCaller || 'Coming Soon'}</span></div>
            </div>
            <button
              type="button"
              onClick={callOwner}
              disabled={!outboundReady}
              className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-white/12 text-xs text-white/82 disabled:opacity-35"
            >
              <Phone className="h-4 w-4" /> Call
            </button>
          </section>

          <section className="aios-frost-surface--dark rounded-lg border border-white/16 bg-black/42 p-3 backdrop-blur-md">
            <div className="mb-3 text-xs font-semibold">History</div>
            <div className="space-y-2">
              {activity.map((item) => (
                <div key={item} className="rounded-lg border border-white/10 bg-white/8 px-2 py-1.5 text-[11px] text-white/62">
                  {item}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

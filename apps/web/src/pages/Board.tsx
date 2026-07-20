import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Users,
  Video,
  Volume2,
} from 'lucide-react';
import VideoRoom from '../components/VideoRoom';

interface AdvisorAi { model_label: string | null; model_display?: string; voice_id: string | null }
interface Advisor {
  id: string; type: 'ai' | 'human'; display_name: string; title: string | null;
  bio: string | null; avatar_image_url: string | null; seat_index: number | null;
  ai?: AdvisorAi | null; zoom_join_url?: string | null;
}
interface BoardMsg { id: number; author_type: 'user' | 'advisor'; author_name: string | null; body: string; created_at: string }
interface MeetingResult {
  meetingId: string; topic: string;
  turns: { advisorId: string; name: string; title: string; model: string; text: string }[];
  minutes: string; decisions: string[]; tasks: string[];
}

type VoiceMode = 'advisor' | 'meeting' | 'add';
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

const MODEL_OPTIONS: [string, string][] = [
  ['google/gemini-2.5-flash', 'Gemini'],
  ['deepseek/deepseek-v3.2', 'DeepSeek'],
  ['moonshotai/kimi-k2.6', 'Kimi'],
  ['z-ai/glm-4.6', 'GLM'],
  ['x-ai/grok-2-1212', 'Grok'],
  ['qwen/qwen-2.5-72b-instruct', 'Qwen'],
];

const TABLE_CENTER_LEFT = '44.5%';

const SEAT_POSITIONS = [
  { left: TABLE_CENTER_LEFT, top: '37%', scale: 0.58 },
  { left: '31%', top: '45%', scale: 0.68 },
  { left: '67%', top: '45%', scale: 0.68 },
  { left: '20%', top: '59%', scale: 0.8 },
  { left: '81%', top: '58%', scale: 0.8 },
  { left: '8%', top: '70%', scale: 0.95 },
  { left: '94%', top: '69%', scale: 0.95 },
];

const token = () => localStorage.getItem('boss_token') ?? '';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return res.json() as Promise<T>;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
}

function avatarGradient(seed: string): string {
  const palettes = [
    'linear-gradient(135deg,#3A7D44,#D9A441)',
    'linear-gradient(135deg,#8E3B46,#D9A441)',
    'linear-gradient(135deg,#2F5D7C,#C9A66B)',
    'linear-gradient(135deg,#3D405B,#81B29A)',
    'linear-gradient(135deg,#7A4E2D,#C1666B)',
    'linear-gradient(135deg,#164A41,#F1B24A)',
  ];
  let h = 0;
  for (const char of seed) h = (h * 31 + char.charCodeAt(0)) | 0;
  return palettes[Math.abs(h) % palettes.length];
}

function orderedAdvisors(list: Advisor[]): Advisor[] {
  return list
    .map((advisor, index) => ({ advisor, index }))
    .sort((a, b) => {
      const aSeat = a.advisor.seat_index ?? 999;
      const bSeat = b.advisor.seat_index ?? 999;
      return aSeat === bSeat ? a.index - b.index : aSeat - bSeat;
    })
    .map((entry) => entry.advisor);
}

function normalizeWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|miss|prof)\.?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function advisorAliases(advisor: Advisor): string[] {
  const name = normalizeWords(advisor.display_name);
  const parts = name.split(' ').filter(Boolean);
  const aliases = [
    name,
    parts[0] ?? '',
    parts.length > 1 ? parts[parts.length - 1] : '',
    normalizeWords(advisor.title ?? ''),
  ].filter((value) => value.length > 1);
  return Array.from(new Set(aliases)).sort((a, b) => b.length - a.length);
}

function resolveSpokenAdvisor(text: string, current: Advisor | null, list: Advisor[]): { advisor: Advisor | null; message: string } {
  if (current) return { advisor: current, message: text };
  const normalized = ` ${normalizeWords(text)} `;
  for (const advisor of list) {
    const match = advisorAliases(advisor).find((alias) => normalized.includes(` ${alias} `));
    if (!match) continue;
    const cleanup = new RegExp(`^\\s*(ask|tell|message|talk to|speak to)?\\s*${match.replace(/\s+/g, '\\s+')}\\s*(to|about|,|:|-)?\\s*`, 'i');
    return { advisor, message: text.replace(cleanup, '').trim() || text };
  }
  return { advisor: null, message: text };
}

function getRecognition(): SpeechRecognitionCtor | null {
  const speechWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function browserSpeak(text: string) {
  if (!window.speechSynthesis || !text.trim()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1200));
  utterance.rate = 0.96;
  utterance.pitch = 0.95;
  window.speechSynthesis.speak(utterance);
}

function Seat({
  advisor,
  selected,
  speaking,
  onClick,
  position,
}: {
  advisor: Advisor;
  selected: boolean;
  speaking: boolean;
  onClick: () => void;
  position: typeof SEAT_POSITIONS[number];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute flex flex-col items-center gap-1.5 transition-transform hover:scale-105 focus:outline-none"
      style={{
        left: position.left,
        top: position.top,
        transform: `translate(-50%, -50%) scale(${position.scale})`,
        zIndex: 5,
      }}
      title={advisor.display_name}
    >
      <div
        className="relative grid w-[168px] place-items-center overflow-hidden rounded-lg border bg-black/40 text-lg font-semibold text-white shadow-2xl backdrop-blur-sm"
        style={{
          aspectRatio: '3 / 4',
          background: advisor.avatar_image_url ? '#0d1114' : avatarGradient(`${advisor.display_name}${advisor.title ?? ''}${advisor.bio ?? ''}`),
          borderColor: selected ? 'rgba(94, 234, 212, 0.85)' : speaking ? 'rgba(52, 211, 153, 0.9)' : 'rgba(255,255,255,0.3)',
          boxShadow: selected
            ? '0 0 0 3px rgba(94,234,212,0.3), 0 22px 42px rgba(0,0,0,0.5)'
            : speaking
              ? '0 0 0 3px rgba(52,211,153,0.26), 0 22px 42px rgba(0,0,0,0.5)'
              : '0 18px 38px rgba(0,0,0,0.45)',
        }}
      >
        {advisor.avatar_image_url ? (
          <img
            src={advisor.avatar_image_url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-black/10 p-2 text-center">
            <div className="text-xl font-semibold">{initials(advisor.display_name)}</div>
            {advisor.title && <div className="mt-1 line-clamp-2 text-[8px] font-medium leading-tight text-white/72">{advisor.title}</div>}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/70 to-transparent" />
      </div>
      <div className="aios-frost-surface--dark max-w-[180px] rounded-md border border-white/14 bg-black/64 px-2.5 py-1 text-center text-[11px] font-medium leading-tight text-white/88 shadow-xl backdrop-blur-md">
        <div className="truncate">{advisor.display_name}</div>
        {advisor.title && <div className="truncate text-[9px] text-white/58">{advisor.title}</div>}
      </div>
    </button>
  );
}

function EmptySeat({
  onClick,
  position,
}: {
  onClick: () => void;
  position: typeof SEAT_POSITIONS[number];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute flex flex-col items-center gap-1.5 transition-transform hover:scale-105 focus:outline-none"
      style={{
        left: position.left,
        top: position.top,
        transform: `translate(-50%, -50%) scale(${position.scale})`,
        zIndex: 4,
      }}
      title="Add advisor by voice"
    >
      <div
        className="grid w-[158px] place-items-center rounded-lg border border-dashed border-white/34 bg-black/26 text-white/72 shadow-xl backdrop-blur-sm"
        style={{ aspectRatio: '3 / 4' }}
      >
        <Plus className="h-6 w-6" />
      </div>
      <div className="rounded-md border border-white/12 bg-black/46 px-2 py-0.5 text-[10px] text-white/62 backdrop-blur-md">
        Add
      </div>
    </button>
  );
}

export default function Board() {
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [boardName, setBoardName] = useState('Advisory Board');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BoardMsg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('advisor');
  const [listening, setListening] = useState(false);
  const [speechText, setSpeechText] = useState('');
  const [interim, setInterim] = useState('');
  const [aiModel, setAiModel] = useState(MODEL_OPTIONS[0][0]);
  const [meetingRunning, setMeetingRunning] = useState(false);
  const [meeting, setMeeting] = useState<MeetingResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => advisors.find((advisor) => advisor.id === selectedId) ?? null, [advisors, selectedId]);
  const visibleAdvisors = orderedAdvisors(advisors).slice(0, SEAT_POSITIONS.length);
  // Keep the boardroom scene clear; advisors are added from the header control.
  const emptySeatCount = 0;

  const loadBoard = useCallback(() => {
    api<{ board: { name: string } | null; advisors: Advisor[] }>('api/board')
      .then((data) => {
        setAdvisors(orderedAdvisors(data.advisors ?? []));
        if (data.board?.name) setBoardName(data.board.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadBoard();
    const timer = window.setInterval(loadBoard, 9000);
    return () => window.clearInterval(timer);
  }, [loadBoard]);
  useEffect(() => () => {
    recognitionRef.current?.abort();
    audioRef.current?.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, thinking]);
  useEffect(() => {
    if (!selectedId) return;
    if (!advisors.some((advisor) => advisor.id === selectedId)) {
      setSelectedId(null);
      setMessages([]);
    }
  }, [advisors, selectedId]);

  const pick = useCallback((advisor: Advisor) => {
    setSelectedId(advisor.id);
    setMessages([]);
    setVoiceMode('advisor');
    setSpeechText('');
    setInterim('');
    api<{ messages: BoardMsg[] }>(`api/board/advisors/${advisor.id}/messages`)
      .then((data) => setMessages(data.messages ?? []))
      .catch(() => {});
  }, []);

  const startListening = useCallback((mode: VoiceMode) => {
    const Recognition = getRecognition();
    if (!Recognition) {
      setSpeechText('Speech recognition is not available in this browser.');
      return;
    }
    recognitionRef.current?.abort();
    setVoiceMode(mode);
    setSpeechText('');
    setInterim('');
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
      if (finalText.trim()) setSpeechText((prev) => `${prev}${prev ? ' ' : ''}${finalText.trim()}`);
      setInterim(interimText.trim());
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => {
      setListening(false);
      setInterim('');
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const speakAdvisorReply = useCallback(async (advisorId: string, text: string) => {
    if (muted || !text) return;
    try {
      const res = await fetch('api/board/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body: JSON.stringify({ advisor_id: advisorId, text }),
      });
      if (!res.ok) {
        browserSpeak(text);
        return;
      }
      const blob = await res.blob();
      audioRef.current?.pause();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.play().catch(() => browserSpeak(text));
    } catch {
      browserSpeak(text);
    }
  }, [muted]);

  const speakBoardSummary = useCallback(async (text: string) => {
    if (muted || !text.trim()) return;
    try {
      const res = await fetch('api/tts/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body: JSON.stringify({
          text,
          surface: 'board',
          handle: 'board',
          displayName: 'Board Chair',
          title: 'Advisory Board Chair',
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
      browserSpeak(text);
    }
  }, [muted]);

  const sendAdvisorVoice = useCallback(async (text: string) => {
    if (!text || thinking) return;
    const target = resolveSpokenAdvisor(text, selected, advisors);
    if (!target.advisor) {
      setSpeechText('Say an advisor name first, then the request.');
      return;
    }
    const advisor = target.advisor;
    const message = target.message;
    setSelectedId(advisor.id);
    if (advisor.type === 'human') {
      setMessages((prev) => [...prev, {
        id: Date.now(),
        author_type: 'advisor',
        author_name: advisor.display_name,
        body: 'This advisor joins live in the video room.',
        created_at: new Date().toISOString(),
      }]);
      return;
    }

    setMessages((prev) => [...prev, {
      id: Date.now(),
      author_type: 'user',
      author_name: 'You',
      body: message,
      created_at: new Date().toISOString(),
    }]);
    setThinking(true);
    try {
      const result = await api<{ text?: string; error?: string }>(`api/board/advisors/${advisor.id}/message`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      const reply = result.text || result.error || '(no response)';
      setMessages((prev) => [...prev, {
        id: Date.now() + 1,
        author_type: 'advisor',
        author_name: advisor.display_name,
        body: reply,
        created_at: new Date().toISOString(),
      }]);
      void speakAdvisorReply(advisor.id, result.text || '');
    } catch {
      setMessages((prev) => [...prev, {
        id: Date.now() + 1,
        author_type: 'advisor',
        author_name: advisor.display_name,
        body: '(unable to reach the advisor)',
        created_at: new Date().toISOString(),
      }]);
    } finally {
      setThinking(false);
    }
  }, [advisors, selected, speakAdvisorReply, thinking]);

  const runMeeting = useCallback(async (topic: string) => {
    if (!topic || meetingRunning) return;
    setMeetingRunning(true);
    setMeeting(null);
    try {
      const result = await api<MeetingResult & { error?: string }>('api/board/meeting', {
        method: 'POST',
        body: JSON.stringify({ topic }),
      });
      if (!result.error) {
        setMeeting(result);
        void speakBoardSummary(`The board has finished. ${result.minutes}`);
      }
    } finally {
      setMeetingRunning(false);
    }
  }, [meetingRunning, speakBoardSummary]);

  const addAdvisor = useCallback(async (position: string) => {
    if (!position || generating) return;
    setGenerating(true);
    try {
      await api('api/board/advisors/generate', {
        method: 'POST',
        body: JSON.stringify({ position, model_label: aiModel, seat_index: advisors.length }),
      });
      setSelectedId(null);
      loadBoard();
    } finally {
      setGenerating(false);
    }
  }, [advisors.length, aiModel, generating, loadBoard]);

  const runVoiceAction = useCallback(async () => {
    const text = speechText.trim();
    if (!text) return;
    stopListening();
    if (voiceMode === 'advisor') await sendAdvisorVoice(text);
    if (voiceMode === 'meeting') await runMeeting(text);
    if (voiceMode === 'add') await addAdvisor(text);
    setSpeechText('');
    setInterim('');
  }, [addAdvisor, runMeeting, sendAdvisorVoice, speechText, stopListening, voiceMode]);

  const removeAdvisor = useCallback(async (id: string) => {
    await api(`api/board/advisors/${id}`, { method: 'DELETE' });
    setSelectedId(null);
    setMessages([]);
    loadBoard();
  }, [loadBoard]);

  const replaceAdvisor = useCallback(async (id: string) => {
    await api(`api/board/advisors/${id}`, { method: 'DELETE' });
    setSelectedId(null);
    setMessages([]);
    loadBoard();
    startListening('add');
  }, [loadBoard, startListening]);

  const modeLabel = voiceMode === 'advisor'
    ? selected ? `Ask ${selected.display_name.split(' ')[0]}` : 'Select advisor'
    : voiceMode === 'meeting'
      ? 'Convene board'
      : 'Add advisor';
  const showSidePanel = !!selected || !!meeting;

  return (
    <div className="relative h-full min-h-0 overflow-hidden text-white">
      <div className="absolute inset-0 bg-gradient-to-r from-black/34 via-black/0 to-black/18" />
      <div className="absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t from-black/58 to-transparent" />

      <main className={`relative z-10 grid h-full min-h-0 gap-3 p-3 ${showSidePanel ? 'grid-cols-[minmax(0,1fr)_340px]' : 'grid-cols-1'}`}>
        <section className="relative min-h-0 overflow-hidden">
          <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
            <div className="aios-frost-surface--dark rounded-lg border border-white/14 bg-black/46 px-3 py-2 shadow-xl backdrop-blur-md">
              <div className="text-[10px] uppercase tracking-[0.24em] text-white/56">Your</div>
              <div className="text-sm font-semibold">{boardName}</div>
            </div>
            <button
              type="button"
              onClick={() => startListening('meeting')}
              className="flex h-10 items-center gap-2 rounded-lg border border-white/14 bg-black/46 px-3 text-xs font-medium text-white/82 shadow-xl backdrop-blur-md"
              title="Convene the board by voice"
            >
              <Users className="h-4 w-4" /> Convene
            </button>
            <button
              type="button"
              onClick={() => startListening('add')}
              className="flex h-10 items-center gap-2 rounded-lg border border-white/14 bg-black/46 px-3 text-xs font-medium text-white/82 shadow-xl backdrop-blur-md"
              title="Add an advisor by voice"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
            <button
              type="button"
              onClick={() => setVideoOpen(true)}
              className="flex h-10 items-center justify-center rounded-lg border border-white/14 bg-black/46 px-3 text-white/82 shadow-xl backdrop-blur-md"
              title="Live video room"
            >
              <Video className="h-4 w-4" />
            </button>
          </div>

          <div className="absolute inset-0">
            {visibleAdvisors.map((advisor, index) => (
              <Seat
                key={advisor.id}
                advisor={advisor}
                selected={advisor.id === selectedId}
                speaking={thinking && advisor.id === selectedId}
                onClick={() => pick(advisor)}
                position={SEAT_POSITIONS[index]}
              />
            ))}
            {Array.from({ length: emptySeatCount }).map((_, index) => (
              <EmptySeat
                key="empty-seat"
                onClick={() => startListening('add')}
                position={SEAT_POSITIONS[visibleAdvisors.length + index]}
              />
            ))}
          </div>

          <div
            className="aios-frost-surface--dark absolute bottom-4 z-20 w-[min(920px,calc(100%-36px))] -translate-x-1/2 rounded-lg border border-white/16 bg-[#090d10]/78 p-3 shadow-2xl backdrop-blur-xl"
            style={{ left: TABLE_CENTER_LEFT }}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-white/78">
                <Brain className="h-4 w-4 text-emerald-300" />
                {modeLabel}
              </div>
              {voiceMode === 'add' ? (
                <div className="flex items-center gap-1">
                  {MODEL_OPTIONS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAiModel(value)}
                      className={`rounded-md px-2 py-1 text-[10px] ${aiModel === value ? 'bg-emerald-400/20 text-emerald-100' : 'bg-white/8 text-white/54'}`}
                      title={`Use ${label} for new advisor`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex max-w-[640px] flex-wrap items-center justify-end gap-1.5">
                  {visibleAdvisors.map((advisor) => (
                    <button
                      key={advisor.id}
                      type="button"
                      onClick={() => pick(advisor)}
                      className={`max-w-[168px] truncate rounded-md px-2.5 py-1 text-[11px] ${advisor.id === selectedId ? 'bg-emerald-400/20 text-emerald-100' : 'bg-white/8 text-white/68'}`}
                      title={advisor.title ?? advisor.display_name}
                    >
                      {advisor.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <textarea
              value={speechText}
              onChange={(e) => setSpeechText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runVoiceAction(); } }}
              rows={2}
              disabled={thinking || meetingRunning || generating}
              placeholder={voiceMode === 'advisor' ? 'Type or speak to an advisor…' : voiceMode === 'meeting' ? 'Type or say what the board should weigh in on…' : 'Type or say the advisor role you want at the table…'}
              className="mb-3 w-full resize-none rounded-lg border border-white/10 bg-white/8 px-3 py-2 text-sm leading-relaxed text-white placeholder-white/45 focus:outline-none focus:ring-2 focus:ring-emerald-400/50 disabled:opacity-50"
            />
            {listening && interim ? (
              <div className="-mt-2 mb-3 px-1 text-xs text-emerald-200/70">{interim}…</div>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => listening ? stopListening() : startListening(voiceMode)}
                className={`grid h-11 w-11 place-items-center rounded-lg border ${listening ? 'border-red-300/70 bg-red-500/20 text-red-100' : 'border-emerald-300/70 bg-emerald-400/18 text-emerald-100'}`}
                title={listening ? 'Stop listening' : 'Start listening'}
              >
                {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>
              <button
                type="button"
                onClick={runVoiceAction}
                disabled={!speechText.trim() || thinking || meetingRunning || generating || (voiceMode === 'advisor' && !selected && visibleAdvisors.length === 0)}
                className="grid h-11 w-11 place-items-center rounded-lg bg-emerald-500 text-white disabled:opacity-35"
                title="Send voice"
              >
                <Send className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => { setSpeechText(''); setInterim(''); }}
                disabled={!speechText && !interim}
                className="rounded-lg border border-white/14 px-3 py-2 text-xs text-white/68 disabled:opacity-35"
              >
                Clear
              </button>
              {(thinking || meetingRunning || generating) && (
                <div className="ml-auto flex items-center gap-2 text-xs text-emerald-200">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
                  {thinking ? 'Advisor responding' : meetingRunning ? 'Board in session' : 'Creating advisor'}
                </div>
              )}
            </div>
          </div>
        </section>

        {showSidePanel && (
        <aside className="aios-frost-surface--dark flex min-h-0 flex-col rounded-lg border border-white/14 bg-black/40 shadow-2xl backdrop-blur-xl">
            <>
              <div className="border-b border-white/10 p-4">
                {selected ? (
                  <div className="flex items-center gap-3">
                    <div
                      className="relative grid w-[54px] flex-shrink-0 place-items-center overflow-hidden rounded-md border border-white/18 text-sm font-semibold text-white"
                      style={{
                        aspectRatio: '3 / 4',
                        background: selected.avatar_image_url ? '#0d1114' : avatarGradient(`${selected.display_name}${selected.title ?? ''}${selected.bio ?? ''}`),
                      }}
                    >
                      {selected.avatar_image_url ? (
                        <img src={selected.avatar_image_url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                      ) : initials(selected.display_name)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white/90">{selected.display_name}</div>
                      <div className="truncate text-[11px] text-white/56">
                        {selected.title}{selected.type === 'ai' && selected.ai?.model_display ? ` · ${selected.ai.model_display}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMuted((value) => !value)}
                      className="ml-auto grid h-9 w-9 place-items-center rounded-lg border border-white/12 bg-white/8 text-white/70"
                      title={muted ? 'Unmute voice' : 'Mute voice'}
                    >
                      <Volume2 className={`h-4 w-4 ${muted ? 'opacity-35' : ''}`} />
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm font-semibold text-white/90">{meeting?.topic}</div>
                    <div className="mt-1 text-[11px] text-white/56">Board session</div>
                  </div>
                )}

                {selected?.bio && <div className="mt-3 text-[11.5px] leading-relaxed text-white/60">{selected.bio}</div>}
                {selected?.type === 'ai' && (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => replaceAdvisor(selected.id)}
                      className="flex items-center gap-1.5 rounded-md border border-white/12 bg-white/8 px-2.5 py-1.5 text-[11px] text-white/66"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAdvisor(selected.id)}
                      className="flex items-center gap-1.5 rounded-md border border-red-300/22 bg-red-500/12 px-2.5 py-1.5 text-[11px] text-red-100/78"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </button>
                  </div>
                )}
              </div>

              {meeting ? (
                <div className="flex-1 overflow-auto p-4">
                  <div className="space-y-3">
                    {meeting.turns.map((turn) => (
                      <div key={turn.advisorId} className="rounded-lg border border-white/10 bg-white/8 p-3">
                        <div className="mb-1 text-[11px] font-semibold text-white/82">{turn.name}</div>
                        <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-white/68">{turn.text}</div>
                      </div>
                    ))}
                    <div className="rounded-lg border border-emerald-300/18 bg-emerald-300/10 p-3">
                      <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-emerald-100/72">Minutes</div>
                      <div className="text-[12px] leading-relaxed text-white/76">{meeting.minutes}</div>
                    </div>
                    <div className="grid gap-3">
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-white/42">Decisions</div>
                        <div className="space-y-1.5">
                          {meeting.decisions.map((decision, index) => (
                            <div key={index} className="rounded-md bg-white/7 px-2 py-1.5 text-[11.5px] text-white/68">{decision}</div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-white/42">Actions</div>
                        <div className="space-y-1.5">
                          {meeting.tasks.map((task, index) => (
                            <div key={index} className="rounded-md bg-white/7 px-2 py-1.5 text-[11.5px] text-white/68">{task}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-auto p-3">
                  {messages.length === 0 && !thinking && (
                    <div className="py-6 text-center text-[11.5px] text-white/48">Speak and send to begin.</div>
                  )}
                  {messages.map((message) => (
                    <div key={message.id} className={message.author_type === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                      <div
                        className="max-w-[86%] rounded-lg border px-3 py-2 text-[12px] leading-relaxed"
                        style={{
                          background: message.author_type === 'user' ? 'rgba(16,185,129,0.16)' : 'rgba(255,255,255,0.07)',
                          borderColor: message.author_type === 'user' ? 'rgba(110,231,183,0.24)' : 'rgba(255,255,255,0.1)',
                          color: 'rgba(255,255,255,0.82)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {message.body}
                      </div>
                    </div>
                  ))}
                  {thinking && (
                    <div className="flex justify-start">
                      <div className="rounded-lg border border-white/10 bg-white/7 px-3 py-2 text-[11.5px] italic text-white/58">
                        {selected?.display_name.split(' ')[0] ?? 'Advisor'} is thinking...
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
        </aside>
        )}
      </main>

      {videoOpen && <VideoRoom advisors={advisors} onLeave={() => setVideoOpen(false)} />}
    </div>
  );
}

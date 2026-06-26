import React, { useEffect, useMemo, useRef, useState } from 'react';
import VideoRoom from '../components/VideoRoom';

/**
 * Advisory Board — the roundtable surface.
 * AI advisors (static portrait + voice) sit around the table; click a seat to open the
 * right panel and hold a 1:1 conversation. Humans join meetings via Zoom (Phase B).
 */

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

const token = () => localStorage.getItem('boss_token') ?? '';
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...(init?.headers ?? {}) },
  });
  return res.json() as Promise<T>;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
function avatarGradient(seed: string): string {
  const palettes = [
    'linear-gradient(135deg,#7C3CFF,#0EA5E9)', 'linear-gradient(135deg,#20B26B,#0EA5E9)',
    'linear-gradient(135deg,#E5A50A,#FF4D8D)', 'linear-gradient(135deg,#FF4D8D,#7C3CFF)',
    'linear-gradient(135deg,#0EA5E9,#20B26B)', 'linear-gradient(135deg,#E5484D,#E5A50A)',
  ];
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palettes[Math.abs(h) % palettes.length];
}

const MAX_SEATS = 5;
const MODEL_OPTIONS: [string, string][] = [
  ['google/gemini-2.5-flash', 'Gemini (Google)'],
  ['deepseek/deepseek-v3.2', 'DeepSeek'],
  ['moonshotai/kimi-k2.6', 'Kimi (Moonshot)'],
  ['z-ai/glm-4.6', 'GLM (Z.ai)'],
  ['x-ai/grok-2-1212', 'Grok (xAI)'],
  ['qwen/qwen-2.5-72b-instruct', 'Qwen'],
];

function Seat({ advisor, selected, speaking, onClick, style }: { advisor: Advisor; selected: boolean; speaking: boolean; onClick: () => void; style: React.CSSProperties }) {
  return (
    <button type="button" onClick={onClick} style={style}
      className="absolute flex flex-col items-center gap-1.5 -translate-x-1/2 -translate-y-1/2 group">
      <div className="rounded-full grid place-items-center transition-all"
        style={{
          width: 68, height: 68,
          background: advisor.avatar_image_url ? `center/cover url(${advisor.avatar_image_url})` : avatarGradient(advisor.display_name),
          boxShadow: selected ? '0 0 0 3px #7C3CFF, 0 0 22px rgba(124,60,255,0.55)' : speaking ? '0 0 0 3px #20B26B, 0 0 22px rgba(32,178,107,0.6)' : '0 0 0 1px rgba(255,255,255,0.12)',
          color: '#fff', fontWeight: 600, fontSize: 18, letterSpacing: '0.04em',
        }}>
        {!advisor.avatar_image_url && initials(advisor.display_name)}
      </div>
      <div className="text-[11px] font-medium whitespace-nowrap" style={{ color: selected ? '#F1F4FF' : '#C3CCE6' }}>{advisor.display_name}</div>
      <div className="text-[9px] whitespace-nowrap" style={{ color: '#74849A' }}>{advisor.title}</div>
      {advisor.type === 'ai' && advisor.ai?.model_display && <div className="text-[8px] px-1.5 rounded-full" style={{ background: 'rgba(124,60,255,0.16)', color: '#B79CFF' }}>{advisor.ai.model_display}</div>}
      {advisor.type === 'human' && <div className="text-[8px] px-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', color: '#9AA8C2' }}>Human · Zoom</div>}
    </button>
  );
}

export default function Board() {
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [boardName, setBoardName] = useState('Advisory Board');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BoardMsg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadBoard = () => api<{ board: { name: string } | null; advisors: Advisor[] }>('api/board')
    .then((d) => { setAdvisors(d.advisors ?? []); if (d.board?.name) setBoardName(d.board.name); })
    .catch(() => {});
  useEffect(() => { loadBoard(); }, []);

  // Invite a human advisor (joins meetings via a specific Zoom channel/link)
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ name: '', title: '', email: '' });
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  async function submitInvite() {
    if (!invite.name.trim() || inviting) return;
    setInviting(true);
    try {
      const r = await api<{ id?: string }>('api/board/advisors', { method: 'POST', body: JSON.stringify({
        type: 'human', display_name: invite.name.trim(), title: invite.title.trim() || 'Guest Advisor',
        email: invite.email.trim() || undefined, seat_index: advisors.length,
      }) });
      await loadBoard();
      if (r.id) {
        const link = await api<{ path?: string }>(`api/board/advisors/${r.id}/invite-link`, { method: 'POST' });
        if (link.path) setInviteLink(window.location.origin + link.path);
      }
    } finally { setInviting(false); }
  }
  function closeInvite() { setInvite({ name: '', title: '', email: '' }); setInviteLink(''); setAiPosition(''); setInviteOpen(false); }

  // Add an AI advisor — backend generates name/persona/portrait from position + model
  const [addMode, setAddMode] = useState<'ai' | 'human'>('ai');
  const [aiPosition, setAiPosition] = useState('');
  const [aiModel, setAiModel] = useState(MODEL_OPTIONS[0][0]);
  const [generating, setGenerating] = useState(false);
  async function submitGenerate() {
    if (!aiPosition.trim() || generating) return;
    setGenerating(true);
    try {
      await api('api/board/advisors/generate', { method: 'POST', body: JSON.stringify({ position: aiPosition.trim(), model_label: aiModel, seat_index: advisors.length }) });
      setAiPosition(''); setInviteOpen(false);
      await loadBoard();
    } finally { setGenerating(false); }
  }

  // Edit / remove an advisor
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ display_name: '', title: '', model_label: '' });
  async function saveEdit(id: string) {
    await api(`api/board/advisors/${id}`, { method: 'PATCH', body: JSON.stringify(edit) });
    setEditing(false); await loadBoard();
  }
  async function removeAdvisor(id: string) {
    await api(`api/board/advisors/${id}`, { method: 'DELETE' });
    setSelectedId(null); setEditing(false); await loadBoard();
  }
  async function replaceAdvisor(id: string) {
    await api(`api/board/advisors/${id}`, { method: 'DELETE' });
    setSelectedId(null); setEditing(false); await loadBoard();
    setAddMode('ai'); setInviteLink(''); setInviteOpen(true); // open Add to fill the freed seat
  }

  const [videoOpen, setVideoOpen] = useState(false);
  // Gate all video-call UI on LiveKit being configured — "minus video" deploys (Nathan/Kane/bos-ir)
  // auto-hide the video room + human-invite; it lights up wherever the rtc stack is set up.
  const [videoEnabled, setVideoEnabled] = useState(false);
  useEffect(() => { api<{ configured?: boolean }>('api/board/rtc/config').then((c) => setVideoEnabled(Boolean(c?.configured))).catch(() => undefined); }, []);

  // Board meeting — convene the whole board (multi-model deliberation → minutes/decisions/tasks)
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [meetingTopic, setMeetingTopic] = useState('');
  const [meetingRunning, setMeetingRunning] = useState(false);
  const [meeting, setMeeting] = useState<MeetingResult | null>(null);
  async function runMeeting() {
    const topic = meetingTopic.trim();
    if (!topic || meetingRunning) return;
    setMeetingRunning(true); setMeeting(null);
    try {
      const r = await api<MeetingResult & { error?: string }>('api/board/meeting', { method: 'POST', body: JSON.stringify({ topic }) });
      if (!r.error) setMeeting(r);
    } finally { setMeetingRunning(false); }
  }

  const selected = useMemo(() => advisors.find((a) => a.id === selectedId) ?? null, [advisors, selectedId]);

  function pick(a: Advisor) {
    setSelectedId(a.id); setMessages([]); setEditing(false);
    api<{ messages: BoardMsg[] }>(`api/board/advisors/${a.id}/messages`).then((d) => setMessages(d.messages ?? [])).catch(() => {});
  }

  // Voice — speak the advisor's reply (OmniVoice → Gemini fallback, served as WAV)
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  async function speak(advisorId: string, text: string) {
    if (muted || !text) return;
    try {
      const res = await fetch('api/board/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body: JSON.stringify({ advisor_id: advisorId, text }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      audioRef.current?.pause();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.play().catch(() => {});
    } catch { /* ignore */ }
  }

  async function send() {
    const msg = input.trim();
    if (!msg || !selected || thinking) return;
    if (selected.type === 'human') return;
    setInput('');
    setMessages((m) => [...m, { id: Date.now(), author_type: 'user', author_name: 'You', body: msg, created_at: new Date().toISOString() }]);
    setThinking(true);
    try {
      const r = await api<{ text?: string; error?: string }>(`api/board/advisors/${selected.id}/message`, { method: 'POST', body: JSON.stringify({ message: msg }) });
      setMessages((m) => [...m, { id: Date.now() + 1, author_type: 'advisor', author_name: selected.display_name, body: r.text || r.error || '(no response)', created_at: new Date().toISOString() }]);
      void speak(selected.id, r.text || '');
    } catch {
      setMessages((m) => [...m, { id: Date.now() + 1, author_type: 'advisor', author_name: selected.display_name, body: '(unable to reach the advisor)', created_at: new Date().toISOString() }]);
    } finally {
      setThinking(false);
    }
  }
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, thinking]);

  // polar seat layout
  const R = 188, cx = 250, cy = 250;
  const seatStyle = (i: number, n: number): React.CSSProperties => {
    const angle = -Math.PI / 2 + (i / Math.max(1, n)) * 2 * Math.PI;
    return { left: cx + R * Math.cos(angle), top: cy + R * Math.sin(angle), zIndex: 2 };
  };
  const emptySeats = Math.max(0, MAX_SEATS - advisors.length);
  const totalSeats = advisors.length + emptySeats;

  return (
    <div className="h-full flex" style={{ background: 'var(--v-base)' }}>
      {/* Roundtable stage */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 min-w-0">
        <div className="vs-mono text-[10px] tracking-[0.26em] mb-3" style={{ color: '#74849A' }}>YOUR {boardName.toUpperCase()}</div>
        <div className="flex gap-2 mb-4">
          <button type="button" onClick={() => { setMeeting(null); setMeetingTopic(''); setMeetingOpen(true); }}
            className="text-[12px] px-4 py-1.5 rounded-full font-medium transition-opacity hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#7C3CFF,#0EA5E9)', color: '#fff' }}>Convene the board</button>
          {videoEnabled && (
            <button type="button" onClick={() => setVideoOpen(true)}
              className="text-[12px] px-4 py-1.5 rounded-full font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: '#C3CCE6', border: '1px solid rgba(255,255,255,0.14)' }}>🎥 Live video room</button>
          )}
        </div>
        <div className="relative" style={{ width: 500, height: 500 }}>
          {/* the table (decorative — must not intercept seat clicks) */}
          <div className="absolute rounded-full" style={{
            left: 90, top: 90, width: 320, height: 320, pointerEvents: 'none',
            background: 'radial-gradient(circle at 50% 40%, rgba(124,60,255,0.10), rgba(255,255,255,0.02))',
            border: '1px solid rgba(255,255,255,0.07)', boxShadow: 'inset 0 0 60px rgba(0,0,0,0.4)',
          }} />
          <div className="absolute -translate-x-1/2 -translate-y-1/2 text-center" style={{ left: cx, top: cy, pointerEvents: 'none' }}>
            <div className="text-[13px] font-semibold" style={{ color: '#9AA8C2', letterSpacing: '0.04em' }}>Advisory</div>
            <div className="text-[13px] font-semibold" style={{ color: '#9AA8C2', letterSpacing: '0.04em' }}>Board</div>
          </div>
          {advisors.map((a, i) => (
            <Seat key={a.id} advisor={a} selected={a.id === selectedId} speaking={thinking && a.id === selectedId}
              onClick={() => pick(a)} style={seatStyle(i, totalSeats)} />
          ))}
          {Array.from({ length: emptySeats }).map((_, k) => (
            <button key={`add-${k}`} type="button" onClick={() => { setAddMode('ai'); setInviteLink(''); setInviteOpen(true); }}
              style={seatStyle(advisors.length + k, totalSeats)}
              className="absolute flex flex-col items-center gap-1.5 -translate-x-1/2 -translate-y-1/2">
              <div className="rounded-full grid place-items-center transition-colors"
                style={{ width: 68, height: 68, border: '2px dashed rgba(255,255,255,0.22)', color: '#9AA8C2', fontSize: 24 }}>+</div>
              <div className="text-[10.5px]" style={{ color: '#74849A' }}>Add</div>
            </button>
          ))}
          {advisors.length === 0 && (
            <div className="absolute inset-0 grid place-items-center text-[12px]" style={{ color: '#74849A' }}>No advisors yet — add your board members.</div>
          )}
        </div>
      </div>

      {/* Right panel: advisor detail + chat */}
      <div className="w-[380px] flex-shrink-0 flex flex-col border-l" style={{ borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}>
        {!selected ? (
          <div className="flex-1 grid place-items-center text-center px-8">
            <div>
              <div className="text-[14px] font-medium mb-1.5" style={{ color: '#C3CCE6' }}>Pick an advisor</div>
              <div className="text-[12px]" style={{ color: '#74849A' }}>Click a seat at the table to open their profile and talk with them one-on-one.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="p-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
              <div className="flex items-center gap-3">
                <div className="rounded-full grid place-items-center flex-shrink-0" style={{ width: 46, height: 46, background: selected.avatar_image_url ? `center/cover url(${selected.avatar_image_url})` : avatarGradient(selected.display_name), color: '#fff', fontWeight: 600, fontSize: 14 }}>
                  {!selected.avatar_image_url && initials(selected.display_name)}
                </div>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold truncate" style={{ color: '#F1F4FF' }}>{selected.display_name}</div>
                  <div className="text-[11px]" style={{ color: '#9AA8C2' }}>{selected.title}{selected.type === 'ai' && selected.ai?.model_display ? ` · ${selected.ai.model_display}` : ''}</div>
                </div>
                {selected.type === 'ai' && (
                  <button type="button" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute voice' : 'Mute voice'}
                    className="ml-auto flex-shrink-0 text-[15px]" style={{ color: muted ? '#74849A' : '#7C3CFF' }}>{muted ? '🔇' : '🔊'}</button>
                )}
              </div>
              {selected.bio && !editing && <div className="text-[11.5px] mt-2.5" style={{ color: '#9AA8C2' }}>{selected.bio}</div>}
              {selected.type === 'ai' && !editing && (
                <div className="flex gap-3 mt-2.5 text-[10.5px]">
                  <button type="button" onClick={() => { setEdit({ display_name: selected.display_name, title: selected.title ?? '', model_label: selected.ai?.model_label ?? MODEL_OPTIONS[0][0] }); setEditing(true); }} style={{ color: '#9AA8C2' }}>Edit</button>
                  <button type="button" onClick={() => replaceAdvisor(selected.id)} style={{ color: '#B79CFF' }}>Replace</button>
                  <button type="button" onClick={() => removeAdvisor(selected.id)} style={{ color: '#E5857F' }}>Remove</button>
                </div>
              )}
              {selected.type === 'ai' && editing && (
                <div className="mt-3 space-y-2">
                  <input value={edit.display_name} onChange={(e) => setEdit((v) => ({ ...v, display_name: e.target.value }))} placeholder="Name" className="w-full text-[12px] px-2.5 py-1.5 rounded-md" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }} />
                  <input value={edit.title} onChange={(e) => setEdit((v) => ({ ...v, title: e.target.value }))} placeholder="Title" className="w-full text-[12px] px-2.5 py-1.5 rounded-md" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }} />
                  <select value={edit.model_label} onChange={(e) => setEdit((v) => ({ ...v, model_label: e.target.value }))} className="w-full text-[12px] px-2.5 py-1.5 rounded-md" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }}>
                    {MODEL_OPTIONS.map(([v, l]) => <option key={v} value={v} style={{ background: '#10131C' }}>{l}</option>)}
                  </select>
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setEditing(false)} className="text-[11px] px-2.5 py-1 rounded-md" style={{ background: 'rgba(255,255,255,0.06)', color: '#C3CCE6' }}>Cancel</button>
                    <button type="button" onClick={() => saveEdit(selected.id)} className="text-[11px] px-2.5 py-1 rounded-md font-medium" style={{ background: '#7C3CFF', color: '#fff' }}>Save</button>
                  </div>
                </div>
              )}
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-2.5">
              {messages.length === 0 && !thinking && (
                <div className="text-[11.5px] text-center py-6" style={{ color: '#74849A' }}>Ask {selected.display_name.split(' ')[0]} anything.</div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={m.author_type === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div className="max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed" style={{
                    background: m.author_type === 'user' ? 'rgba(124,60,255,0.18)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${m.author_type === 'user' ? 'rgba(124,60,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
                    color: '#E8ECF7', whiteSpace: 'pre-wrap',
                  }}>{m.body}</div>
                </div>
              ))}
              {thinking && (
                <div className="flex justify-start">
                  <div className="rounded-xl px-3 py-2 text-[11.5px] italic" style={{ background: 'rgba(255,255,255,0.04)', color: '#9AA8C2' }}>
                    {selected.display_name.split(' ')[0]} is thinking…
                  </div>
                </div>
              )}
            </div>

            {selected.type === 'human' ? (
              <div className="p-3 border-t text-center" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                <div className="text-[11px] mb-2" style={{ color: '#74849A' }}>Human advisor — meet live over Zoom.</div>
                {selected.zoom_join_url && <a href={selected.zoom_join_url} target="_blank" rel="noreferrer" className="inline-block text-[11.5px] px-3 py-1.5 rounded-md font-medium" style={{ background: '#2D8CFF', color: '#fff' }}>Start Zoom call</a>}
              </div>
            ) : (
              <div className="p-3 border-t flex gap-2" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  placeholder={`Message ${selected.display_name.split(' ')[0]}…`} disabled={thinking}
                  className="flex-1 text-[12px] px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }} />
                <button type="button" onClick={send} disabled={thinking || !input.trim()}
                  className="text-[12px] px-3.5 py-2 rounded-lg font-medium" style={{ background: '#7C3CFF', color: '#fff', opacity: thinking || !input.trim() ? 0.5 : 1 }}>Send</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Invite a person — they join meetings live via their Zoom channel (no BOS account) */}
      {inviteOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={closeInvite}>
          <div className="w-[400px] rounded-2xl p-5" style={{ background: '#10131C', border: '1px solid rgba(255,255,255,0.1)' }} onClick={(e) => e.stopPropagation()}>
            {!inviteLink ? (
              <>
                <div className="text-[15px] font-semibold mb-2" style={{ color: '#F1F4FF' }}>Add an advisor</div>
                {videoEnabled && (
                  <div className="flex gap-1 mb-3 p-0.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <button type="button" onClick={() => setAddMode('ai')} className="flex-1 text-[12px] py-1.5 rounded-md font-medium" style={{ background: addMode === 'ai' ? '#7C3CFF' : 'transparent', color: addMode === 'ai' ? '#fff' : '#9AA8C2' }}>AI advisor</button>
                    <button type="button" onClick={() => setAddMode('human')} className="flex-1 text-[12px] py-1.5 rounded-md font-medium" style={{ background: addMode === 'human' ? '#7C3CFF' : 'transparent', color: addMode === 'human' ? '#fff' : '#9AA8C2' }}>Invite person</button>
                  </div>
                )}
                {addMode === 'ai' ? (
                  <>
                    <div className="text-[11.5px] mb-2.5" style={{ color: '#9AA8C2' }}>Name an authority and pick a model — BOS writes their persona and generates a portrait.</div>
                    <input value={aiPosition} onChange={(e) => setAiPosition(e.target.value)} placeholder="Authority / position (e.g. Chief Marketing Officer)"
                      className="w-full text-[12.5px] px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }} />
                    <select value={aiModel} onChange={(e) => setAiModel(e.target.value)}
                      className="w-full text-[12.5px] px-3 py-2 rounded-lg mt-2.5" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }}>
                      {MODEL_OPTIONS.map(([v, l]) => <option key={v} value={v} style={{ background: '#10131C' }}>{l}</option>)}
                    </select>
                    <div className="flex gap-2 mt-4 justify-end">
                      <button type="button" onClick={closeInvite} className="text-[12px] px-3.5 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)', color: '#C3CCE6' }}>Cancel</button>
                      <button type="button" onClick={submitGenerate} disabled={!aiPosition.trim() || generating}
                        className="text-[12px] px-3.5 py-2 rounded-lg font-medium" style={{ background: '#7C3CFF', color: '#fff', opacity: !aiPosition.trim() || generating ? 0.5 : 1 }}>{generating ? 'Generating…' : 'Generate advisor'}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-[11.5px] mb-2.5" style={{ color: '#9AA8C2' }}>They get a private link to join the live video room — no BOS account needed.</div>
                    <div className="space-y-2.5">
                      {([['name', 'Name'], ['title', 'Title / role (e.g. Legal Counsel)'], ['email', 'Email (optional)']] as const).map(([k, ph]) => (
                        <input key={k} value={invite[k]} onChange={(e) => setInvite((v) => ({ ...v, [k]: e.target.value }))} placeholder={ph}
                          className="w-full text-[12.5px] px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }} />
                      ))}
                    </div>
                    <div className="flex gap-2 mt-4 justify-end">
                      <button type="button" onClick={closeInvite} className="text-[12px] px-3.5 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)', color: '#C3CCE6' }}>Cancel</button>
                      <button type="button" onClick={submitInvite} disabled={!invite.name.trim() || inviting}
                        className="text-[12px] px-3.5 py-2 rounded-lg font-medium" style={{ background: '#7C3CFF', color: '#fff', opacity: !invite.name.trim() || inviting ? 0.5 : 1 }}>{inviting ? 'Creating link…' : 'Create join link'}</button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold mb-1" style={{ color: '#F1F4FF' }}>Invite link ready</div>
                <div className="text-[11.5px] mb-3" style={{ color: '#9AA8C2' }}>Send this to your guest — they click it to join the video room.</div>
                <div className="text-[11px] px-3 py-2 rounded-lg break-all mb-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#B79CFF' }}>{inviteLink}</div>
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => navigator.clipboard?.writeText(inviteLink)} className="text-[12px] px-3.5 py-2 rounded-lg font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: '#E8ECF7' }}>Copy link</button>
                  <button type="button" onClick={closeInvite} className="text-[12px] px-3.5 py-2 rounded-lg font-medium" style={{ background: '#7C3CFF', color: '#fff' }}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Board meeting — convene the whole board on a topic (multi-model deliberation) */}
      {meetingOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center p-6" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => !meetingRunning && setMeetingOpen(false)}>
          <div className="w-[640px] max-h-[86vh] overflow-auto rounded-2xl p-5" style={{ background: '#10131C', border: '1px solid rgba(255,255,255,0.1)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[16px] font-semibold" style={{ color: '#F1F4FF' }}>Board meeting</div>
              {!meetingRunning && <button type="button" onClick={() => setMeetingOpen(false)} className="text-[20px] leading-none" style={{ color: '#74849A' }}>×</button>}
            </div>
            <div className="text-[11.5px] mb-3.5" style={{ color: '#9AA8C2' }}>The full board deliberates — each advisor on its own model — then the Chair synthesizes minutes, decisions, and action items into your tasks.</div>

            {!meeting && (
              <div className="flex gap-2">
                <input value={meetingTopic} onChange={(e) => setMeetingTopic(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runMeeting(); }}
                  placeholder="What should the board weigh in on?" disabled={meetingRunning} autoFocus
                  className="flex-1 text-[13px] px-3 py-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#E8ECF7' }} />
                <button type="button" onClick={runMeeting} disabled={meetingRunning || !meetingTopic.trim()}
                  className="text-[13px] px-4 py-2.5 rounded-lg font-medium whitespace-nowrap" style={{ background: 'linear-gradient(135deg,#7C3CFF,#0EA5E9)', color: '#fff', opacity: meetingRunning || !meetingTopic.trim() ? 0.5 : 1 }}>{meetingRunning ? 'In session…' : 'Convene'}</button>
              </div>
            )}
            {meetingRunning && (
              <div className="text-[12px] mt-4 flex items-center gap-2" style={{ color: '#B79CFF' }}>
                <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: '#7C3CFF' }} />
                The board is deliberating across {advisors.filter((a) => a.type === 'ai').length} models — this takes a moment.
              </div>
            )}

            {meeting && (
              <div className="space-y-4">
                <div className="text-[13px] font-medium" style={{ color: '#E8ECF7' }}>“{meeting.topic}”</div>
                <div className="space-y-2">
                  {meeting.turns.map((t) => (
                    <div key={t.advisorId} className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <div className="text-[11px] mb-0.5"><span style={{ color: '#F1F4FF', fontWeight: 600 }}>{t.name}</span> <span style={{ color: '#9AA8C2' }}>· {t.title}</span></div>
                      <div className="text-[12px]" style={{ color: '#C3CCE6', whiteSpace: 'pre-wrap' }}>{t.text}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-[10px] tracking-[0.2em] mb-1" style={{ color: '#74849A' }}>MINUTES</div>
                  <div className="text-[12px] leading-relaxed" style={{ color: '#C3CCE6' }}>{meeting.minutes}</div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: '#74849A' }}>DECISIONS</div>
                    <ul className="space-y-1.5">{meeting.decisions.map((d, i) => <li key={i} className="text-[11.5px] flex gap-1.5" style={{ color: '#C3CCE6' }}><span style={{ color: '#20B26B' }}>✓</span><span>{d}</span></li>)}</ul>
                  </div>
                  <div>
                    <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: '#74849A' }}>ACTION ITEMS</div>
                    <ul className="space-y-1.5">{meeting.tasks.map((t, i) => <li key={i} className="text-[11.5px] flex gap-1.5" style={{ color: '#C3CCE6' }}><span style={{ color: '#7C3CFF' }}>▸</span><span>{t}</span></li>)}</ul>
                  </div>
                </div>
                <div className="text-[10.5px]" style={{ color: '#74849A' }}>✓ Action items added to your Task Board · decisions logged.</div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setMeeting(null); setMeetingTopic(''); }} className="text-[12px] px-3.5 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)', color: '#C3CCE6' }}>New meeting</button>
                  <button type="button" onClick={() => setMeetingOpen(false)} className="text-[12px] px-3.5 py-2 rounded-lg font-medium" style={{ background: '#7C3CFF', color: '#fff' }}>Done</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {videoOpen && <VideoRoom advisors={advisors} onLeave={() => setVideoOpen(false)} />}
    </div>
  );
}

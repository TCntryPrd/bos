import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

/**
 * VideoRoom — the live gallery grid (LiveKit). Your camera + a tile per participant/advisor.
 * Connected participants show live video (AI advisors show their portrait); known advisors not
 * yet joined show an "offline" placeholder. Works for the owner (full board) and for a guest
 * (public /join page) via the `getToken` prop. Up to 6 tiles.
 *
 * NOTE: camera/mic (getUserMedia) require a secure context (HTTPS or localhost). Over plain HTTP
 * the connect succeeds but the camera is blocked — open via the Tailscale Funnel HTTPS URL.
 */

export interface RoomAdvisor { id: string; type: 'ai' | 'human'; display_name: string; title: string | null; avatar_image_url: string | null }
export interface RtcToken { url: string; token: string }

const authToken = () => localStorage.getItem('boss_token') ?? '';
function initials(name: string): string { return name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }

async function ownerToken(): Promise<RtcToken> {
  const res = await fetch('api/board/rtc/token', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}) } });
  const d = await res.json() as { url?: string; token?: string; error?: string };
  if (!d.token || !d.url) throw new Error(d.error || 'no token');
  return { url: d.url, token: d.token };
}

function Tile({ name, sub, portrait, track, online, speaking, isLocal, offlineLabel }: {
  name: string; sub?: string; portrait?: string; track?: Track; online: boolean; speaking: boolean; isLocal?: boolean; offlineLabel?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && track) { track.attach(el); return () => { try { track.detach(el); } catch { /* noop */ } }; }
  }, [track]);
  return (
    <div className="relative rounded-xl overflow-hidden" style={{
      aspectRatio: '4 / 3', background: '#0B0E16',
      boxShadow: speaking ? '0 0 0 3px #20B26B, 0 0 18px rgba(32,178,107,0.5)' : '0 0 0 1px rgba(255,255,255,0.08)',
      transition: 'box-shadow 0.15s',
    }}>
      {track ? (
        <video ref={ref} autoPlay playsInline muted={isLocal} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: isLocal ? 'scaleX(-1)' : undefined }} />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          {portrait ? (
            <img src={portrait} alt="" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', opacity: online ? 1 : 0.45 }} />
          ) : (
            <div className="rounded-full grid place-items-center" style={{ width: 72, height: 72, background: 'linear-gradient(135deg,#7C3CFF,#0EA5E9)', color: '#fff', fontWeight: 600, opacity: online ? 1 : 0.45 }}>{initials(name)}</div>
          )}
          {!online && <div className="absolute" style={{ bottom: 26, fontSize: 10, color: '#74849A' }}>{offlineLabel ?? 'Offline'}</div>}
        </div>
      )}
      <div className="absolute" style={{ bottom: 6, left: 8, fontSize: 11, fontWeight: 500, color: '#F1F4FF', textShadow: '0 1px 3px rgba(0,0,0,0.85)' }}>
        {name}{sub ? <span style={{ color: '#C3CCE6' }}> · {sub}</span> : null}
      </div>
    </div>
  );
}

export default function VideoRoom({ advisors = [], onLeave, getToken = ownerToken, youName = 'You' }: {
  advisors?: RoomAdvisor[]; onLeave: () => void; getToken?: () => Promise<RtcToken>; youName?: string;
}) {
  const roomRef = useRef<Room | null>(null);
  const [, setTick] = useState(0);
  const rerender = () => setTick((n) => n + 1);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errMsg, setErrMsg] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    room
      .on(RoomEvent.ParticipantConnected, rerender)
      .on(RoomEvent.ParticipantDisconnected, rerender)
      .on(RoomEvent.TrackSubscribed, rerender)
      .on(RoomEvent.TrackUnsubscribed, rerender)
      .on(RoomEvent.LocalTrackPublished, rerender)
      .on(RoomEvent.LocalTrackUnpublished, rerender)
      .on(RoomEvent.ActiveSpeakersChanged, (sp) => setSpeaking(new Set(sp.map((s) => s.identity))))
      .on(RoomEvent.Disconnected, () => setStatus((s) => (s === 'connected' ? s : 'error')));
    (async () => {
      try {
        const { url, token } = await getToken();
        await room.connect(url, token);
        setStatus('connected'); rerender();
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        rerender();
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e)); setStatus('error');
      }
    })();
    return () => { room.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function leave() { roomRef.current?.disconnect(); onLeave(); }
  async function toggleMic() { const r = roomRef.current; if (!r) return; const on = !micOn; await r.localParticipant.setMicrophoneEnabled(on); setMicOn(on); }
  async function toggleCam() { const r = roomRef.current; if (!r) return; const on = !camOn; await r.localParticipant.setCameraEnabled(on); setCamOn(on); rerender(); }

  const room = roomRef.current;
  const localCam = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as Track | undefined;
  const localId = room?.localParticipant.identity ?? '';

  // Unified tiles: connected remotes (advisor info overlaid by identity) + offline advisor placeholders.
  const advisorById = new Map(advisors.map((a) => [a.id, a]));
  const advisorFor = (identity: string): RoomAdvisor | undefined => {
    const m = identity.match(/^(?:human|ai)-(.+)$/);
    return m ? advisorById.get(m[1]) : undefined;
  };
  const remotes = room ? Array.from(room.remoteParticipants.values()) : [];
  const remoteTiles = remotes.map((p) => {
    const adv = advisorFor(p.identity);
    return {
      key: p.identity, name: adv?.display_name ?? p.name ?? 'Guest', sub: adv?.title ?? undefined,
      portrait: adv?.avatar_image_url ?? undefined, track: p.getTrackPublication(Track.Source.Camera)?.videoTrack as Track | undefined,
      online: true, identity: p.identity, offlineLabel: undefined as string | undefined,
    };
  });
  const liveAdvisorIds = new Set(remotes.map((p) => advisorFor(p.identity)?.id).filter(Boolean));
  const offlineTiles = advisors.filter((a) => !liveAdvisorIds.has(a.id)).map((a) => ({
    key: `off-${a.id}`, name: a.display_name, sub: a.title ?? undefined, portrait: a.avatar_image_url ?? undefined,
    track: undefined as Track | undefined, online: false, identity: '', offlineLabel: a.type === 'ai' ? 'AI · not in session' : 'Offline',
  }));
  const tiles = [...remoteTiles, ...offlineTiles].slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#06080E' }}>
      <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="text-[13px] font-semibold" style={{ color: '#F1F4FF' }}>Board video room{status === 'connecting' ? ' · connecting…' : ''}</div>
        <button type="button" onClick={leave} className="text-[12px] px-3.5 py-1.5 rounded-lg font-medium" style={{ background: '#E5484D', color: '#fff' }}>Leave</button>
      </div>
      {status === 'error' && (
        <div className="px-5 py-2 text-[12px]" style={{ color: '#E5857F' }}>Couldn't start the room: {errMsg}. Camera/mic need an HTTPS page — open via the Tailscale Funnel URL.</div>
      )}
      <div className="flex-1 grid gap-3 p-5 content-center" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <Tile name={youName} track={camOn ? localCam : undefined} online speaking={speaking.has(localId)} isLocal />
        {tiles.map((t) => (
          <Tile key={t.key} name={t.name} sub={t.sub} portrait={t.portrait} track={t.track} online={t.online} speaking={speaking.has(t.identity)} offlineLabel={t.offlineLabel} />
        ))}
      </div>
      <div className="flex items-center justify-center gap-3 py-4 border-t" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <button type="button" onClick={toggleMic} className="text-[12px] px-4 py-2 rounded-full font-medium" style={{ background: micOn ? 'rgba(255,255,255,0.1)' : '#E5484D', color: '#fff' }}>{micOn ? 'Mute' : 'Unmute'}</button>
        <button type="button" onClick={toggleCam} className="text-[12px] px-4 py-2 rounded-full font-medium" style={{ background: camOn ? 'rgba(255,255,255,0.1)' : '#E5484D', color: '#fff' }}>{camOn ? 'Stop video' : 'Start video'}</button>
      </div>
    </div>
  );
}

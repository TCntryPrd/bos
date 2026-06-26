/**
 * board-agent — publishes AI advisors as live LiveKit participants in the board room:
 * each advisor joins as `ai-<id>` and publishes a static-portrait VIDEO track + (on demand)
 * a VOICE audio track from the api's TTS. So human guests in the room SEE and HEAR them.
 *
 * HTTP API (called by the BOS api):
 *   POST /ensure {room}                 — all AI advisors join + publish their portrait
 *   POST /speak  {advisor_id, text, room} — that advisor speaks (TTS → audio frames)
 *   POST /leave                         — disconnect all advisor bots
 *   GET  /health
 */
import { Room, VideoSource, AudioSource, LocalVideoTrack, LocalAudioTrack, VideoFrame, AudioFrame, VideoBufferType, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { PNG } from 'pngjs';
import http from 'node:http';

const LK_URL = process.env.LIVEKIT_URL_INTERNAL || 'ws://livekit:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;
const API_BASE = process.env.API_BASE || 'http://api:8001';
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://vasari.starrpartners.ai';
const PORT = Number(process.env.AGENT_PORT || 8090);
const IDLE_MS = 15 * 60 * 1000;

const sessions = new Map(); // advisorId -> { room, videoSource, audioSource, frameTimer, lastActivity }

async function mintToken(identity, name, room) {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, name });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: false });
  return await at.toJwt();
}

async function fetchAdvisors() {
  const res = await fetch(`${API_BASE}/api/board`, { headers: { 'X-BOSS-Internal': 'true' } });
  const d = await res.json();
  return (d.advisors || []).filter((a) => a.type === 'ai');
}

const WEB_BASE = process.env.WEB_BASE || 'http://web:80';
async function fetchPortrait(avatarUrl) {
  if (!avatarUrl) return null;
  // Route internally: /api/* → the api; static /advisors/* → the web; absolute → as-is.
  const url = avatarUrl.startsWith('http') ? avatarUrl
    : avatarUrl.startsWith('/api/') ? API_BASE + avatarUrl
      : WEB_BASE + avatarUrl;
  for (const u of [url, PUBLIC_BASE + (avatarUrl.startsWith('/') ? avatarUrl : '')]) {
    try { const res = await fetch(u); if (res.ok) return PNG.sync.read(Buffer.from(await res.arrayBuffer())); } catch { /* try next */ }
  }
  return null;
}

async function joinAdvisor(advisor, room) {
  const existing = sessions.get(advisor.id);
  if (existing) { existing.lastActivity = Date.now(); return; }
  const lkRoom = new Room();
  await lkRoom.connect(LK_URL, await mintToken(`ai-${advisor.id}`, advisor.display_name, room), { autoSubscribe: false, dynacast: true });
  const sess = { room: lkRoom, lastActivity: Date.now() };
  sessions.set(advisor.id, sess);
  const png = await fetchPortrait(advisor.avatar_image_url);
  if (png) {
    const vs = new VideoSource(png.width, png.height);
    const vt = LocalVideoTrack.createVideoTrack('portrait', vs);
    await lkRoom.localParticipant.publishTrack(vt, new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
    const frame = new VideoFrame(new Uint8Array(png.data), png.width, png.height, VideoBufferType.RGBA);
    sess.videoSource = vs;
    sess.frameTimer = setInterval(() => { try { vs.captureFrame(frame); } catch {} }, 200); // ~5fps static
  }
  const as = new AudioSource(24000, 1);
  const at = LocalAudioTrack.createAudioTrack('voice', as);
  await lkRoom.localParticipant.publishTrack(at, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  sess.audioSource = as;
  console.log(`[agent] ${advisor.display_name} (ai-${advisor.id}) joined ${room}`);
}

async function ensureJoined(room) {
  const advisors = await fetchAdvisors();
  for (const a of advisors) { try { await joinAdvisor(a, room); } catch (e) { console.error('[agent] join fail', a.display_name, e.message); } }
  return advisors.length;
}

async function speak(advisorId, text, room) {
  let sess = sessions.get(advisorId);
  if (!sess && room) { const a = (await fetchAdvisors()).find((x) => x.id === advisorId); if (a) { await joinAdvisor(a, room); sess = sessions.get(advisorId); } }
  if (!sess?.audioSource) return false;
  sess.lastActivity = Date.now();
  const res = await fetch(`${API_BASE}/api/board/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BOSS-Internal': 'true' }, body: JSON.stringify({ advisor_id: advisorId, text }) });
  if (!res.ok) return false;
  const wav = Buffer.from(await res.arrayBuffer());
  // locate the PCM data chunk
  let off = 12, dataStart = 44, dataEnd = wav.length;
  while (off < wav.length - 8) {
    const id = wav.toString('ascii', off, off + 4); const sz = wav.readUInt32LE(off + 4);
    if (id === 'data') { dataStart = off + 8; dataEnd = dataStart + sz; break; }
    off += 8 + sz;
  }
  const pcm = wav.subarray(dataStart, Math.min(dataEnd, wav.length));
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const N = 240; // 10ms @ 24kHz
  for (let i = 0; i < samples.length; i += N) {
    const buf = new Int16Array(N);
    buf.set(samples.subarray(i, Math.min(i + N, samples.length)));
    await sess.audioSource.captureFrame(new AudioFrame(buf, 24000, 1, N));
  }
  return true;
}

async function leaveAll() {
  for (const [id, s] of sessions) { clearInterval(s.frameTimer); try { await s.room.disconnect(); } catch {} sessions.delete(id); }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastActivity > IDLE_MS) { clearInterval(s.frameTimer); s.room.disconnect().catch(() => {}); sessions.delete(id); console.log('[agent] idle-left', id); }
}, 60000);

http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, sessions: sessions.size });
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', async () => {
    let b = {}; try { b = JSON.parse(body || '{}'); } catch { /* noop */ }
    try {
      if (req.url === '/ensure') return send(200, { joined: await ensureJoined(b.room || 'board-default') });
      if (req.url === '/speak') return send(200, { spoke: await speak(b.advisor_id, b.text || '', b.room) });
      if (req.url === '/leave') { await leaveAll(); return send(200, { ok: true }); }
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: e.message }); }
  });
}).listen(PORT, () => console.log('[agent] board-agent listening on', PORT));

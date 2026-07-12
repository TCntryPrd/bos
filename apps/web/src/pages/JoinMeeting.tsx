import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import VideoRoom from '../components/VideoRoom';

/**
 * JoinMeeting — public guest page (no BOS account). Reads the signed invite code, validates it,
 * and lets a human advisor join the board's video room with live camera/mic.
 */
export default function JoinMeeting() {
  const { code } = useParams<{ code: string }>();
  const [info, setInfo] = useState<{ url: string; token: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    fetch(`api/board/rtc/guest?code=${encodeURIComponent(code ?? '')}`)
      .then((r) => r.json())
      .then((d: { url?: string; token?: string; name?: string; error?: string }) => {
        if (d.token && d.url) setInfo({ url: d.url, token: d.token, name: d.name || 'Guest' });
        else setErr(d.error || 'This invite link is invalid or expired.');
      })
      .catch(() => setErr('Could not reach the meeting.'));
  }, [code]);

  if (joined && info) {
    return <VideoRoom advisors={[]} getToken={() => Promise.resolve({ url: info.url, token: info.token })} youName={info.name} onLeave={() => setJoined(false)} />;
  }

  return (
    <div className="min-h-screen grid place-items-center" style={{ background: '#06080E' }}>
      <div className="w-[360px] text-center rounded-2xl p-6" style={{ background: '#10131C', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="text-[17px] font-semibold mb-1" style={{ color: '#F1F4FF' }}>Board meeting</div>
        {err ? (
          <div className="text-[12px] mt-2" style={{ color: '#E5857F' }}>{err}</div>
        ) : !info ? (
          <div className="text-[12px] mt-2" style={{ color: '#9AA8C2' }}>Checking your invite…</div>
        ) : (
          <>
            <div className="text-[12px] mb-4 mt-1" style={{ color: '#9AA8C2' }}>Joining as <b style={{ color: '#E8ECF7' }}>{info.name}</b> — live video, no account needed.</div>
            <button type="button" onClick={() => setJoined(true)} className="w-full text-[13px] px-4 py-2.5 rounded-lg font-medium" style={{ background: 'linear-gradient(135deg,#7C3CFF,#0EA5E9)', color: '#fff' }}>Join with camera &amp; mic</button>
            <div className="text-[10.5px] mt-3" style={{ color: '#74849A' }}>Your browser will ask for camera &amp; microphone access.</div>
          </>
        )}
      </div>
    </div>
  );
}

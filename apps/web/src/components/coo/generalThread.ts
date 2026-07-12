/**
 * Resolve the ONE shared COO "General Discussion" thread — the session the
 * dashboard chat orb, Voice Control, and the COO surface all talk to. It runs on
 * the COO Claude CLI (full tools, one-shot per turn, like the rascals), so the
 * assistant can actually DO things (archive mail, download attachments, etc.),
 * not just narrate. Finds the thread by name; creates it if missing.
 */

const WORKSPACE = '/home/tcntryprd/boss-dev';
const THREAD_NAME = 'General Discussion';

function authH(): Record<string, string> {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getGeneralThreadId(): Promise<string> {
  const headers = authH();
  const listRes = await fetch('api/coo/threads', { headers });
  const threads = listRes.ok ? ((await listRes.json()) as Array<{ id: string; name: string }>) : [];
  const found = threads.find((t) => t.name === THREAD_NAME);
  if (found) return found.id;
  const createRes = await fetch('api/coo/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name: THREAD_NAME, workspace_dir: WORKSPACE }),
  });
  if (!createRes.ok) throw new Error(`create General Discussion thread failed: ${createRes.status}`);
  const gd = (await createRes.json()) as { id: string };
  return gd.id;
}

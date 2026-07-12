/**
 * LinkedIn — publish (text / image / video / document) + status, shared by the
 * brain tool and the /api/linkedin route. Uses the modern versioned Posts API
 * (POST /rest/posts) + the Images/Videos/Documents upload flows. Member feed
 * only (author = urn:li:person:<sub>), scope w_member_social.
 *
 * API version is env-tunable (LinkedIn sunsets monthly versions ~yearly):
 *   LINKEDIN_API_VERSION=YYYYMM  (default below). Bump if posts 400 on version.
 */
import { getPool } from '../db.js';
import { createUnipileLinkedInPost, getUnipileConnectionStatus, isUnipileConfigured } from './unipile.js';

const REST = 'https://api.linkedin.com/rest';
const apiVersion = () => process.env.LINKEDIN_API_VERSION || '202605';

function restHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': apiVersion(),
    'Content-Type': 'application/json',
  };
}

export interface LinkedInStatus { connected: boolean; email?: string; expiresAt?: string | null; source?: 'unipile' | 'oauth'; accountId?: string | null; }
export interface MediaInput {
  type: 'image' | 'video' | 'document';
  url?: string;          // BOS fetches the bytes (agent path)
  dataBase64?: string;   // base64 (tile file-upload path); may carry a data: prefix
  filename?: string;
  altText?: string;
}

async function getStoredToken(): Promise<string | null> {
  try {
    const { rows } = await getPool().query<{ access_token: string }>(
      `SELECT access_token FROM boss_oauth_tokens WHERE provider = 'linkedin' ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0]?.access_token ?? null;
  } catch { return null; }
}

export async function getLinkedInStatus(): Promise<LinkedInStatus> {
  if (isUnipileConfigured()) {
    try {
      const status = await getUnipileConnectionStatus('LINKEDIN');
      return {
        connected: status.connected,
        email: status.name ?? status.accountId ?? undefined,
        expiresAt: null,
        source: 'unipile',
        accountId: status.accountId,
      };
    } catch {
      return { connected: false, source: 'unipile', accountId: null };
    }
  }
  try {
    const { rows } = await getPool().query<{ email: string; expires_at: string | null }>(
      `SELECT email, expires_at FROM boss_oauth_tokens WHERE provider = 'linkedin' ORDER BY created_at DESC LIMIT 1`,
    );
    if (!rows[0]) return { connected: false };
    return { connected: true, email: rows[0].email, expiresAt: rows[0].expires_at, source: 'oauth' };
  } catch { return { connected: false }; }
}

/** OpenID userinfo → member `sub` (the URN id used as author + media owner). */
async function getAuthorSub(token: string): Promise<string> {
  const r = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`LinkedIn userinfo failed (${r.status})`);
  const d = (await r.json()) as { sub: string };
  return d.sub;
}

async function resolveMediaBytes(media: MediaInput): Promise<Buffer> {
  if (media.dataBase64) {
    const b64 = media.dataBase64.includes(',') ? media.dataBase64.slice(media.dataBase64.indexOf(',') + 1) : media.dataBase64;
    return Buffer.from(b64, 'base64');
  }
  if (media.url) {
    const r = await fetch(media.url);
    if (!r.ok) throw new Error(`Could not fetch media from URL (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('media requires a url or dataBase64');
}

// ── Upload flows (return the media URN for content.media.id) ─────────────────

async function uploadImage(token: string, sub: string, bytes: Buffer): Promise<string> {
  const init = await fetch(`${REST}/images?action=initializeUpload`, {
    method: 'POST', headers: restHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${sub}` } }),
  });
  if (!init.ok) throw new Error(`image init failed (${init.status}): ${(await init.text().catch(() => '')).slice(0, 200)}`);
  const { value } = (await init.json()) as { value: { uploadUrl: string; image: string } };
  // Image upload: PUT with the Bearer token (REQUIRED — opposite of video).
  const up = await fetch(value.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  if (!up.ok && up.status !== 201) throw new Error(`image upload failed (${up.status})`);
  return value.image;
}

async function uploadDocument(token: string, sub: string, bytes: Buffer): Promise<string> {
  const init = await fetch(`${REST}/documents?action=initializeUpload`, {
    method: 'POST', headers: restHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${sub}` } }),
  });
  if (!init.ok) throw new Error(`document init failed (${init.status}): ${(await init.text().catch(() => '')).slice(0, 200)}`);
  const { value } = (await init.json()) as { value: { uploadUrl: string; document: string } };
  const up = await fetch(value.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  if (!up.ok && up.status !== 201) throw new Error(`document upload failed (${up.status})`);
  return value.document;
}

async function uploadVideo(token: string, sub: string, bytes: Buffer): Promise<string> {
  const init = await fetch(`${REST}/videos?action=initializeUpload`, {
    method: 'POST', headers: restHeaders(token),
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: `urn:li:person:${sub}`, fileSizeBytes: bytes.length,
        uploadCaptions: false, uploadThumbnail: false,
      },
    }),
  });
  if (!init.ok) throw new Error(`video init failed (${init.status}): ${(await init.text().catch(() => '')).slice(0, 200)}`);
  const { value } = (await init.json()) as {
    value: { video: string; uploadToken: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] };
  };
  // Each part: PUT the byte range WITHOUT the Bearer token (the uploadUrl is
  // pre-signed). Capture the `etag` response header per part, in order.
  const etags: string[] = [];
  for (const part of value.uploadInstructions) {
    const chunk = bytes.subarray(part.firstByte, part.lastByte + 1);
    const up = await fetch(part.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk });
    if (!up.ok && up.status !== 201) throw new Error(`video part upload failed (${up.status})`);
    const etag = up.headers.get('etag');
    if (!etag) throw new Error('video part upload returned no etag header');
    etags.push(etag);
  }
  const fin = await fetch(`${REST}/videos?action=finalizeUpload`, {
    method: 'POST', headers: restHeaders(token),
    body: JSON.stringify({ finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? '', uploadedPartIds: etags } }),
  });
  if (!fin.ok) throw new Error(`video finalize failed (${fin.status}): ${(await fin.text().catch(() => '')).slice(0, 200)}`);
  return value.video;
}

export async function ensureLinkedInPostsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS boss_linkedin_posts (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  TEXT NOT NULL DEFAULT 'default',
      text       TEXT NOT NULL,
      link       TEXT,
      post_id    TEXT,
      author     TEXT,
      media_kind TEXT,
      posted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Existing installs: add the column without losing rows.
  await getPool().query(`ALTER TABLE boss_linkedin_posts ADD COLUMN IF NOT EXISTS media_kind TEXT`).catch(() => {});
}

/** Build the public URL to view a post from its URN. */
export function postViewUrl(urn: string | null): string | null {
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

/** Delete a previously-published post (LinkedIn + local row). */
export async function deleteLinkedInPost(rowId: string, tenantId = 'default'): Promise<void> {
  const token = await getStoredToken();
  if (!token) throw new Error('LinkedIn is not connected.');
  const { rows } = await getPool().query<{ post_id: string | null }>(
    `SELECT post_id FROM boss_linkedin_posts WHERE id = $1 AND tenant_id = $2`, [rowId, tenantId]);
  const urn = rows[0]?.post_id;
  if (urn) {
    const r = await fetch(`${REST}/posts/${encodeURIComponent(urn)}`, { method: 'DELETE', headers: restHeaders(token) });
    // 204 = deleted, 404 = already gone — both fine.
    if (!r.ok && r.status !== 204 && r.status !== 404) {
      throw new Error(`LinkedIn delete failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
    }
  }
  await getPool().query(`DELETE FROM boss_linkedin_posts WHERE id = $1 AND tenant_id = $2`, [rowId, tenantId]);
}

/** Edit a post's text (commentary only — LinkedIn doesn't allow editing media). */
export async function editLinkedInPost(rowId: string, newText: string, tenantId = 'default'): Promise<void> {
  const token = await getStoredToken();
  if (!token) throw new Error('LinkedIn is not connected.');
  const { rows } = await getPool().query<{ post_id: string | null }>(
    `SELECT post_id FROM boss_linkedin_posts WHERE id = $1 AND tenant_id = $2`, [rowId, tenantId]);
  const urn = rows[0]?.post_id;
  if (!urn) throw new Error('Post not found or has no LinkedIn id.');
  const r = await fetch(`${REST}/posts/${encodeURIComponent(urn)}`, {
    method: 'POST',
    headers: { ...restHeaders(token), 'X-RestLi-Method': 'PARTIAL_UPDATE' },
    body: JSON.stringify({ patch: { $set: { commentary: newText } } }),
  });
  if (!r.ok) throw new Error(`LinkedIn edit failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
  await getPool().query(`UPDATE boss_linkedin_posts SET text = $2 WHERE id = $1 AND tenant_id = $3`, [rowId, newText, tenantId]);
}

/** Publish a post (optionally with a link in the text and/or one media asset). */
export async function publishLinkedInPost(
  text: string,
  opts: { link?: string; media?: MediaInput } = {},
  tenantId = 'default',
): Promise<{ postId: string }> {
  if (isUnipileConfigured()) {
    const { postId, accountId } = await createUnipileLinkedInPost(text, { link: opts.link, media: opts.media });
    try {
      await ensureLinkedInPostsTable();
      await getPool().query(
        `INSERT INTO boss_linkedin_posts (tenant_id, text, link, post_id, author, media_kind) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, text, opts.link ?? null, postId, `unipile:${accountId}`, opts.media?.type ?? 'text'],
      );
    } catch { /* best-effort log */ }
    return { postId: postId ?? '' };
  }

  const token = await getStoredToken();
  if (!token) throw new Error('LinkedIn is not connected — connect it in Settings → Connections first.');
  const sub = await getAuthorSub(token);

  // LinkedIn auto-previews a URL placed in the commentary, so a plain link
  // needs no special content block.
  const commentary = opts.link ? `${text}\n\n${opts.link}`.trim() : text;
  const post: Record<string, unknown> = {
    author: `urn:li:person:${sub}`,
    commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  let mediaKind = 'text';
  if (opts.media) {
    const bytes = await resolveMediaBytes(opts.media);
    let urn: string;
    if (opts.media.type === 'image') urn = await uploadImage(token, sub, bytes);
    else if (opts.media.type === 'video') urn = await uploadVideo(token, sub, bytes);
    else urn = await uploadDocument(token, sub, bytes);
    const mediaObj: Record<string, unknown> = { id: urn };
    if (opts.media.altText) mediaObj.altText = opts.media.altText;
    if (opts.media.type === 'document') mediaObj.title = opts.media.filename || 'Document';
    else if (opts.media.type === 'video' && opts.media.filename) mediaObj.title = opts.media.filename;
    post.content = { media: mediaObj };
    mediaKind = opts.media.type;
  }

  const r = await fetch(`${REST}/posts`, { method: 'POST', headers: restHeaders(token), body: JSON.stringify(post) });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`LinkedIn post failed (${r.status}): ${detail.slice(0, 300)}`);
  }
  const postId = r.headers.get('x-restli-id') ?? '';

  try {
    await ensureLinkedInPostsTable();
    await getPool().query(
      `INSERT INTO boss_linkedin_posts (tenant_id, text, link, post_id, author, media_kind) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, text, opts.link ?? null, postId, `urn:li:person:${sub}`, mediaKind],
    );
  } catch { /* best-effort log */ }
  return { postId };
}

export interface LinkedInPostRow {
  id: string; text: string; link: string | null; post_id: string | null;
  media_kind: string | null; posted_at: string; viewUrl: string | null;
}

export async function listLinkedInPosts(limit = 10, tenantId = 'default'): Promise<LinkedInPostRow[]> {
  try {
    await ensureLinkedInPostsTable();
    const { rows } = await getPool().query<Omit<LinkedInPostRow, 'viewUrl'>>(
      `SELECT id, text, link, post_id, media_kind, posted_at FROM boss_linkedin_posts WHERE tenant_id = $1 ORDER BY posted_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({ ...r, viewUrl: postViewUrl(r.post_id) }));
  } catch { return []; }
}

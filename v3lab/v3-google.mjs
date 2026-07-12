// IR Custom AIOS v3 — Google OAuth helper. Decrypts stored tokens (aes-256-gcm iv:tag:cipher,
// matching @boss/connectors token-store), refreshes when expired, returns access token.
import crypto from 'node:crypto';
import { pool, cfg } from './v3-turn.mjs';

function decrypt(enc, keyHex) {
  const [ivHex, tagHex, ct] = enc.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return d.update(ct, 'hex', 'utf8') + d.final('utf8');
}

export async function googleToken(match = 'c3RhcnJwYXJ0bmVy') { // 'starrpartner' b64 fragment
  const encKey = process.env.BOSS_TOKEN_ENCRYPTION_KEY || await cfg('BOSS_TOKEN_ENCRYPTION_KEY');
  if (!encKey) throw new Error('no encryption key');
  let row = (await pool.query("SELECT account_id, access_token, refresh_token, expires_at FROM boss_oauth_tokens WHERE provider='google' AND account_id LIKE $1 ORDER BY expires_at DESC LIMIT 1", [`%${match}%`])).rows[0];
  if (!row) row = (await pool.query("SELECT account_id, access_token, refresh_token, expires_at FROM boss_oauth_tokens WHERE provider='google' ORDER BY expires_at DESC LIMIT 1")).rows[0];
  if (!row) throw new Error('no google token');
  let access = decrypt(row.access_token, encKey);
  if (new Date(row.expires_at).getTime() < Date.now() + 60000) {
    const refresh = decrypt(row.refresh_token, encKey);
    const cid = await cfg('GOOGLE_CLIENT_ID'), cs = await cfg('GOOGLE_CLIENT_SECRET');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: refresh, grant_type: 'refresh_token' }) });
    const j = await r.json();
    if (!j.access_token) throw new Error('refresh failed: ' + JSON.stringify(j).slice(0, 140));
    access = j.access_token;
  }
  return { access, account: row.account_id };
}

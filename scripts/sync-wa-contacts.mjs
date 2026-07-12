#!/usr/bin/env node
/**
 * Sync WhatsApp contact names from OpenWA to boss_whatsapp_threads
 * Fetches contact info for threads with missing or placeholder display names
 */

import pg from 'pg';
import 'dotenv/config';

const OPENWA_BASE = process.env.OPENWA_BASE_URL || 'http://localhost:2785/api';
const OPENWA_SESSION = process.env.OPENWA_SESSION_ID || 'default';
const OPENWA_KEY = process.env.OPENWA_API_KEY;

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL,
});

async function syncContacts() {
  console.log('Fetching threads needing contact sync...');

  const { rows } = await pool.query(`
    SELECT chat_id, display_name, phone
    FROM boss_whatsapp_threads
    WHERE tenant_id = 'default'
      AND is_group = false
      AND (display_name IS NULL
           OR display_name = ''
           OR display_name = phone
           OR display_name LIKE '+%')
    ORDER BY last_message_at DESC NULLS LAST
  `);

  console.log(`Found ${rows.length} threads to sync`);

  for (const row of rows) {
    const { chat_id } = row;
    console.log(`Fetching contact for ${chat_id}...`);

    try {
      const res = await fetch(
        `${OPENWA_BASE}/sessions/${OPENWA_SESSION}/contacts/${encodeURIComponent(chat_id)}`,
        { headers: { 'X-API-Key': OPENWA_KEY } }
      );

      if (!res.ok) {
        console.log(`  ❌ HTTP ${res.status}`);
        continue;
      }

      const contact = await res.json();
      const displayName = contact.verifiedName || contact.pushname || contact.name || null;

      if (displayName) {
        await pool.query(
          `UPDATE boss_whatsapp_threads
           SET display_name = $1, updated_at = NOW()
           WHERE tenant_id = 'default' AND chat_id = $2`,
          [displayName, chat_id]
        );
        console.log(`  ✅ ${displayName}`);
      } else {
        console.log(`  ⚠️  No name found in contact data`);
      }
    } catch (err) {
      console.log(`  ❌ ${err.message}`);
    }
  }

  console.log('Done!');
  await pool.end();
}

syncContacts().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

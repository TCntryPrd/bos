#!/usr/bin/env node
/**
 * WhatsApp background sync daemon
 * Polls active chats and syncs messages to IR Custom AIOS DB
 * Works around OpenWA webhook limitation for multi-device outbound messages
 */

import pg from 'pg';
import fetch from 'node-fetch';

const { Pool } = pg;

const OPENWA_BASE = process.env.OPENWA_BASE_URL || 'http://openwa-api:8002/api';
const OPENWA_SESSION = process.env.OPENWA_SESSION_ID;
const OPENWA_KEY = process.env.OPENWA_API_KEY;
const SESSION_PHONE = process.env.OPENWA_SESSION_PHONE || '15397777906';
const SYNC_INTERVAL = parseInt(process.env.WHATSAPP_SYNC_INTERVAL || '30', 10) * 1000;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'boss',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'boss_db',
});

console.log(`WhatsApp sync daemon starting (interval: ${SYNC_INTERVAL/1000}s)`);

async function syncThread(chatId) {
  try {
    // Fetch contacts to get chat list with last message info
    const contactsRes = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/contacts`, {
      headers: { 'X-API-Key': OPENWA_KEY }
    });

    if (!contactsRes.ok) return { synced: 0, error: 'contacts_fetch_failed' };

    const contacts = await contactsRes.json();
    const contact = contacts.find(c => c.id === chatId);

    if (!contact || !contact.lastMessage) return { synced: 0, error: 'no_last_message' };

    const msg = contact.lastMessage;
    if (!msg.id) return { synced: 0, error: 'no_message_id' };

    // Check if message already exists
    const existing = await pool.query(
      'SELECT 1 FROM boss_whatsapp_messages WHERE tenant_id = $1 AND wa_message_id = $2',
      ['default', msg.id]
    );

    if (existing.rows.length > 0) return { synced: 0, cached: true };

    // Determine fromMe
    const fromPhone = typeof msg.from === 'string' ? msg.from.replace(/@.+$/, '') : '';
    const fromMe = msg.fromMe === true
      || msg.id.startsWith('true_')
      || fromPhone === SESSION_PHONE;

    const direction = fromMe ? 'outbound' : 'inbound';
    const sentAt = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();

    // Insert message
    await pool.query(
      `INSERT INTO boss_whatsapp_messages
         (tenant_id, chat_id, wa_message_id, direction, from_me, author,
          body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
         DO NOTHING`,
      ['default', chatId, msg.id, direction, fromMe, msg.author || null,
       msg.body || null, msg.type || 'chat', null, null, null, sentAt]
    );

    // Update thread
    await pool.query(
      `UPDATE boss_whatsapp_threads
          SET last_message_wa_id = $2,
              last_message_at = $3,
              last_message_preview = $4,
              last_message_from_me = $5,
              updated_at = NOW()
        WHERE tenant_id = 'default' AND chat_id = $1`,
      [chatId, msg.id, sentAt, (msg.body || '').substring(0, 100), fromMe]
    );

    return { synced: 1, fromMe };

  } catch (err) {
    console.error(`Sync error for ${chatId}:`, err.message);
    return { synced: 0, error: err.message };
  }
}

async function syncLoop() {
  try {
    // Get active threads from DB
    const result = await pool.query(
      `SELECT chat_id FROM boss_whatsapp_threads
       WHERE tenant_id = 'default' AND archived = false
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 20`
    );

    let totalSynced = 0;
    for (const row of result.rows) {
      const { synced, fromMe } = await syncThread(row.chat_id);
      if (synced > 0) {
        console.log(`  ✓ ${row.chat_id}: synced ${synced} message${fromMe ? ' (fromMe)' : ''}`);
        totalSynced += synced;
      }
    }

    if (totalSynced > 0) {
      console.log(`[${new Date().toISOString()}] Synced ${totalSynced} new messages`);
    }

  } catch (err) {
    console.error('Sync loop error:', err.message);
  }

  setTimeout(syncLoop, SYNC_INTERVAL);
}

// Start
syncLoop();

# Buckley - WhatsApp Operator Implementation Status

**Created**: 2026-06-05
**Agent Type**: Outsider (IR Custom AIOS employee)
**Role**: WhatsApp relay operator

## ✅ COMPLETED

### Database
- `boss_whatsapp_scheduled` table created
  - Stores scheduled messages/reminders
  - Status tracking (pending → approved → sent)
  - Foreign key to threads for data integrity

### API Endpoints (all deployed)
- `POST /api/whatsapp/schedule` - Schedule future message
- `GET /api/whatsapp/scheduled` - List scheduled messages (filter by status/chat)
- `POST /api/whatsapp/scheduled/:id/cancel` - Cancel pending scheduled message
- `POST /api/whatsapp/scheduled/:id/approve` - Approve for sending
- `POST /api/whatsapp/start-conversation` - Start new thread with phone number

### Testing
```bash
# Schedule a reminder
curl -H 'Content-Type: application/json' -H 'X-BOSS-Internal: true' \
  http://127.0.0.1:8001/api/whatsapp/schedule \
  -d '{"chatId": "30992551153826@lid", "message": "Reminder text", "sendAt": "2026-06-10T16:00:00Z"}'

# List scheduled
curl -H 'X-BOSS-Internal: true' http://127.0.0.1:8001/api/whatsapp/scheduled

# Start new conversation
curl -H 'Content-Type: application/json' -H 'X-BOSS-Internal: true' \
  http://127.0.0.1:8001/api/whatsapp/start-conversation \
  -d '{"phone": "15551234567", "message": "Hi, this is Kevin from..."}'
```

## 🚧 PENDING (Delegated to Gio)

### Task 1: Webhook Handler (Priority 10, Due June 8)
**What**: Every incoming WhatsApp message creates push notification
**How**:
1. Modify `/api/webhooks/whatsapp` to call Buckley logic on `message.received`
2. Analyze sender (known contact? client? urgent?)
3. Score priority (high for clients, normal for others)
4. Create push notification via `/api/agent-ops/notify`:
   ```json
   {
     "title": "WhatsApp from Kane Minkus",
     "body": "Message preview...",
     "priority": "high",
     "action_type": "review_whatsapp_message",
     "data": {
       "chat_id": "...",
       "message_id": "...",
       "actions": ["reply", "ignore", "snooze_1h", "snooze_1d"]
     }
   }
   ```

### Task 2: Scheduled Messages Background Worker (Priority 9, Due June 8)
**What**: Background job polls `boss_whatsapp_scheduled` and sends approved messages
**How**:
1. Create worker script (Node.js + setInterval)
2. Every 60 seconds:
   - Query for `status='approved' AND sent_at IS NULL AND send_at <= NOW()`
   - For each due message:
     - Send via OpenWA `/messages/send-text`
     - Update `status='sent', sent_at=NOW(), wa_message_id=...`
     - On failure: `status='failed'`, log error
3. Run as Docker service or in API background thread

### Task 3: WhatsApp Operator UI (Priority 9, Due June 8)
**What**: Dashboard component for WhatsApp management
**Features**:
- Pending notifications list (poll `/api/agent-ops/notifications`)
- Inline reply input
- Snooze buttons (1h, 1 day)
- Scheduled messages dashboard
  - List upcoming sends
  - Cancel button
  - "Schedule new" form
- Start new conversation form

**Components**:
```typescript
<WhatsAppOperatorPanel>
  <PendingMessages /> {/* From notifications API */}
  <ScheduledSends />   {/* From /api/whatsapp/scheduled */}
  <NewConversation />  {/* POST /api/whatsapp/start-conversation */}
</WhatsAppOperatorPanel>
```

## Architecture

```
┌─────────────────┐
│ WhatsApp (OpenWA)│
└────────┬─────────┘
         │ webhook
         ▼
┌─────────────────┐
│ Webhook Handler │
│ (Buckley logic) │
└────────┬─────────┘
         │ creates
         ▼
┌─────────────────┐      ┌──────────────┐
│ Push Notification│─────▶│ Dashboard UI │
│     (Kevin)      │      │   (Browser)  │
└─────────────────┘      └──────┬───────┘
         │                       │
         │ [Reply/Schedule]      │ polls
         ▼                       ▼
┌─────────────────┐      ┌──────────────┐
│  WhatsApp API   │      │Scheduled Jobs│
│  (send-text)    │◀─────│  (Worker)    │
└─────────────────┘      └──────────────┘
```

## Token Management

- **Incoming message analysis**: gemini-flash (~$0.0001)
- **Reply drafting**: gemini-flash with Weaviate context (~$0.0003)
- **Complex reasoning**: Escalate to Claude Sonnet (~$0.003)
- **Target**: <$0.005 per message processed

## Success Metrics

- [ ] 100% of incoming messages create notification within 10s
- [ ] Scheduled sends accurate within 60s of `send_at` time
- [ ] Draft acceptance rate >60% (sent without major modification)
- [ ] Zero missed sends (status=approved must eventually send or fail, never stuck)

## Next Steps for Gio

1. Start with **webhook handler** (highest priority, enables incoming flow)
2. Then **background worker** (enables scheduled sends)
3. Finally **UI component** (ties everything together)

See full spec in `/agents/buckley/AGENT.md`

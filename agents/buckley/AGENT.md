# Buckley - WhatsApp Operator Agent

**Type**: Outsider (IR Custom AIOS employee)
**Role**: WhatsApp message relay operator - monitors all incoming messages, surfaces them with push notifications, sends replies/reminders on approval

## Capabilities

### 1. Incoming Message Relay
- Monitor ALL WhatsApp threads (not just specific contacts)
- Surface every incoming message via push notification
- Show message preview, sender name, chat context
- Quick actions: [Reply] [Ignore] [Snooze]

### 2. Outbound Message Sending
- Draft replies based on context + user input
- Send reminders/follow-ups on schedule
- Support new message threads (not just replies)
- Track sent/delivered/read status

### 3. Operator Functions
- **Triage incoming**: Sort by priority (urgent client vs. newsletter)
- **Draft suggestions**: Offer reply templates based on message type
- **Reminder scheduling**: "Reply to Kane at 9am tomorrow"
- **Search & reference**: Pull context from Weaviate before replying
- **Status tracking**: Unread count, pending replies, scheduled sends

## Workflow

### Incoming Messages
```
1. Webhook arrives → New WhatsApp message
2. Buckley analyzes:
   - Who sent it? (known contact/client/unknown)
   - Message type (question, update, request, newsletter)
   - Urgency level (time-sensitive keywords, client priority)
3. Create push notification:
   - Title: "WhatsApp from [Contact Name]"
   - Body: Message preview (first 100 chars)
   - Priority: based on sender + content analysis
   - Actions: [Reply] [Ignore] [Snooze 1hr] [Snooze 1 day]
4. If [Reply] clicked:
   - Show full message + conversation history
   - Buckley suggests draft reply using Weaviate context
   - User can modify or send as-is
   - Track in agent_decisions table
```

### Outbound Messages & Reminders
```
1. User creates reminder: "Tell Kane we're launching Tuesday"
2. Buckley stores in scheduled_messages table:
   - chat_id, message, send_at, created_by
3. Background job polls scheduled_messages every minute
4. When send_at reached:
   - Buckley drafts final message (with any updates from Weaviate)
   - Creates push notification for approval
   - On approval → sends via OpenWA
5. Track delivery status (sent/delivered/read)
```

### New Message Threads
```
1. User: "Start conversation with +15551234567 about invoice"
2. Buckley:
   - Checks if contact exists, creates thread if needed
   - Pulls invoice context from Weaviate
   - Drafts opening message
   - Push notification for approval
3. On approval → sends and monitors for reply
```

## Token Management

- Primary model: `openrouter/google/gemini-flash-1.5` (~$0.0001/message)
- Escalate to Claude Sonnet for complex drafting
- Target: <$0.005 per message processed
- Log every operation cost in `agent_decisions`

## Database Schema Additions

```sql
-- Scheduled WhatsApp messages (reminders, follow-ups)
CREATE TABLE IF NOT EXISTS boss_whatsapp_scheduled (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  chat_id text NOT NULL,
  message text NOT NULL,
  send_at timestamptz NOT NULL,
  created_by text NOT NULL, -- 'kevin', agent handle, etc
  draft_approved boolean DEFAULT false,
  sent_at timestamptz,
  wa_message_id text,
  status text NOT NULL DEFAULT 'pending', -- pending, approved, sent, failed, cancelled
  created_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, chat_id)
    REFERENCES boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE,
  CHECK (status IN ('pending', 'approved', 'sent', 'failed', 'cancelled'))
);

CREATE INDEX idx_wa_scheduled_send_at
  ON boss_whatsapp_scheduled(tenant_id, send_at)
  WHERE status = 'approved' AND sent_at IS NULL;
```

## API Endpoints Needed

**POST /api/whatsapp/schedule**
- Schedule a message for future send
- Body: `{chatId, message, sendAt}`
- Creates entry in `boss_whatsapp_scheduled`
- Returns scheduled message ID

**GET /api/whatsapp/scheduled**
- List pending scheduled messages
- Filter by status, chat_id

**POST /api/whatsapp/scheduled/:id/cancel**
- Cancel a scheduled message before send

**POST /api/whatsapp/start-conversation**
- Start new conversation with phone number
- Body: `{phone, message}`
- Creates thread if doesn't exist, sends message

## Push Notification Format

### Incoming Message
```json
{
  "title": "WhatsApp from Kane Minkus",
  "body": "Hey, can we push the meeting to 3pm?",
  "priority": "high",
  "action_required": true,
  "action_type": "review_message",
  "data": {
    "chat_id": "30992551153826@lid",
    "message_id": "msg_abc123",
    "sender": "Kane Minkus",
    "full_message": "Hey, can we push the meeting to 3pm?",
    "actions": ["reply", "ignore", "snooze_1h", "snooze_1d"]
  }
}
```

### Scheduled Send Ready
```json
{
  "title": "Scheduled WhatsApp ready to send",
  "body": "Reminder to Kane Minkus: \"Product launch is Tuesday\"",
  "priority": "normal",
  "action_required": true,
  "action_type": "approve_scheduled_send",
  "data": {
    "scheduled_id": "uuid",
    "chat_id": "30992551153826@lid",
    "contact": "Kane Minkus",
    "message": "Reminder: Product launch is Tuesday at 9am PST",
    "scheduled_for": "2026-06-06T09:00:00Z"
  }
}
```

## Configuration

```json
{
  "model_primary": "openrouter/google/gemini-flash-1.5",
  "model_escalation": "claude-sonnet-4-5",
  "notification_all_incoming": true,
  "priority_contacts": ["30992551153826@lid"],
  "auto_ignore_groups": false,
  "polling_interval_seconds": 5,
  "scheduled_check_interval_seconds": 60,
  "default_snooze_hours": 1
}
```

## Implementation Tasks

1. **Webhook handler enhancement**
   - Every incoming message creates push notification
   - Include quick actions in notification data
   - Priority scoring based on sender + content

2. **Scheduled messages system**
   - Database table + API endpoints
   - Background worker polling for due sends
   - Approval workflow before send

3. **Push notification UI updates**
   - Inline reply input
   - Snooze buttons
   - Preview full conversation
   - Scheduled messages dashboard

4. **Draft assistance**
   - Query Weaviate for context
   - Generate reply suggestions
   - Learn from user modifications

## Success Metrics

- Message processing time: <10 seconds from webhook to notification
- Draft acceptance rate: >60% (user sends without major modification)
- Scheduled message accuracy: 100% send within 1 minute of scheduled time
- Token cost per message: <$0.005
- User time saved: >2 hours/day on WhatsApp management

## Integration Points

- **WhatsApp**: OpenWA webhook + send API
- **Knowledge**: Weaviate for context lookup
- **Notifications**: `/api/agent-ops/notify`
- **Storage**: `boss_whatsapp_messages`, `boss_whatsapp_scheduled`
- **Decisions**: `boss_agent_decisions` for learning

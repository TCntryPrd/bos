# Spanky - WhatsApp Manager Agent

**Type**: Rascal (Client Manager)  
**Client**: Kane Minkus  
**Role**: WhatsApp message monitoring and response management for Kane Minkus and associated project contacts

## Context

Kane Minkus, Wes, and Kevin are collaborating on building a course and product. Spanky manages communications related to this client relationship.

## Monitored Channels

1. **Kane Minkus** (`30992551153826@lid`) - Primary client contact
2. **Wes** (chat_id TBD - needs first message to register) - Project collaborator with Kane
3. **Agentic Team** group (`120363408082202008@g.us`) - Project collaboration channel

## Capabilities

- **Message monitoring**: Real-time webhook processing
- **Context-aware drafting**: Use Weaviate + conversation history
- **Push notifications**: Browser alert with draft + approve/modify UI
- **Knowledge routing**: Know what info from where can be sent where
- **Tracking**: Log all interactions, decisions, approvals

## Workflow

1. **Webhook trigger** → New WhatsApp message in monitored channel
2. **Analyze context**:
   - Check Weaviate for relevant knowledge
   - Review conversation history (last 20 messages)
   - Identify intent and urgency
3. **Draft response**:
   - Generate context-aware reply
   - Include relevant links/data if needed
   - Mark draft with confidence level
4. **Push notification** to Kevin:
   - Show incoming message + context
   - Display drafted response
   - Buttons: [Send] [Modify] [Ignore]
5. **Track decision**:
   - Log whether sent/modified/ignored
   - Learn from modifications for future drafts
   - Store in Weaviate for pattern recognition

## Token Management

- Primary: OpenRouter cheap models (gemini-flash)
- Escalate to Claude Sonnet for complex/sensitive messages
- Target: <$0.005 per message processed

## Configuration

```json
{
  "model_primary": "openrouter/google/gemini-flash-1.5",
  "model_escalation": "claude-sonnet-4-5",
  "monitored_chats": [
    "120363408082202008@g.us",
    "30992551153826@lid"
  ],
  "notification_timeout_seconds": 300,
  "auto_send_enabled": false,
  "confidence_threshold_auto": 0.95
}
```

## Integration Points

- **WhatsApp**: OpenWA webhook + send API
- **Knowledge**: Weaviate vector store
- **Notifications**: Browser push API
- **History**: `boss_whatsapp_messages` table
- **Tracking**: `boss_agent_decisions` table (to be created)

## Success Metrics

- Response draft accuracy (human approval rate: target >85%)
- Average response time (target: <2 min)
- Token cost per message (target: <$0.005)
- Human time saved (target: >1 hour/day)

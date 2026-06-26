# IR Custom AIOS Agent Infrastructure - Implementation Status

**Date**: 2026-06-05  
**Status**: Foundation deployed, workers pending (delegated to Gio)

## Overview

Building autonomous agent employees (Outsiders) with:
- Model-agnostic architecture (OpenRouter for cheap models, Claude for complex)
- Token management (target: <$0.01/email, <$0.005/message)
- Human oversight via browser push notifications
- Knowledge integration (Weaviate) and tool access (calendar, email, WhatsApp)

## Agents

### Mercury - Email Manager (Outsider)
**Role**: Autonomous inbox management  
**Status**: Spec complete, implementation delegated to Gio  
**Capabilities**:
- Auto-draft replies (not new threads) using email history + Weaviate context
- Extract "golden nuggets" from newsletters → save to Weaviate + create tasks
- Calendar integration for scheduling
- Only surface emails requiring human decision
- Push notification for every draft (approve/modify/reject)

**Token Strategy**:
- Primary: `openrouter/google/gemini-flash-1.5` (~$0.0001/email)
- Escalate to `claude-sonnet-4-5` for complex reasoning
- Target: >70% auto-drafted, <10% human override, <$0.01/email

**Config**: `agents/mercury/AGENT.md`

### Spanky - WhatsApp Manager (Rascal)
**Client**: Kane Minkus  
**Role**: WhatsApp monitoring for Kane Minkus project (course/product collaboration with Wes and Kevin)  
**Status**: Spec complete, monitoring assigned, implementation delegated to Gio  
**Monitored**:
- Kane Minkus (`30992551153826@lid`) - Primary client
- Wes (TBD - needs first message) - Project collaborator
- Agentic Team group (`120363408082202008@g.us`) - Project channel

**Capabilities**:
- Webhook-triggered message processing
- Context-aware draft generation (Weaviate + conversation history)
- Push notification for approval before sending
- Track decisions for learning

**Token Strategy**:
- Primary: `openrouter/google/gemini-flash-1.5`
- Target: >85% approval rate, <$0.005/message

**Config**: `agents/spanky/AGENT.md`

## Database Schema

**Deployed** (migration `027_agent_infrastructure.sql`):

- `boss_agent_decisions` - Decision log for human feedback learning
- `boss_push_notifications` - Browser notifications for approvals
- `boss_agent_state` - Polling cursors, last run times
- `boss_whatsapp_monitors` - Chat → agent monitoring assignments
- `boss_email_monitors` - Email account → agent monitoring assignments

**Monitoring Assignments**:
```sql
-- Spanky monitors
boss_whatsapp_monitors:
  - Kane Minkus (30992551153826@lid) → spanky (confidence_threshold: 0.85)
  - Agentic Team (120363408082202008@g.us) → spanky (confidence_threshold: 0.90)
```

## API Endpoints

**Deployed** (`/apps/api/src/routes/agents.ts`):

- `GET /api/agents/notifications` - Fetch pending push notifications
- `POST /api/agents/notifications/:id/action` - Approve/modify/reject agent draft
- `POST /api/agents/decisions` - Agent logs a decision
- `POST /api/agents/notify` - Create push notification
- `GET /api/agents/monitors/whatsapp` - List WhatsApp monitoring assignments
- `GET/PUT /api/agents/state/:handle/:key` - Agent state management

## Tasks Delegated to Gio

Created in Kanban (priority 10, due 2026-06-07):

1. **Build Mercury email manager worker**
   - Poll `/api/services/mail` every 60s
   - Draft replies with OpenRouter
   - Extract newsletter insights to Weaviate
   - Create push notifications via `/api/agents/notify`

2. **Build Spanky WhatsApp manager worker**
   - Webhook handler for monitored chats
   - Context-aware drafting (Weaviate + history)
   - Push notifications for approval

3. **Build push notification UI component** (priority 9)
   - React component for Dashboard
   - Shows draft + context + [Approve] [Modify] [Reject]
   - Polls `/api/agents/notifications`
   - Calls `/api/agents/notifications/:id/action`

## OpenRouter Integration

**API Key**: Configured in `.env` as `OPENROUTER_API_KEY`  
**Recommended Models**:
- Primary: `google/gemini-flash-1.5` (~$0.000075/1K tokens)
- Fallback: `meta-llama/llama-3.1-8b-instruct` (~$0.00005/1K tokens)
- Escalation: `claude-sonnet-4-5` (Anthropic direct, ~$0.003/1K tokens)

**Token Management**:
- Track per-operation cost in `boss_agent_decisions.cost_usd`
- Log model used + tokens in every decision
- Alert if daily cost exceeds threshold

## Weaviate Integration

**Newsletter Insights Schema**:
```json
{
  "class": "EmailInsight",
  "properties": [
    {"name": "source", "dataType": ["string"]},
    {"name": "title", "dataType": ["string"]},
    {"name": "insight", "dataType": ["text"]},
    {"name": "actionable", "dataType": ["boolean"]},
    {"name": "category", "dataType": ["string"]},
    {"name": "extracted_at", "dataType": ["date"]},
    {"name": "implemented", "dataType": ["boolean"]}
  ]
}
```

## Success Metrics

**Mercury (Email Manager)**:
- % emails auto-drafted: target >70%
- % requiring human override: target <10%
- Newsletter insights/week: target >5 actionable
- Token cost/email: target <$0.01
- Human time saved: target >2 hrs/day

**Spanky (WhatsApp Manager)**:
- Draft approval rate: target >85%
- Avg response time: target <2 min
- Token cost/message: target <$0.005
- Human time saved: target >1 hr/day

## Next Steps

1. **Gio**: Implement three tasks above (due 2026-06-07)
2. **Kevin**: Test push notification approval flow once UI deployed
3. **Mercury**: Add email account via `/api/connectors` (Google OAuth)
4. **Weaviate**: Create `EmailInsight` class schema
5. **Add Wes**: Get first message to register chat_id, then add to Spanky monitors

## Files

- `agents/mercury/AGENT.md` - Mercury spec
- `agents/spanky/AGENT.md` - Spanky spec
- `migrations/027_agent_infrastructure.sql` - Database schema
- `apps/api/src/routes/agents.ts` - API endpoints
- `apps/api/src/routes/whatsapp.ts` - WhatsApp integration (existing)
- `apps/api/src/routes/services.ts` - Email/calendar connectors (existing)

## Notes

- **Auto-send disabled by default**: All drafts require human approval via push notification
- **Confidence threshold**: Can enable auto-send if agent confidence > threshold (currently disabled)
- **Learning loop**: Human modifications stored in `boss_agent_decisions.human_modification` for future training
- **Model selection**: Agents choose model based on complexity, cost target enforced

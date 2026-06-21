# Background Agents — What's Running Inside You

You have background agents running as part of your host-native process (boss-agent.service).
These are NOT n8n workflows. They are native Node.js intervals inside your own process.

## Email Triage Agent
- **File**: apps/api/src/agents/email-triage.ts
- **Interval**: Every 15 minutes
- **What it does**: Fetches unread inbox emails via Gmail API, classifies them (newsletter/invoice/personal/client/marketing), takes action (archive newsletters, flag client emails for attention), logs to boss_email_log table
- **Status**: Running. Check with: `SELECT COUNT(*) FROM boss_email_log`

## Telegram Bot
- **File**: apps/api/src/agents/telegram-bot.ts  
- **Interval**: Polls every 3 seconds
- **What it does**: Receives messages from paired Telegram users, routes them to your brain for processing, sends responses back
- **Pairing**: Admin auto-pairs on first /start. Other users need a pairing code.
- **Send-and-wait**: Use `boss_telegram_send_and_wait` for approval flows. The bot pushes replies to a shared queue so there's no polling conflict.

## Kevin Intelligence Agent
- **File**: apps/api/src/agents/kevin-intel.ts
- **Interval**: Every 4 hours
- **What it does**: Ingests Drive docs, email patterns, calendar behavior. Tracks response times, relationship mapping, communication styles. Saves learnings to boss_memory.
- **Status**: Running

## Persistent Agent Scheduler
- **File**: apps/api/src/agents/persistent-scheduler.ts
- **Interval**: Checks every 60 seconds
- **What it does**: Loads agents from `boss_persistent_agents` Postgres table and runs them on their cron schedules. Each agent is a mini-IR Custom AIOS with its own instructions.
- **Status**: Running
- **Tools**: Use `boss_create_persistent_agent` to create new agents, `boss_list_persistent_agents` to see them, `boss_update_persistent_agent` to change instructions/schedule/status, `boss_delete_persistent_agent` to remove them.

### Creating a Persistent Agent
```
boss_create_persistent_agent:
  name: "Email Digest Agent"
  instructions: "Check unread emails, summarize the top 5 most important, and send a digest to Kevin via Telegram."
  cron_expression: "0 8 * * *"  (daily at 8am UTC)
```

The agent lives in Postgres, survives restarts, and runs on schedule until stopped.
This is the equivalent of OpenClaw's semi-permanent agents.

## How to Build New Background Agents
1. Create the agent file in `apps/api/src/agents/`
2. Export `startXxx()` and `stopXxx()` functions
3. Import and call `startXxx()` in `apps/api/src/index.ts` after server starts
4. Import and call `stopXxx()` in the shutdown handler
5. Build and restart: `npm run build --workspace=apps/api && systemctl --user restart boss-agent`

## IMPORTANT
- These agents run inside YOUR process. When you restart, they restart.
- Do NOT use n8n for things you can handle internally. n8n is for external automation workflows for clients.
- Sub-agents spawned via boss_spawn_agent are fire-and-forget (they complete and die). Background agents are persistent (they run forever on intervals).

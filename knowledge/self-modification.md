# Self-Modification Guide

## You Are the Code
Your source code is at `/home/tcntryprd/boss-dev/`. When you edit files there, you are modifying yourself.

## Workflow: Read → Edit → Test → Build → Verify → Commit
1. **Read** the file with `boss_fs_read` BEFORE editing. Never edit blind.
2. **Edit** with `boss_self_patch` — exact string match, surgical replacement.
3. **Test** with `boss_self_test` — fix failures before building.
4. **Build** with `boss_bash`: `cd /home/tcntryprd/boss-dev && npm run build --workspace=apps/api`
5. **Restart** with `boss_bash`: `systemctl --user restart boss-agent`
6. **Verify** — check logs, test the change, confirm it works.
7. **Commit** with `boss_self_git action=commit` — always to a boss/* branch.

## Key File Locations
| What | Path |
|------|------|
| Tool handlers | apps/api/src/tools/executor.ts |
| Tool definitions | apps/api/src/tools/*.ts (one per integration) |
| Trust tiers | apps/api/src/tools/trust.ts |
| Tool registration | apps/api/src/tools/index.ts |
| System prompt | apps/api/src/prompt-cache.ts |
| Brain/chat route | apps/api/src/routes/brain.ts |
| Auth routes | apps/api/src/routes/auth.ts |
| Connector routes | apps/api/src/routes/connectors.ts |
| Telegram bot | apps/api/src/agents/telegram-bot.ts |
| Email triage | apps/api/src/agents/email-triage.ts |
| Web UI dashboard | apps/web/src/pages/Dashboard.tsx |
| Web UI sidebar | apps/web/src/components/Layout.tsx |
| Web UI login | apps/web/src/pages/Login.tsx |
| Knowledge files | knowledge/*.md |

## Never Claim Success Without Verifying
- After saving a file: `ls -la /path/to/file` to confirm it exists
- After editing code: `boss_fs_read` the file to confirm the change is there
- After building: check logs for errors
- After deploying: test the feature

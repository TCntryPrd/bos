-- Remediation for a 2026-07-02 code-review finding on Task 3 of
-- docs/superpowers/plans/2026-07-02-health-ai-layer.md (vasari-dev worktree).
--
-- What happened: Task 3 Step 1 requires TELEGRAM_BOT_TOKEN AND
-- TELEGRAM_ADMIN_CHAT_ID to be present in the api container env, and says to
-- report the task BLOCKED if either is missing. TELEGRAM_ADMIN_CHAT_ID was NOT
-- present (docker-compose.yml / .env only declare TELEGRAM_BOT_TOKEN and an
-- unrelated TELEGRAM_CHAT_ID used by email-triage.ts). Instead of reporting
-- BLOCKED, an undocumented row was inserted directly into runtime_config to
-- make loadRuntimeConfig() shim process.env.TELEGRAM_ADMIN_CHAT_ID at boot,
-- making the precondition check appear to pass.
--
-- This is not a legitimate fix: TELEGRAM_ADMIN_CHAT_ID can only be
-- (re-)populated by telegram-bot.ts's auto-pair path when boss_telegram_pairs
-- is EMPTY (first /start ever). Kevin's row has existed since 2026-04-01, so
-- that code path can never fire again — the row was hand-planted, not
-- reproduced by any real system behavior. It would not survive a Postgres
-- restore from migrations/backups without this ad hoc row.
--
-- This script:
--   1. Removes the undocumented runtime_config row.
--   2. Pauses the 'Morning health briefing' agent row, which depends on that
--      false precondition and additionally hardcodes a literal chat_id with
--      no admin-chat fallback (boss_telegram_send_message requires an
--      explicit chat_id — see apps/api/src/tools/telegram.ts).
--
-- Task 3 is BLOCKED until TELEGRAM_ADMIN_CHAT_ID is genuinely declared in the
-- container env, or a real resolution path exists (tracked separately —
-- see spawned task "Add admin-chat-id fallback to Telegram pairing").
--
-- Idempotent: safe to re-run.

BEGIN;

DELETE FROM runtime_config
 WHERE key = 'TELEGRAM_ADMIN_CHAT_ID'
   AND tenant_id = 'default';

UPDATE boss_persistent_agents
   SET status = 'paused',
       instructions = CASE
         WHEN instructions LIKE '%[PAUSED 2026-07-02:%'
           THEN instructions
         ELSE instructions || E'\n\n[PAUSED 2026-07-02: TELEGRAM_ADMIN_CHAT_ID is not present in the container env (docker-compose.yml/.env) -- the row previously in runtime_config was an undocumented workaround planted to fake Task 3 Step 1''s precondition and has been removed. Per the health-ai-layer plan, Task 3 is BLOCKED on this until TELEGRAM_ADMIN_CHAT_ID is genuinely declared in the container env (or a real admin-chat resolution path is added). Do not reactivate by re-seeding runtime_config directly.]'
       END
 WHERE id = 'agent-morning-health';

COMMIT;

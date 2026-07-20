import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { initTokenStore } from '@boss/connectors';
import { initDb } from './db.js';
import { loadRuntimeConfig } from './config-store.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { brainRoutes } from './routes/brain.js';
import { connectorRoutes } from './routes/connectors.js';
import { linkedinRoutes } from './routes/linkedin.js';
import { linkedinSystemRoutes } from './routes/linkedin-system.js';
import { unipileRoutes } from './routes/unipile.js';
import { gwAuthRoutes, ensureHermesDashboard } from './routes/gw-auth.js';
import { servicesRoutes } from './routes/services.js';
import { voiceRoutes } from './routes/voice.js';
import { healingRoutes } from './routes/healing.js';
import { builderRoutes } from './routes/builder.js';
import { learningRoutes } from './routes/learning.js';
import { backupRoutes } from './routes/backup.js';
import { settingsRoutes } from './routes/settings.js';
import { mcpRoutes } from './routes/mcp.js';
import { appsRoutes } from './routes/apps.js';
import { skillsRoutes } from './routes/skills.js';
import { emailAgentRoutes } from './routes/email-agent.js';
import { emailDraftsRoutes } from './routes/email-drafts.js';
import { sheetsRoutes } from './routes/sheets.js';
import { ttsRoutes } from './routes/tts.js';
import { calendarRoutes } from './routes/calendar.js';
import { codeRoutes } from './routes/code.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { rascalsRoutes } from './routes/rascals.js';
import { rascalWorkspaceRoutes, outsiderWorkspaceRoutes } from './routes/rascal-workspace.js';
import { memoryGatewayRoutes } from './routes/memory-gateway.js';
import { outsidersRoutes } from './routes/outsiders.js';
import { metaWebhookRoutes } from './routes/webhooks/meta.js';
import { whatsappWebhookRoutes } from './routes/webhooks/whatsapp.js';
import { quickbooksWebhookRoutes } from './routes/webhooks/quickbooks.js';
import { whatsappRoutes, startWhatsAppScheduledDispatcher } from './routes/whatsapp.js';
import { metaRoutes } from './routes/meta.js';
import { META_CREDENTIALS_DDL } from './lib/meta-graph.js';
import { slackFeedRoutes } from './routes/slack-feed.js';
import { SLACK_FEED_DDL, startSlackFeedPoller } from './lib/slack-feed.js';
import { openclawRoutes } from './routes/openclaw/index.js';
import { cooRoutes } from './routes/coo/index.js';
import { claudeAuthRoutes } from './routes/claude-auth.js';
import { hermesSetupRoutes } from './routes/hermes-setup.js';
import { zucchiRoutes } from './routes/zucchi.js';
import boardRoutes from './routes/board.js';
import roundtableRoutes from './routes/roundtable.js';
import kanbanRoutes from './routes/kanban.js';
import woRoutes from './routes/wo.js';
import { miroRoutes } from './routes/miro.js';
import { slackRoutes } from './routes/slack.js';
import agentsRoutes from './routes/agents.js';
import { revenueRoutes } from './routes/revenue.js';
import employeeAgentsRoutes from './routes/employee-agents.js';
import financeRoutes from './routes/finance.js';
import crmRoutes from './routes/crm.js';
import reviewsRoutes from './routes/reviews.js';
import opsRoutes from './routes/ops.js';
import googleAdminRoutes from './routes/google-admin.js';
import costRoutes from './routes/cost.js';
import lifeRoutes from './routes/life.js';
import approvalsRoutes from './routes/approvals.js';
import healthDataRoutes from './health/routes.js';
import { startSlackSocketMode } from './lib/slack-socket.js';
import { authMiddleware } from './middleware/auth.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { errorHandler } from './middleware/error.js';
import { verifyCodexCliInBackground } from './openclaw/codexSmoke.js';

export async function buildServer() {
  // trustProxy tells Fastify to derive request.ip from X-Forwarded-For /
  // X-Real-IP when the incoming TCP peer is a trusted reverse proxy. Without
  // this, requests arriving via the web container's nginx show up as the
  // nginx pod's docker-bridge IP (e.g. 172.22.0.8), never 127.0.0.1 — which
  // breaks BOSS_INTERNAL_TRUSTED_IPS and deploy-time smoke gates.
  // Default: the boss compose network (172.22.0.0/16). Override per-env.
  const trustProxy = process.env.BOSS_TRUSTED_PROXIES ?? '172.22.0.0/16';

  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    trustProxy,
  });

  // Security plugins
  await server.register(cors, {
    origin: process.env.CORS_ORIGIN || '*',
  });
  await server.register(helmet);

  // Treat an empty JSON body as `{}` instead of rejecting with 400
  // FST_ERR_CTP_EMPTY_JSON_BODY. Cron-fired callers routinely POST with
  // Content-Type: application/json and no body on no-input endpoints.
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      // Stash raw body so signature-verifying routes (Meta webhook, etc.)
      // can recompute HMAC. Negligible memory cost — the string is in
      // memory either way.
      (req as unknown as { rawBody: string }).rawBody = text;
      if (text.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // Global error handler
  server.setErrorHandler(errorHandler);

  // ── Database initialization ────────────────────────────────────────────────
  // Creates the shared Pool singleton used by auth routes and the token store.
  // Skipped gracefully in test environments where POSTGRES_URL is not set.
  if (process.env.POSTGRES_URL) {
    try {
      const pool = initDb(process.env.POSTGRES_URL);

      // Ensure OAuth tables exist before initializing the token store
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_oauth_tokens (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          account_id    TEXT NOT NULL,
          provider      TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
          email         TEXT NOT NULL,
          access_token  TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at    TIMESTAMPTZ NOT NULL,
          scopes        TEXT[] NOT NULL DEFAULT '{}',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider, email)
        );
        CREATE TABLE IF NOT EXISTS boss_oauth_state (
          state          TEXT PRIMARY KEY,
          provider       TEXT NOT NULL,
          services       TEXT[] NOT NULL,
          code_verifier  TEXT NOT NULL,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider_email ON boss_oauth_tokens (provider, email);
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account_id ON boss_oauth_tokens (account_id);
      `);

      // Ensure invites table exists (migration 012)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS invites (
          id          TEXT        PRIMARY KEY,
          email       TEXT        NOT NULL,
          role        TEXT        NOT NULL DEFAULT 'user'
                          CHECK (role IN ('admin', 'user')),
          status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'expired')),
          invited_by  TEXT        NOT NULL,
          tenant_id   TEXT        NOT NULL DEFAULT 'default',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
        );
        CREATE INDEX IF NOT EXISTS idx_invites_email  ON invites (email);
        CREATE INDEX IF NOT EXISTS idx_invites_status ON invites (status);
      `);

      // Ensure runtime_config table exists (migration 013)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS runtime_config (
          key        TEXT        NOT NULL,
          value      TEXT        NOT NULL,
          tenant_id  TEXT        NOT NULL DEFAULT 'default',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (key, tenant_id)
        );
      `);

      // Email agent log table (migration 014)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_email_log (
          id               TEXT        PRIMARY KEY,
          message_id       TEXT        NOT NULL,
          account_email    TEXT        NOT NULL,
          sender           TEXT        NOT NULL,
          subject          TEXT        NOT NULL,
          received_at      TIMESTAMPTZ NOT NULL,
          category         TEXT        NOT NULL CHECK (category IN ('newsletter', 'invoice', 'personal', 'client', 'marketing', 'other')),
          needs_attention  BOOLEAN     NOT NULL DEFAULT false,
          action_taken     TEXT        CHECK (action_taken IN ('archived', 'draft_created', 'auto_responded', 'forwarded_to_brain', 'compiled')),
          draft_content    TEXT,
          golden_nugget    TEXT,
          invoice_amount   DECIMAL,
          invoice_due_date DATE,
          boss_notes     TEXT,
          processed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          resolved_at      TIMESTAMPTZ,
          resolved_by      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_email_log_attention ON boss_email_log (needs_attention, processed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_email_log_category  ON boss_email_log (category);

        CREATE TABLE IF NOT EXISTS boss_memory (
          id              BIGSERIAL PRIMARY KEY,
          category        TEXT        NOT NULL DEFAULT 'fact',
          content         TEXT        NOT NULL,
          source          TEXT,
          confidence      REAL        NOT NULL DEFAULT 0.8,
          conversation_id TEXT,
          access_count    INTEGER     NOT NULL DEFAULT 0,
          last_accessed   TIMESTAMPTZ,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_boss_memory_conf ON boss_memory (confidence DESC, created_at DESC);
      `);

      // Meta connector store + event/thread tables (Facebook/IG/Threads/WhatsApp Cloud)
      await pool.query(META_CREDENTIALS_DDL);

      // Slack sales feed table (poller-populated)
      await pool.query(SLACK_FEED_DDL);

      initTokenStore(pool);
      server.log.info('Database initialized — token store and auth tables ready');

      // Load persisted runtime config (brain keys, OAuth creds) into process.env
      try {
        await loadRuntimeConfig();
        server.log.info('Runtime config loaded from Postgres');
        if (process.env.OPENAI_API_KEY) {
          void verifyCodexCliInBackground(process.env.OPENAI_API_KEY).catch((err) => {
            server.log.warn({ err }, 'Codex CLI background verification failed to start');
          });
        }
      } catch (err) {
        server.log.warn({ err }, 'Could not load runtime config — using env defaults');
      }

      // Slack Socket Mode — open WebSocket to Slack and route inbound events.
      // No-op if SLACK_APP_TOKEN is unset (graceful for dev).
      void startSlackSocketMode().catch((err) => {
        server.log.warn({ err }, 'Slack Socket Mode failed to start');
      });

      // Slack sales feed poller — captures team-reported sales from channels.
      startSlackFeedPoller(server.log);

      // WhatsApp scheduled-message dispatcher — sends due approved rows from
      // boss_whatsapp_scheduled via the WhatsApp bridge. Safe no-op when the
      // bridge is not configured (each tick re-checks env).
      startWhatsAppScheduledDispatcher(server.log);
    } catch (err) {
      server.log.error({ err }, 'Failed to initialize database');
      throw err;
    }
  } else {
    server.log.warn('POSTGRES_URL not set — database not initialized (auth persistence and OAuth will fail)');
  }

  // Middleware — applied to all routes except health
  server.addHook('onRequest', authMiddleware);
  server.addHook('onRequest', tenantMiddleware);

  // ── Routes ─────────────────────────────────────────────────────────────────

  // Infrastructure — no auth required
  await server.register(healthRoutes, { prefix: '/health' });

  // Auth — login/register skip auth; refresh/logout require a token
  await server.register(authRoutes, { prefix: '/api/auth' });

  // Brain router
  await server.register(brainRoutes, { prefix: '/api/brain' });

  // Connector OAuth and account management
  await server.register(connectorRoutes, { prefix: '/api/connectors' });
  await server.register(linkedinRoutes, { prefix: '/api/linkedin' });
  await server.register(linkedinSystemRoutes, { prefix: '/api/linkedin-system' });
  await server.register(unipileRoutes, { prefix: '/api/unipile' });
  await server.register(revenueRoutes, { prefix: '/api/revenue' });
  await server.register(employeeAgentsRoutes, { prefix: '/api/employee-agents' });
  await server.register(financeRoutes, { prefix: '/api/finance' });
  await server.register(crmRoutes, { prefix: '/api/crm' });
  await server.register(reviewsRoutes, { prefix: '/api/reviews' });
  await server.register(opsRoutes, { prefix: '/api/ops' });
  await server.register(googleAdminRoutes, { prefix: '/api/google' });
  await server.register(costRoutes, { prefix: '/api/cost' });
  await server.register(gwAuthRoutes, { prefix: '/api/gw' });

  // Unified service CRUD (mail / calendar / tasks / files)
  await server.register(servicesRoutes, { prefix: '/api/services' });

  // Voice devices and streaming
  await server.register(voiceRoutes, { prefix: '/api/voice' });

  // Self-healing engine
  await server.register(healingRoutes, { prefix: '/api/healing' });

  // Builder-mode live agent console (404s unless BOSS_BUILDER_MODE=1)
  await server.register(builderRoutes, { prefix: '/api/builder' });

  // Learning and preferences
  await server.register(learningRoutes, { prefix: '/api/learning' });

  // Backup management
  await server.register(backupRoutes, { prefix: '/api/backup' });

  // Tenant settings
  await server.register(settingsRoutes, { prefix: '/api/settings' });

  // Global MCP discovery for Codex CLI, Claude Code CLI, and Hermes.
  await server.register(mcpRoutes, { prefix: '/api/mcp' });

  // App download metadata and installation registration
  await server.register(appsRoutes, { prefix: '/api/apps' });

  // Skill system — load/enable/disable brain skills
  await server.register(skillsRoutes, { prefix: '/api/skills' });

  // Autonomous email processing agent — log, digest, attention, draft, resolve, search
  await server.register(emailAgentRoutes, { prefix: '/api/email' });
  // Email draft ratings (👍/👎 + notes) — feeds the agent's learning loop
  await server.register(emailDraftsRoutes, { prefix: '/api/email-drafts' });
  // Google Sheets read/update for outreach tracking
  await server.register(sheetsRoutes, { prefix: '/api/sheets' });
  await server.register(ttsRoutes, { prefix: '/api/tts' });

  // Calendar aggregation across Google accounts
  await server.register(calendarRoutes, { prefix: '/api/calendar' });

  // Claude Code web interface — structured JSON streaming
  await server.register(codeRoutes, { prefix: '/api/code' });

  // Pipeline Engine — task orchestration for Little Rascals
  await server.register(pipelineRoutes, { prefix: '/api' });

  // Kanban — board surface over boss_tasks (v1.7.11+)
  await server.register(kanbanRoutes, { prefix: '/api' });

  // Work Orders — time-bucket queue over boss_tasks (AIOS v2.1 section 9 #6).
  // Shares storage with the kanban so WOs render on the board with a bucket pill.
  await server.register(woRoutes, { prefix: '/api' });

  // Agents — autonomous agent notifications, decisions, monitoring
  await server.register(agentsRoutes, { prefix: '/api' });

  // Miro proxy — server-side token, browser-safe board access
  await server.register(miroRoutes, { prefix: '/api/miro' });

  // Slack proxy — outbound message/react/threads + attention queue.
  // Inbound events arrive via Socket Mode (see startSlackSocketMode below).
  await server.register(slackRoutes, { prefix: '/api/slack' });

  // Little Rascals agent registry — CRUD + import-presets
  await server.register(rascalsRoutes, { prefix: '/api' });

  // Per-rascal workspace surface — chat sessions / messages / files / agenda
  await server.register(rascalWorkspaceRoutes, { prefix: '/api' });

  // Outsiders agent registry — staff agents (Ponyboy Productions et al.)
  await server.register(outsidersRoutes, { prefix: '/api' });

  // Per-outsider workspace surface — same shape as the rascal workspace.
  await server.register(outsiderWorkspaceRoutes, { prefix: '/api' });

  // Guarded local cognitive-memory gateway. Routes declare their full
  // /api/aios/memory paths and enforce the separate edge token themselves.
  await server.register(memoryGatewayRoutes);

  // Meta Graph API webhook receiver (Facebook Pages, Instagram, WhatsApp).
  // Public route — Meta hits us as an anonymous third party; verify-token
  // (GET) and X-Hub-Signature-256 (POST) are the auth.
  await server.register(metaWebhookRoutes, { prefix: '/api/webhooks' });
  await server.register(whatsappWebhookRoutes, { prefix: '/api/webhooks' });

  // QuickBooks entity-change webhook receiver. Public route — Intuit hits
  // us as an anonymous third party; the intuit-signature HMAC is the auth.
  await server.register(quickbooksWebhookRoutes, { prefix: '/api/webhooks' });
  await server.register(whatsappRoutes, { prefix: '/api/whatsapp' });

  // Meta connector + read API (status, credential register, FB threads, events).
  await server.register(metaRoutes, { prefix: '/api/meta' });

  // Slack sales feed read API (Sales tile).
  await server.register(slackFeedRoutes, { prefix: '/api/slack-feed' });

  // Gio / OpenClaw Dashboard surface — talks to /usr/bin/openclaw via runOpenclaw.
  // Each route file under routes/openclaw/* declares its full path including
  // the /api/openclaw prefix, so we register without a prefix here.
  await server.register(openclawRoutes);

  // COO surface — multi-thread CC chat with bypass mode (v1.7.7).
  // Each route file under routes/coo/* declares paths relative to /api/coo.
  await server.register(cooRoutes, { prefix: '/api/coo' });

  // First-use Claude subscription auth terminal. Admin-only and constrained to
  // the local Claude CLI under the durable /home/boss auth mount.
  await server.register(claudeAuthRoutes, { prefix: '/api/setup' });
  await server.register(hermesSetupRoutes, { prefix: '/api/setup' });
  await server.register(zucchiRoutes, { prefix: '/api' });
  await server.register(boardRoutes, { prefix: '/api/board' });
  await server.register(roundtableRoutes, { prefix: '/api/roundtable' });
  await server.register(lifeRoutes, { prefix: '/api/life' });
  await server.register(approvalsRoutes, { prefix: '/api/approvals' });

  // Health data — Health Connect bridge ingest + tile/page reads (spec 2026-07-01).
  await server.register(healthDataRoutes, { prefix: '/api/health' });

  return server;
}

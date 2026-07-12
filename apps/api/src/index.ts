import { buildServer } from './server.js';
import { startEmailTriage, stopEmailTriage } from './agents/email-triage.js';
import { startTelegramBot, stopTelegramBot } from './agents/telegram-bot.js';
import { startKevinIntel, stopKevinIntel } from './agents/kevin-intel.js';
import { startScheduler, stopScheduler } from './agents/persistent-scheduler.js';
import { startHealthAlertConsumer, stopHealthAlertConsumer } from './health/consumer.js';
import { startHealthMonitor, stopHealthMonitor } from './health/monitor.js';
import { autoStartBrainSession } from './brain/cli-adapter.js';
import { ensureHermesDashboard } from './routes/gw-auth.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const server = await buildServer();

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`BOS v2 API running on ${HOST}:${PORT}`);
    try { ensureHermesDashboard(); } catch { /* best-effort */ }

    // Start the CLI brain session (tmux) — BOS's primary brain
    if (process.env.BOSS_BACKGROUND_AGENTS !== 'off') autoStartBrainSession();

    // Start background agents after server is ready
    // startEmailTriage(); // DISABLED — Kevin's order 2026-04-10. Re-enable after review.
    if (process.env.BOSS_BACKGROUND_AGENTS === 'off') {
      server.log.warn('Background agents DISABLED (BOSS_BACKGROUND_AGENTS=off) — isolated/parallel-run mode');
      // Targeted opt-in: run ONLY the persistent-agent scheduler (Employee Agents)
      // without starting the telegram/kevin-intel background agents.
      if (process.env.BOSS_SCHEDULER === 'on') {
        server.log.warn('BOSS_SCHEDULER=on — starting persistent-agent scheduler only (Employee Agents)');
        startScheduler();
      }
    } else {
      void startTelegramBot();
      startKevinIntel();
      startScheduler();
    }

    // Health threshold alerts run in BOTH modes (owner-authorized, outbound-only,
    // self-guarded by REDIS_URL / HEALTH_ALERTS_ENABLED) — unlike the polling
    // bot/intel agents that isolated mode deliberately suppresses.
    startHealthAlertConsumer();
    startHealthMonitor();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    stopEmailTriage();
    stopTelegramBot();
    stopKevinIntel();
    stopScheduler();
    stopHealthAlertConsumer();
    stopHealthMonitor();
    void server.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();

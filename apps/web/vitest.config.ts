import { defineConfig } from 'vitest/config';

/**
 * Package-local vitest config for apps/web.
 *
 * Why this exists: the root vitest.config.ts already picks up
 * apps/web/src/**\/*.test.ts via its include globs, so this file is NOT
 * needed for test discovery. It exists solely to work around an
 * environment issue in this host: Vite's config resolution calls
 * loadEnv() against `root`, and the monorepo root's `.env` file is
 * root-owned/0600 and unreadable by the app user running these tests,
 * which crashes `vitest run` before any test executes (repro'd against
 * pre-existing tests too, e.g. apps/api/src/health/rollup.test.ts run
 * from the repo root — not something introduced by this change).
 * Setting envDir to this directory (which has no .env of its own) avoids
 * that read entirely. This file is new and does not alter the shared
 * root config; run scoped to apps/web with `--config apps/web/vitest.config.ts`.
 */
export default defineConfig({
  envDir: import.meta.dirname,
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 10000,
  },
});

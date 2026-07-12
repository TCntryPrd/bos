-- =============================================================================
-- IR Custom AIOS v2 — Migration 011: Initial Self-Healing Playbooks
-- Seed data for playbooks table.
-- These entries are derived from real failures encountered during v2 installation.
-- All playbooks are global (tenant_id = NULL) and active by default.
-- =============================================================================

INSERT INTO playbooks (
    id,
    tenant_id,
    failure_signature,
    service,
    severity,
    diagnosis_steps,
    fix_steps,
    verification,
    success_count,
    failure_count,
    is_active,
    notes
) VALUES

-- ---------------------------------------------------------------------------
-- 1. Token Store Not Initialized
-- The connectors package token store must be explicitly initialized at API
-- startup. If initTokenStore() is never called, all OAuth operations fail
-- immediately with this message.
-- ---------------------------------------------------------------------------
(
    uuid_generate_v4(),
    NULL,
    'Token store not initialized',
    'api',
    'high',
    '[
        "Confirm that initTokenStore() is called in server.ts before routes are registered",
        "Verify POSTGRES_URL environment variable is set and non-empty in the API container",
        "Verify BOSS_TOKEN_ENCRYPTION_KEY environment variable is set in the API container",
        "Check that the Postgres container is healthy and reachable from the API container at POSTGRES_URL",
        "Review API container startup logs for any error thrown during initTokenStore() execution"
    ]'::jsonb,
    '[
        "Restart the API container: docker restart boss_api",
        "If the error persists after restart, exec into the API container and confirm env vars are present: docker exec boss_api env | grep -E ''POSTGRES_URL|BOSS_TOKEN''",
        "If env vars are missing, verify .env file is present and bound into the container via docker-compose.yml",
        "Confirm Postgres is reachable: docker exec boss_api nc -zv postgres 5432",
        "If Postgres is unreachable, restart the Postgres container and then restart the API container"
    ]'::jsonb,
    'curl -s localhost:8001/api/connectors/oauth/google/start -X POST -H ''Content-Type: application/json'' -d ''{"services":["mail"]}'' | grep -v ''Token store''',
    0,
    0,
    true,
    'First encountered during v2 installation. Root cause was missing initTokenStore() call in server.ts before route registration. Postgres connectivity is a secondary cause — confirm env vars first.'
),

-- ---------------------------------------------------------------------------
-- 2. STT Container Unhealthy (wget vs Python urllib)
-- The STT container is Python-based. Alpine wget is not available.
-- Docker health checks using wget will always fail. Must use python urllib.
-- ---------------------------------------------------------------------------
(
    uuid_generate_v4(),
    NULL,
    'container boss_stt is unhealthy',
    'stt',
    'medium',
    '[
        "Inspect the STT container health check configuration: docker inspect boss_stt --format ''{{json .Config.Healthcheck}}''",
        "Check whether the healthcheck command uses wget — wget is not available in Python-based containers",
        "Review recent health check failures: docker inspect boss_stt --format ''{{json .State.Health}}''",
        "Confirm the STT service itself is actually running: docker exec boss_stt curl -s http://localhost:8000/docs | head -5"
    ]'::jsonb,
    '[
        "Update the STT service healthcheck in docker-compose.yml to use Python urllib instead of wget",
        "Replace any wget-based healthcheck with: python -c \"import urllib.request; urllib.request.urlopen(''http://localhost:8000/docs'')\"",
        "Recreate the STT container to apply the updated healthcheck: docker compose up -d --force-recreate stt",
        "Wait for the health check interval to pass and confirm status: docker inspect boss_stt --format ''{{.State.Health.Status}}''"
    ]'::jsonb,
    'docker inspect boss_stt --format=''{{.State.Health.Status}}''',
    0,
    0,
    true,
    'Encountered during v2 installation. Python containers do not ship wget. The healthcheck silently fails, marking the container unhealthy even though the STT service is responding correctly. Fix is entirely in docker-compose.yml — no application code change needed.'
),

-- ---------------------------------------------------------------------------
-- 3. API Container Unhealthy (localhost vs 0.0.0.0 binding)
-- Fastify binds to 0.0.0.0 inside the container. Docker healthchecks using
-- localhost can fail depending on container networking configuration while
-- 0.0.0.0 resolves correctly.
-- ---------------------------------------------------------------------------
(
    uuid_generate_v4(),
    NULL,
    'container boss_api is unhealthy',
    'api',
    'high',
    '[
        "Inspect the API container health check configuration: docker inspect boss_api --format ''{{json .Config.Healthcheck}}''",
        "Check whether the healthcheck command targets localhost — Fastify may bind to 0.0.0.0, making localhost unreachable in some network configurations",
        "Verify the API process is actually running and responding: docker exec boss_api wget -qO- http://0.0.0.0:8001/health",
        "Review recent health check output: docker inspect boss_api --format ''{{json .State.Health}}''",
        "Check API startup logs for the bound address: docker logs boss_api 2>&1 | grep -i ''listen\|bind\|started''"
    ]'::jsonb,
    '[
        "Update the API healthcheck in docker-compose.yml to target 0.0.0.0 instead of localhost",
        "Change healthcheck test to: wget -qO- http://0.0.0.0:8001/health",
        "Recreate the API container to apply the updated healthcheck: docker compose up -d --force-recreate api",
        "Wait for the health check interval and confirm status: docker inspect boss_api --format ''{{.State.Health.Status}}''"
    ]'::jsonb,
    'docker inspect boss_api --format=''{{.State.Health.Status}}''',
    0,
    0,
    true,
    'Encountered during v2 installation. Fastify server binds to 0.0.0.0:8001 but the Docker healthcheck was targeting localhost. In certain Docker networking configurations localhost does not resolve to 0.0.0.0 inside the container. Fix is in docker-compose.yml healthcheck target address only.'
),

-- ---------------------------------------------------------------------------
-- 4. Postgres User Missing (n8n database)
-- The Starr_and_Partners user in n8n-postgres is not in the init scripts and
-- is lost when the container is recreated. Causes auth failures for any
-- workflow querying the claude schema.
-- ---------------------------------------------------------------------------
(
    uuid_generate_v4(),
    NULL,
    'password authentication failed for user',
    'postgres',
    'critical',
    '[
        "Identify which database and user is failing: check the full error message for the user and database name",
        "List users currently present in the target Postgres instance: docker exec n8n-postgres-1 psql -U n8n -d n8n -c ''\du''",
        "Check whether the Starr_and_Partners user exists — it is not in the init scripts and is dropped on container recreation",
        "Verify the claude schema exists: docker exec n8n-postgres-1 psql -U n8n -d n8n -c ''\dn''",
        "Confirm the container was recently recreated by checking its creation time: docker inspect n8n-postgres-1 --format ''{{.Created}}''"
    ]'::jsonb,
    '[
        "Recreate the Starr_and_Partners user with the correct password: docker exec n8n-postgres-1 psql -U n8n -d n8n -c \"CREATE USER \\\"Starr_and_Partners\\\" WITH PASSWORD ''A.Outl@w2026!';\"",
        "Grant USAGE on the claude schema: docker exec n8n-postgres-1 psql -U n8n -d n8n -c \"GRANT USAGE ON SCHEMA claude TO \\\"Starr_and_Partners\\\";\"",
        "Grant DML permissions on all tables in the claude schema: docker exec n8n-postgres-1 psql -U n8n -d n8n -c \"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA claude TO \\\"Starr_and_Partners\\\";\"",
        "Add a DEFAULT PRIVILEGES grant so future tables are also accessible: docker exec n8n-postgres-1 psql -U n8n -d n8n -c \"ALTER DEFAULT PRIVILEGES IN SCHEMA claude GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \\\"Starr_and_Partners\\\";\"",
        "Long-term fix: add the CREATE USER and GRANT statements to the n8n-postgres init scripts so they survive container recreation"
    ]'::jsonb,
    'PGPASSWORD=''A.Outl@w2026!'' psql -U Starr_and_Partners -h localhost -d n8n -c ''SELECT 1''',
    0,
    0,
    true,
    'Encountered during v2 installation. The Starr_and_Partners user is created manually and is not persisted in Postgres init scripts. Any container recreation (upgrade, hardware move, compose down/up) drops the user. Permanent fix requires adding the user to the init scripts or a post-start hook.'
),

-- ---------------------------------------------------------------------------
-- 5. Web Assets 404 via Reverse Proxy
-- Vite builds with absolute asset paths (/) by default. When the app is
-- served under a sub-path like /boss/ui/, all asset URLs are wrong.
-- ---------------------------------------------------------------------------
(
    uuid_generate_v4(),
    NULL,
    'blank screen|assets.*404',
    'web',
    'high',
    '[
        "Open browser devtools and check the Network tab — look for 404 errors on JS/CSS files under /assets/",
        "Inspect the built index.html to confirm whether asset paths use absolute (/assets/) or relative (./assets/) references",
        "Check apps/web/vite.config.ts for a ''base'' setting — if absent or set to ''/'' the build will use absolute paths",
        "Confirm the reverse proxy path the app is served under — if it is not /, absolute asset paths will break",
        "Check the Nginx/Caddy/Tailscale proxy config to verify the sub-path the web container is mounted at"
    ]'::jsonb,
    '[
        "Set base: ''./'' in apps/web/vite.config.ts to force relative asset paths in the build output",
        "Rebuild the web container: docker compose build web && docker compose up -d web",
        "Verify the rebuilt index.html uses relative paths: docker exec boss_web cat /usr/share/nginx/html/index.html | grep assets",
        "If a hard rebuild is needed: docker compose down web && docker compose up -d --build web",
        "Clear browser cache before verifying — browsers aggressively cache 404 responses for assets"
    ]'::jsonb,
    'curl -s https://last-castle.daggertooth-larch.ts.net/boss/ui/ | grep ''src="./assets''',
    0,
    0,
    true,
    'Encountered during v2 installation. Vite default base is / which generates absolute asset paths. When served behind a reverse proxy at /boss/ui/ the browser requests /assets/... which the proxy cannot match. Setting base: ''./'' in vite.config.ts fixes the build output. No runtime config change needed.'
),

-- ---------------------------------------------------------------------------
-- 6. OAuth State Store Failure
-- The connectors package requires explicit initialization. If initTokenStore()
-- is not called before routes are registered, all OAuth flow entry points fail
-- when attempting to write the state token to Postgres.
-- ---------------------------------------------------------------------------
(
    uuid_generate_v4(),
    NULL,
    'Failed to store OAuth state',
    'api',
    'high',
    '[
        "Confirm initTokenStore() is present in server.ts and is called before any route registration",
        "Verify POSTGRES_URL is set and points to the correct Postgres instance: docker exec boss_api env | grep POSTGRES_URL",
        "Verify BOSS_TOKEN_ENCRYPTION_KEY is set: docker exec boss_api env | grep BOSS_TOKEN_ENCRYPTION_KEY",
        "Check the API logs at the time of the failure for any initialization error: docker logs boss_api 2>&1 | grep -i ''token store\|initToken\|encryption''",
        "Confirm the oauth_states table exists in the target database: psql $POSTGRES_URL -c ''\dt oauth_states'' (or equivalent)"
    ]'::jsonb,
    '[
        "Ensure server.ts calls initTokenStore({ postgresUrl: process.env.POSTGRES_URL, encryptionKey: process.env.BOSS_TOKEN_ENCRYPTION_KEY }) before registering connector routes",
        "Restart the API container after confirming the code change: docker restart boss_api",
        "Tail API logs to confirm initialization completes without error: docker logs -f boss_api 2>&1 | grep -i ''token\|ready\|started''",
        "If the oauth_states table is missing, re-run the connectors migration against the Postgres instance"
    ]'::jsonb,
    'curl -s localhost:8005/api/connectors/oauth/google/start -X POST -H ''Content-Type: application/json'' -d ''{"services":["mail"]}'' | grep url',
    0,
    0,
    true,
    'Encountered during v2 installation. Closely related to the Token Store Not Initialized playbook but the trigger is specifically during OAuth flow initiation rather than general token operations. Both root causes are the same: missing initTokenStore() call or bad env vars. The different failure_signature allows the matcher to route to the most specific playbook.'
);

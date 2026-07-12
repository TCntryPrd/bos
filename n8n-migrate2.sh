#!/usr/bin/env bash
# Clean n8n migration: custom-format pg_restore (robust) + version-pinned n8n.
set -uo pipefail
BOX=tcntryprd@100.78.24.32; SSHO='-o StrictHostKeyChecking=accept-new'
PASS=$(grep -E '^POSTGRES_PASSWORD=' ~/boss-dev/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d '[:space:]')
KEY=$(python3 -c "import json;print(json.load(open('/tmp/n8n_config.json'))['encryptionKey'])")

echo '1. fresh n8n DB'
docker rm -f boss_n8n 2>/dev/null || true
docker exec boss_postgres psql -U boss -d boss_db -c 'DROP DATABASE IF EXISTS n8n' >/dev/null 2>&1
docker exec boss_postgres psql -U boss -d boss_db -c 'CREATE DATABASE n8n' >/dev/null 2>&1

echo '2. dump (custom fmt) + restore'
ssh $SSHO $BOX 'docker exec n8n-postgres-1 pg_dump -U n8n -d n8n -Fc --no-owner' > /tmp/n8n.dump
echo "   dump bytes=$(wc -c </tmp/n8n.dump)"
docker exec -i boss_postgres pg_restore -U boss -d n8n --no-owner 2>&1 < /tmp/n8n.dump | grep -iE 'error' | grep -vi 'vector' | head -4 || true

echo '3. verify + isolate'
docker exec boss_postgres psql -U boss -d n8n -tAc "SELECT 'migrations='||(SELECT count(*) FROM migrations)||' workflows='||(SELECT count(*) FROM workflow_entity)||' creds='||(SELECT count(*) FROM credentials_entity)"
docker exec boss_postgres psql -U boss -d n8n -c 'UPDATE workflow_entity SET active=false' 2>&1 | tail -1

echo '4. run n8n PINNED 2.10.4'
NET=$(docker network ls --format '{{.Name}}' | grep -iE 'boss' | head -1)
docker run -d --name boss_n8n --restart unless-stopped --network "$NET" \
  -e DB_TYPE=postgresdb -e DB_POSTGRESDB_HOST=postgres -e DB_POSTGRESDB_PORT=5432 \
  -e DB_POSTGRESDB_DATABASE=n8n -e DB_POSTGRESDB_USER=boss -e DB_POSTGRESDB_PASSWORD="$PASS" \
  -e N8N_ENCRYPTION_KEY="$KEY" -e N8N_PORT=5678 -e GENERIC_TIMEZONE=America/Chicago \
  -e WEBHOOK_URL=https://boss-vps.daggertooth-larch.ts.net/n8n/ -e N8N_SECURE_COOKIE=false \
  -p 127.0.0.1:5679:5678 n8nio/n8n:2.10.4 >/dev/null && echo '   started 2.10.4'
sleep 14
docker ps --filter name=boss_n8n --format '   {{.Names}} {{.Status}}'
docker logs boss_n8n 2>&1 | grep -iE 'ready|editor is now|Version control|error|migration' | tail -4
curl -s -o /dev/null -w '   n8n /healthz: %{http_code}\n' -m 10 localhost:5679/healthz

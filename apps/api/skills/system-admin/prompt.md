## Skill: System Admin

When working with servers, infrastructure, and services:
- The primary server is last-castle (Ubuntu 24.04, 30GB RAM, Tailscale: last-castle.daggertooth-larch.ts.net)
- Running services to be aware of: BOS API (port 3000), Postgres (port 5432), Redis (port 6379), Weaviate (port 8080), n8n (port 5678), OpenClaw (port 64837), STT/faster-whisper (port 10300)
- When diagnosing an issue, follow this order: check service status, check recent logs, check resource usage (CPU/mem/disk), check network connectivity
- Docker containers: always check `docker ps` first, then logs with `docker logs --tail 100 <name>`
- For Postgres issues: check connections with `pg_stat_activity`, look for long-running queries, check disk space
- For high CPU: identify the process with `top` or `htop`, then determine if it is a spike or sustained
- When a service is down, restart it and monitor for 2 minutes before declaring it recovered
- Log analysis: surface ERROR and WARN level entries first, then look for patterns in the surrounding context
- For deployment issues: always check the last 3 commits, the build log, and the service restart log
- n8n workflows: if a workflow fails, check the execution log in the n8n UI or via API before attempting a fix
- Redis: if cache issues arise, check memory usage and eviction policy before flushing
- Always confirm before running destructive commands (DROP, DELETE, docker rm, rm -rf)
- Prefer reversible actions — snapshot before major changes when possible

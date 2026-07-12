# IR Custom AIOS - IR White-Label

Industry Rockstarr white-label deployment of IR Custom AIOS.

## Quick Start

```bash
# 1. Configure environment
cp .env.example .env
nano .env  # Add your credentials

# 2. Generate encryption keys
echo "BOSS_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env

# 3. Start services
docker compose up -d

# 4. Visit installation page
# https://ircustomdashboards.tech/install
```

## Services

- **Web**: React frontend (IR themed)
- **API**: Fastify backend
- **Postgres**: PostgreSQL 16 database
- **Redis**: Cache and streams
- **Weaviate**: Vector database
- **STT**: Speech-to-text (faster-whisper)
- **TTS**: Text-to-speech (edge-tts)
- **OpenWA**: WhatsApp integration
- **Worker**: Background job processor

## Updates

Pull updates from main IR Custom AIOS:

```bash
git pull upstream main
docker compose build
docker compose up -d
```

## First Install

1. Visit `/install` page
2. Create your account
3. Complete onboarding wizard
4. Connect services (Gmail, Calendar, WhatsApp)
5. Enable agents

---

**Deployment**: ircustomdashboards.tech  
**Mode**: Multi-tenant  
**Theme**: Light, joyful, energetic

# BOS — install a new box

One BOS per customer: their own VPS, their own domain, their own API keys.
Nothing of the operator's (Kevin's) credentials ever touches a customer box.

## Requirements
- Fresh Ubuntu 22.04+ VPS (4GB+ RAM recommended; 8GB for comfort)
- Docker + compose plugin (`curl -fsSL https://get.docker.com | sh`), git
- A domain/subdomain with DNS A-record pointed at the VPS

## Install
```
tar xzf bos-release-<version>.tar.gz && cd bos-release
DOMAIN=client.example.com OPERATOR_NAME="Jane Smith" ./deploy/install-bos.sh
```
Optional env: `ACME_EMAIL` (Let's Encrypt contact), `INSTALL_DIR` (default /docker/bos).

The installer: generates unique secrets into `.env`, routes the domain through
Traefik (auto-TLS), applies the database schema + default tenant, builds and
starts the stack, installs the Hermes Agent into the persistent `hermes-home`
mount (python pinned inside the mount — REQUIRED or it dies on container
recreate), writes the operator-personalized Hermes briefing, creates Hermes's
code sandbox (a clone — agents never write the live tree), and applies the
UFW + fail2ban baseline.

## Invite the owner
```
./deploy/stage-invite.sh owner@email.com
```
Prints the passkey + setup link. Email it. The owner's flow:
Setup (passkey, password, their Gemini key) → first login (their OpenAI key,
Claude subscription sign-in) → one-click Hermes activation → live.

## Hardening NOT done automatically
Key-only SSH is left to the operator (lockout risk on an automated script).
Follow the dead-man's-switch pattern in the vps-hardening playbook:
arm an auto-revert, apply `PasswordAuthentication no`, prove a fresh key
login works, then disarm.

## Verify after install
- `docker compose ps` — all Up/healthy
- From an EXTERNAL host: only 22/80/443 reachable (provider edge firewalls
  lie — always test from outside)
- Ask the orb "who are you?" → must answer as BOS
- `deploy/stage-invite.sh test@example.com`, register, confirm the
  first-login wizard fires, then delete the test user

## Factory reset (re-run a customer's setup fresh)
See the factory-reset section in the operator playbook: clear the
runtime_config key rows + truncate user/chat tables + wipe claude-home/
claude.json + force-recreate. Hermes briefing and sandbox survive resets.

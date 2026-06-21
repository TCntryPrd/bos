# BOS — Business Operating System

Industry Rockstar's Business Operating System. One‑command install on any Docker host.

## Install

```bash
git clone https://github.com/TCntryPrd/bos.git
cd bos
bash deploy/install.sh
```

The installer:
- **Detects Traefik** → serves over HTTPS through it (asks for your domain); otherwise launches the web UI directly on a port.
- **Applies the complete schema on every boot** (idempotent reconcile init‑service) — never "missing tables", repairs partial installs, and **verifies the table count, failing loudly** if anything's short.
- Seeds the Employee Agents.

Brain runs on Gemini out of the box; run `bash deploy/claude-login.sh` to upgrade to Claude.

## Update an existing install

```bash
cd bos && git pull && docker compose build && docker compose up -d
```
The schema reconciles automatically on `up` — no manual migration.
